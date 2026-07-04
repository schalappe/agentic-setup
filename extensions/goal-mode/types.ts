/**
 * @module goal-mode/types
 * Goal-mode contracts.
 */

export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	activeSince?: number;
	completedAt?: number;
}

export interface GoalModeState {
	version: 1;
	goal: GoalRecord | null;
	enabled: boolean;
	autoChild: boolean;
	previousTools?: string[];
	budgetNoticeSent?: boolean;
	suppressNextContinuation?: boolean;
}

export interface GoalToolDetails {
	op: GoalToolOperation;
	goal: GoalRecord | null;
	remainingTokens: number | null;
	completionReport?: string;
	autoChild: boolean;
}

export type GoalToolOperation = "create" | "get" | "complete" | "resume" | "drop";

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget" | "child";

export interface GoalStartOptions {
	objective: string;
	tokenBudget?: number;
	autoChild?: boolean;
	replace?: boolean;
}
