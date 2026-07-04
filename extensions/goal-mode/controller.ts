/**
 * @module goal-mode/controller
 * Goal loop controller. One interface, all side effects.
 */

import type {
	AgentEndEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { accountGoalUsage, cloneState, completionReport, createEmptyState, createGoal, GOAL_STATE_ENTRY, latestPersistedState, maybeApplyBudgetLimit, remainingTokens, validateTokenBudget } from "./state.ts";
import { GOAL_CONTEXT_TYPES, renderActivePrompt, renderBudgetLimitPrompt, renderContinuationPrompt, renderDetails } from "./prompts.ts";
import type { GoalModeState, GoalRecord, GoalStartOptions } from "./types.ts";

const CONTINUATION_DELAY_MS = 800;
const MANAGED_TOOLS = new Set(["goal"]);

export class GoalModeController {
	#state: GoalModeState = createEmptyState();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#turnHadToolCalls = false;
	#continuationInFlight = false;

	constructor(private readonly pi: ExtensionAPI) {}

	get state(): GoalModeState {
		return cloneState(this.#state);
	}

	get goal(): GoalRecord | null {
		return this.#state.goal ? { ...this.#state.goal } : null;
	}

	async start(ctx: ExtensionContext, options: GoalStartOptions): Promise<void> {
		const existing = this.#state.goal;
		if (existing && existing.status !== "complete" && existing.status !== "dropped" && !options.replace) {
			throw new Error("Goal already exists. Use /goal set or /goal drop.");
		}
		this.#state = {
			version: 1,
			goal: createGoal(options.objective, options.tokenBudget),
			enabled: true,
			autoChild: options.autoChild ?? this.#state.autoChild,
			previousTools: this.#state.previousTools ?? this.pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name)),
		};
		this.#enableTools(ctx);
		this.#persist();
		this.#updateUi(ctx);
		this.pi.sendUserMessage(options.objective, { deliverAs: "followUp" });
	}

	async replace(ctx: ExtensionContext, objective: string): Promise<void> {
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		this.#state.goal = createGoal(objective, this.#state.goal?.tokenBudget);
		this.#state.enabled = true;
		this.#state.budgetNoticeSent = false;
		this.#state.suppressNextContinuation = false;
		this.#enableTools(ctx);
		this.#persist();
		this.#updateUi(ctx);
		this.pi.sendUserMessage(objective, { deliverAs: "followUp" });
	}

	pause(ctx: ExtensionContext): void {
		const goal = this.#requireGoal();
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		if (goal.status === "active" || goal.status === "budget-limited") this.#state.goal!.status = "paused";
		this.#state.goal!.activeSince = undefined;
		this.#state.enabled = false;
		this.#cancelContinuation();
		this.#restoreTools();
		this.#persist();
		this.#updateUi(ctx);
	}

	resume(ctx: ExtensionContext): void {
		const goal = this.#requireGoal();
		if (goal.status === "complete") throw new Error("Goal already complete.");
		if (goal.status === "dropped") throw new Error("Goal was dropped.");
		goal.status = "active";
		goal.activeSince = Date.now();
		goal.updatedAt = Date.now();
		this.#state.goal = goal;
		this.#state.enabled = true;
		this.#state.budgetNoticeSent = false;
		this.#state.suppressNextContinuation = false;
		this.#enableTools(ctx);
		this.#persist();
		this.#updateUi(ctx);
		this.#scheduleContinuation(ctx);
	}

	drop(ctx: ExtensionContext): GoalRecord | null {
		if (!this.#state.goal) return null;
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		const dropped = { ...this.#state.goal!, status: "dropped" as const, updatedAt: Date.now(), activeSince: undefined };
		this.#state.goal = dropped;
		this.#state.enabled = false;
		this.#cancelContinuation();
		this.#restoreTools();
		this.#persist();
		this.#state = createEmptyState();
		this.#persist();
		this.#updateUi(ctx);
		return dropped;
	}

	complete(ctx: ExtensionContext): GoalRecord {
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		const goal = this.#requireGoal();
		if (goal.status === "dropped") throw new Error("Cannot complete dropped goal.");
		goal.status = "complete";
		goal.completedAt = Date.now();
		goal.updatedAt = Date.now();
		goal.activeSince = undefined;
		this.#state.goal = goal;
		this.#state.enabled = false;
		this.#cancelContinuation();
		this.#restoreTools();
		this.#persist();
		this.pi.sendMessage(
			{ customType: "goal-completed", content: completionReport(goal), display: true, details: { goal } },
			{ triggerTurn: false },
		);
		this.#updateUi(ctx);
		return { ...goal };
	}

	setBudget(ctx: ExtensionContext, tokenBudget: number | undefined): void {
		validateTokenBudget(tokenBudget);
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		const goal = this.#requireGoal();
		goal.tokenBudget = tokenBudget;
		goal.updatedAt = Date.now();
		if (goal.status === "budget-limited" && (tokenBudget === undefined || goal.tokensUsed < tokenBudget)) {
			goal.status = "active";
			goal.activeSince = Date.now();
			this.#state.enabled = true;
			this.#state.budgetNoticeSent = false;
		}
		this.#state.goal = goal;
		this.#state = maybeApplyBudgetLimit(this.#state);
		this.#persist();
		this.#updateUi(ctx);
	}

	setAutoChild(ctx: ExtensionContext, enabled: boolean): void {
		this.#state.autoChild = enabled;
		if (this.#state.enabled) this.#enableTools(ctx);
		this.#persist();
		this.#updateUi(ctx);
	}

	showDetails(ctx: ExtensionContext): void {
		const state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		if (!state.goal) {
			ctx.ui.notify("No goal set.", "info");
			return;
		}
		ctx.ui.notify(renderDetails(state.goal, state.autoChild), "info");
	}

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.#cancelContinuation();
		this.#state = latestPersistedState(ctx.sessionManager.getBranch()) ?? createEmptyState();
		if (this.#state.goal?.status === "active" && event.reason !== "reload") {
			this.#state.goal.status = "paused";
			this.#state.goal.activeSince = undefined;
			this.#state.enabled = false;
			this.#persist();
		}
		if (this.#state.enabled) this.#enableTools(ctx);
		this.#updateUi(ctx);
	}

	onSessionShutdown(ctx: ExtensionContext): void {
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		this.#cancelContinuation();
		this.#persist();
	}

	onAgentStart(): void {
		this.#turnHadToolCalls = false;
		this.#cancelContinuation();
	}

	onToolExecutionStart(toolName: string): void {
		if (toolName !== "goal") this.#turnHadToolCalls = true;
	}

	onBeforeAgentStart(): BeforeAgentStartEventResult | undefined {
		const goal = this.#state.goal;
		if (!goal || !this.#state.enabled || goal.status !== "active") return undefined;
		return {
			message: {
				customType: "goal-mode-context",
				content: renderActivePrompt(goal, this.#state.autoChild, this.#hasSubagent()),
				display: false,
			},
		};
	}

	onContext(event: ContextEvent): ContextEventResult | undefined {
		let lastGoalContext = -1;
		for (let index = 0; index < event.messages.length; index++) {
			if (isGoalContextMessage(event.messages[index])) lastGoalContext = index;
		}
		if (lastGoalContext < 0) return undefined;
		const keepLatest = this.#state.goal && (this.#state.enabled || this.#state.goal.status === "budget-limited");
		return {
			messages: event.messages.filter((message, index) => !isGoalContextMessage(message) || (keepLatest && index === lastGoalContext)),
		};
	}

	onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
		this.#state = accountGoalUsage(this.#state, ctx.sessionManager.getBranch());
		if (this.#continuationInFlight) {
			this.#state.suppressNextContinuation = !this.#turnHadToolCalls;
			this.#continuationInFlight = false;
		} else if (event.messages.length > 0) {
			this.#state.suppressNextContinuation = false;
		}
		const beforeBudget = this.#state.goal?.status;
		this.#state = maybeApplyBudgetLimit(this.#state);
		if (beforeBudget === "active" && this.#state.goal?.status === "budget-limited" && !this.#state.budgetNoticeSent) {
			this.#state.budgetNoticeSent = true;
			this.#persist();
			this.#updateUi(ctx);
			this.pi.sendMessage(
				{ customType: "goal-budget-limit", content: renderBudgetLimitPrompt(this.#state.goal), display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}
		this.#persist();
		this.#updateUi(ctx);
		this.#scheduleContinuation(ctx);
	}

	#scheduleContinuation(ctx: ExtensionContext): void {
		this.#cancelContinuation();
		const goal = this.#state.goal;
		if (!goal || !this.#state.enabled || goal.status !== "active") return;
		if (this.#state.suppressNextContinuation) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const editorText = typeof ctx.ui.getEditorText === "function" ? ctx.ui.getEditorText().trim() : "";
		if (editorText.length > 0) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const latest = this.#state.goal;
			if (!latest || !this.#state.enabled || latest.status !== "active") return;
			this.#continuationInFlight = true;
			this.pi.sendMessage(
				{
					customType: "goal-continuation",
					content: renderContinuationPrompt(latest, this.#state.autoChild, this.#hasSubagent()),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}, CONTINUATION_DELAY_MS);
	}

	#cancelContinuation(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#enableTools(ctx: ExtensionContext): void {
		if (!this.#state.previousTools) this.#state.previousTools = this.pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name));
		const next = new Set(this.#state.previousTools);
		next.add("goal");
		if (this.#state.autoChild && this.#hasSubagent()) next.add("subagent");
		this.pi.setActiveTools([...next]);
		if (this.#state.autoChild && !this.#hasSubagent() && ctx.hasUI) {
			ctx.ui.notify("Goal auto-child enabled, but subagent tool is not loaded.", "warning");
		}
	}

	#restoreTools(): void {
		if (this.#state.previousTools) this.pi.setActiveTools(this.#state.previousTools);
		this.#state.previousTools = undefined;
	}

	#hasSubagent(): boolean {
		return this.pi.getAllTools().some((tool) => tool.name === "subagent");
	}

	#persist(): void {
		this.pi.appendEntry(GOAL_STATE_ENTRY, cloneState(this.#state));
	}

	#updateUi(ctx: ExtensionContext): void {
		const goal = this.#state.goal;
		if (!goal || goal.status === "dropped") {
			ctx.ui.setStatus("goal-mode", undefined);
			ctx.ui.setWidget("goal-mode", undefined);
			return;
		}
		const budget = goal.tokenBudget === undefined
			? goal.tokensUsed.toLocaleString()
			: `${goal.tokensUsed.toLocaleString()}/${goal.tokenBudget.toLocaleString()}`;
		const icon = goal.status === "complete" ? "✓" : goal.status === "paused" ? "⏸" : goal.status === "budget-limited" ? "⚠" : "🎯";
		ctx.ui.setStatus("goal-mode", `${icon} ${budget}`);
		const summary = goal.objective.length > 96 ? `${goal.objective.slice(0, 95)}…` : goal.objective;
		ctx.ui.setWidget("goal-mode", [`${icon} Goal: ${summary}`, `Status: ${goal.status} · Child: ${this.#state.autoChild ? "auto" : "off"}`]);
	}

	#requireGoal(): GoalRecord {
		if (!this.#state.goal) throw new Error("No goal set.");
		return { ...this.#state.goal };
	}
}

function isGoalContextMessage(message: unknown): boolean {
	const record = message as { role?: string; customType?: string };
	return record.role === "custom" && typeof record.customType === "string" && GOAL_CONTEXT_TYPES.has(record.customType);
}

export function goalResponse(goal: GoalRecord | null, autoChild: boolean) {
	return { goal, remainingTokens: remainingTokens(goal), autoChild };
}
