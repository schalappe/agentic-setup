import { expect, test } from "bun:test";
import { parseBudget, parseGoalArgs } from "./parser.ts";
import { renderActivePrompt } from "./prompts.ts";
import { accountGoalUsage, createGoal, latestPersistedState, maybeApplyBudgetLimit } from "./state.ts";
import type { GoalModeState } from "./types.ts";

test("parse goal subcommands and objective", () => {
	expect(parseGoalArgs("set fix auth")).toEqual({ subcommand: "set", rest: "fix auth" });
	expect(parseGoalArgs("fix auth")).toEqual({ rest: "fix auth" });
	expect(parseGoalArgs("")).toEqual({ rest: "" });
});

test("parse budget", () => {
	expect(parseBudget("off")).toBeUndefined();
	expect(parseBudget("123")).toBe(123);
	expect(() => parseBudget("0")).toThrow();
});

test("accounting sums assistant and subagent billable tokens after goal creation", () => {
	const createdAt = 1_000;
	const state: GoalModeState = {
		version: 1,
		goal: createGoal("ship it", 30, createdAt),
		enabled: true,
		autoChild: true,
	};
	const entries = [
		{
			type: "message",
			timestamp: new Date(createdAt + 1).toISOString(),
			message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2 } },
		},
		{
			type: "message",
			timestamp: new Date(createdAt + 2).toISOString(),
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: { results: [{ usage: { input: 4, output: 3, cacheRead: 50, cacheWrite: 1 } }] },
			},
		},
	];
	const accounted = accountGoalUsage(state, entries, createdAt + 10_000);
	expect(accounted.goal?.tokensUsed).toBe(25);
	expect(accounted.goal?.timeUsedSeconds).toBe(10);
});

test("budget limit disables continuation", () => {
	const state: GoalModeState = {
		version: 1,
		goal: { ...createGoal("ship it", 10, 1), tokensUsed: 10 },
		enabled: true,
		autoChild: true,
	};
	const limited = maybeApplyBudgetLimit(state, 2);
	expect(limited.enabled).toBe(false);
	expect(limited.goal?.status).toBe("budget-limited");
});

test("state restores latest custom entry", () => {
	const latest: GoalModeState = { version: 1, goal: null, enabled: false, autoChild: false };
	expect(
		latestPersistedState([
			{ type: "custom", customType: "goal-mode-state", data: { version: 1, goal: null, enabled: true, autoChild: true } },
			{ type: "custom", customType: "goal-mode-state", data: latest },
		]),
	).toMatchObject(latest);
});

test("prompt escapes objective and advertises subagent", () => {
	const goal = createGoal("fix <auth> & verify", undefined, 1);
	const prompt = renderActivePrompt(goal, true, true);
	expect(prompt).toContain("fix &lt;auth&gt; &amp; verify");
	expect(prompt).toContain("Use subagent automatically");
});
