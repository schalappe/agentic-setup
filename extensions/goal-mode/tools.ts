/**
 * @module goal-mode/tools
 * Goal tool registration.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { goalResponse, type GoalModeController } from "./controller.ts";
import { completionReport, remainingTokens } from "./state.ts";
import type { GoalToolDetails } from "./types.ts";

const goalToolSchema = Type.Object({
	op: StringEnum(["create", "get", "complete", "resume", "drop"] as const, {
		description: "Goal operation.",
	}),
	objective: Type.Optional(Type.String({ description: "Goal objective for create." })),
	token_budget: Type.Optional(Type.Number({ description: "Positive token budget for create." })),
});

type GoalToolInput = Static<typeof goalToolSchema>;

export function registerGoalTool(pi: ExtensionAPI, controller: GoalModeController): void {
	pi.registerTool<typeof goalToolSchema, GoalToolDetails>({
		name: "goal",
		label: "Goal",
		description: [
			"Manage current goal-mode objective.",
			"Use get to inspect state, complete only after verifying all deliverables, resume paused goals, drop abandoned goals.",
			"Do not call complete because budget is low or turn is ending.",
		].join(" "),
		promptSnippet: "Manage persistent goal-mode objective and completion.",
		promptGuidelines: [
			"Use goal({op:\"get\"}) to inspect active goal state when goal-mode progress is unclear.",
			"Use goal({op:\"complete\"}) only after current repo evidence verifies every goal deliverable.",
		],
		parameters: goalToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.op === "create") {
				await controller.start(ctx, { objective: params.objective ?? "", tokenBudget: params.token_budget });
			} else if (params.op === "resume") {
				controller.resume(ctx);
			} else if (params.op === "drop") {
				controller.drop(ctx);
			} else if (params.op === "complete") {
				controller.complete(ctx);
			}

			const state = controller.state;
			const response = goalResponse(state.goal, state.autoChild);
			return {
				content: [{ type: "text", text: formatGoalToolText(response.goal, response.autoChild) }],
				details: {
					op: params.op,
					goal: response.goal,
					remainingTokens: response.remainingTokens,
					completionReport: response.goal?.status === "complete" ? completionReport(response.goal) : undefined,
					autoChild: response.autoChild,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("goal"))} ${theme.fg("accent", args.op ?? "?")}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			const goal = details?.goal;
			if (!goal) return new Text(theme.fg("warning", "No goal."), 0, 0);
			const tokenText = goal.tokenBudget === undefined
				? `${goal.tokensUsed.toLocaleString()} tokens`
				: `${goal.tokensUsed.toLocaleString()}/${goal.tokenBudget.toLocaleString()} tokens`;
			return new Text(
				[
					`${theme.fg("toolTitle", theme.bold("Goal"))} ${theme.fg(statusColor(goal.status), goal.status)}`,
					theme.fg("muted", goal.objective),
					theme.fg("dim", `${tokenText} · child ${details.autoChild ? "auto" : "off"}`),
				].join("\n"),
				0,
				0,
			);
		},
	});
}

function formatGoalToolText(goal: GoalToolDetails["goal"], autoChild: boolean): string {
	if (!goal) return "No active goal.";
	const remaining = remainingTokens(goal);
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Tokens: ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`}`,
		`Auto child: ${autoChild ? "on" : "off"}`,
	];
	if (remaining !== null) lines.push(`Remaining tokens: ${remaining}`);
	return lines.join("\n");
}

function statusColor(status: string): "accent" | "warning" | "success" | "dim" {
	if (status === "complete") return "success";
	if (status === "paused" || status === "budget-limited") return "warning";
	if (status === "dropped") return "dim";
	return "accent";
}

export type { GoalToolInput };
