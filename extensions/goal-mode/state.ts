/**
 * @module goal-mode/state
 * Goal state restore, accounting, validation.
 */

import type { GoalModeState, GoalRecord } from "./types.ts";

export const GOAL_STATE_ENTRY = "goal-mode-state";

export function createEmptyState(): GoalModeState {
	return { version: 1, goal: null, enabled: false, autoChild: true };
}

export function createGoal(objective: string, tokenBudget: number | undefined, now = Date.now()): GoalRecord {
	const trimmed = objective.trim();
	if (!trimmed) throw new Error("Goal objective required.");
	validateTokenBudget(tokenBudget);
	return {
		id: makeId(),
		objective: trimmed,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		activeSince: now,
	};
}

export function cloneState(state: GoalModeState): GoalModeState {
	return {
		...state,
		goal: state.goal ? { ...state.goal } : null,
		previousTools: state.previousTools ? [...state.previousTools] : undefined,
	};
}

export function latestPersistedState(entries: readonly unknown[]): GoalModeState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		return parseState(entry.data);
	}
	return undefined;
}

export function parseState(value: unknown): GoalModeState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<GoalModeState>;
	if (input.version !== 1) return undefined;
	return {
		version: 1,
		goal: parseGoal(input.goal),
		enabled: input.enabled === true,
		autoChild: input.autoChild !== false,
		previousTools: Array.isArray(input.previousTools)
			? input.previousTools.filter((tool): tool is string => typeof tool === "string")
			: undefined,
		budgetNoticeSent: input.budgetNoticeSent === true,
		suppressNextContinuation: input.suppressNextContinuation === true,
	};
}

export function accountGoalUsage(state: GoalModeState, entries: readonly unknown[], now = Date.now()): GoalModeState {
	const next = cloneState(state);
	const goal = next.goal;
	if (!goal) return next;
	goal.tokensUsed = tokenUsageSince(entries, goal.createdAt);
	if (next.enabled && goal.activeSince !== undefined && isAccountingStatus(goal.status)) {
		const elapsed = Math.max(0, Math.floor((now - goal.activeSince) / 1000));
		if (elapsed > 0) {
			goal.timeUsedSeconds += elapsed;
			goal.activeSince += elapsed * 1000;
		}
	}
	goal.updatedAt = now;
	return next;
}

export function maybeApplyBudgetLimit(state: GoalModeState, now = Date.now()): GoalModeState {
	const next = cloneState(state);
	const goal = next.goal;
	if (!goal || goal.status !== "active" || goal.tokenBudget === undefined) return next;
	if (goal.tokensUsed < goal.tokenBudget) return next;
	goal.status = "budget-limited";
	goal.updatedAt = now;
	goal.activeSince = undefined;
	next.enabled = false;
	return next;
}

export function remainingTokens(goal: GoalRecord | null | undefined): number | null {
	if (!goal || goal.tokenBudget === undefined) return null;
	return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function completionReport(goal: GoalRecord): string {
	const parts = [`tokens used: ${goal.tokensUsed.toLocaleString()}`];
	if (goal.tokenBudget !== undefined) parts[0] += ` of ${goal.tokenBudget.toLocaleString()}`;
	if (goal.timeUsedSeconds > 0) parts.push(`time used: ${goal.timeUsedSeconds}s`);
	return `Goal achieved. Final budget: ${parts.join("; ")}.`;
}

export function validateTokenBudget(tokenBudget: number | undefined): void {
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("Goal budget must be a positive integer or off.");
	}
}

function parseGoal(value: unknown): GoalRecord | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object") return null;
	const input = value as Partial<GoalRecord>;
	if (
		typeof input.id !== "string" ||
		typeof input.objective !== "string" ||
		typeof input.status !== "string" ||
		typeof input.tokensUsed !== "number" ||
		typeof input.timeUsedSeconds !== "number" ||
		typeof input.createdAt !== "number" ||
		typeof input.updatedAt !== "number"
	) {
		return null;
	}
	return {
		id: input.id,
		objective: input.objective,
		status: input.status as GoalRecord["status"],
		tokenBudget: typeof input.tokenBudget === "number" ? input.tokenBudget : undefined,
		tokensUsed: input.tokensUsed,
		timeUsedSeconds: input.timeUsedSeconds,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
		activeSince: typeof input.activeSince === "number" ? input.activeSince : undefined,
		completedAt: typeof input.completedAt === "number" ? input.completedAt : undefined,
	};
}

function tokenUsageSince(entries: readonly unknown[], since: number): number {
	let total = 0;
	for (const entry of entries) {
		const record = entry as { type?: string; timestamp?: string; message?: unknown };
		if (record.type !== "message") continue;
		if (entryTime(record) < since) continue;
		const message = record.message as { role?: string; usage?: unknown; toolName?: string; details?: unknown };
		if (message.role === "assistant") total += billableTokens(message.usage);
		if (message.role === "toolResult" && message.toolName === "subagent") total += subagentTokens(message.details);
	}
	return total;
}

function entryTime(entry: { timestamp?: string; message?: unknown }): number {
	const message = entry.message as { timestamp?: number } | undefined;
	if (typeof message?.timestamp === "number") return message.timestamp;
	return entry.timestamp ? Date.parse(entry.timestamp) : 0;
}

function billableTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;
	return numberField(record.input) + numberField(record.output) + numberField(record.cacheWrite);
}

function subagentTokens(details: unknown): number {
	if (!details || typeof details !== "object") return 0;
	const record = details as Record<string, unknown>;
	if (record.usage) return billableTokens(record.usage);
	if (!Array.isArray(record.results)) return 0;
	return record.results.reduce((sum, result) => {
		const usage = result && typeof result === "object" ? (result as Record<string, unknown>).usage : undefined;
		return sum + billableTokens(usage);
	}, 0);
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isAccountingStatus(status: GoalRecord["status"]): boolean {
	return status === "active" || status === "budget-limited";
}

function makeId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
