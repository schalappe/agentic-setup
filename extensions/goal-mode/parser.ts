/**
 * @module goal-mode/parser
 * Goal command parsing.
 */

import type { GoalSubcommand } from "./types.ts";

const SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget", "child"]);

export function goalSubcommands(): GoalSubcommand[] {
	return [...SUBCOMMANDS];
}

export function parseGoalArgs(args: string): { subcommand?: GoalSubcommand; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };
	const [first = "", ...tail] = trimmed.split(/\s+/);
	const candidate = first.toLowerCase() as GoalSubcommand;
	if (SUBCOMMANDS.has(candidate)) return { subcommand: candidate, rest: tail.join(" ").trim() };
	return { rest: trimmed };
}

export function parseBudget(input: string): number | undefined {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed || trimmed === "off") return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
		throw new Error("Goal budget must be a positive integer or off.");
	}
	return parsed;
}
