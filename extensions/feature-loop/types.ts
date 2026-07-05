/**
 * @module feature-loop/types
 * Shared state contracts. Disk JSON must stay boring.
 */

export type RunStatus =
  "running" | "paused" | "done" | "blocked" | "failed" | "stopped";

export type ChildStatus =
  | "queued"
  | "implementing"
  | "pr"
  | "reviewing"
  | "clean"
  | "blocked"
  | "failed";

export type StepStatus =
  "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

export type QualityStepName =
  "THERMO_REVIEW" | "THERMO_FIX" | "PONYTAIL_REVIEW" | "PONYTAIL_FIX" | "SHIP";

export type WorkerKind =
  | "implement"
  | "pr"
  | "thermo-review"
  | "thermo-fix"
  | "ponytail-review"
  | "ponytail-fix"
  | "ship";

export interface WorkerRef {
  id: string;
  kind: WorkerKind;
  pid?: number;
  status: StepStatus;
  cwd: string;
  logPath: string;
  promptPath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  summary?: string;
  stopReason?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url?: string;
  body?: string;
}

export interface ChildRun {
  issue: GitHubIssue;
  branch: string;
  worktree: string;
  status: ChildStatus;
  /** Set only after the branch landed in the feature branch. */
  merged?: boolean;
  prUrl?: string;
  review?: PRQualityRun;
  worker?: WorkerRef;
  stopReason?: string;
}

export type CiStatus = "none" | "pending" | "green" | "red" | "unknown";

export interface QualityCycle {
  index: number;
  status: StepStatus;
  steps: Partial<Record<QualityStepName, WorkerRef>>;
  thermoFindingCount?: number;
  thermoFindingSignature?: string;
  ponytailFindingCount?: number;
  beforeFixSha?: string;
  afterFixSha?: string;
  ciStatus?: CiStatus;
  stopReason?: string;
}

export interface PRQualityRun {
  prUrl: string;
  targetBranch: string;
  worktree: string;
  status: StepStatus;
  cycles: QualityCycle[];
  maxCycles: number;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
}

export interface FeatureLoopState {
  version: 1;
  issue: GitHubIssue;
  baseBranch: string;
  featureBranch: string;
  featureWorktree: string;
  runDir: string;
  status: RunStatus;
  mode: "children" | "direct";
  /** Optional for state files written before this field existed. */
  maxCycles?: number;
  children: ChildRun[];
  finalPrUrl?: string;
  finalReview?: PRQualityRun;
  activeWorker?: WorkerRef;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  stopReason?: string;
}

export interface FeatureLoopEvent {
  time: string;
  level: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}

export interface FeatureLoopOptions {
  issueNumber: number;
  baseBranch: string;
  maxCycles: number;
  oneChild: boolean;
}

export interface ChildResult {
  status: "clean" | "findings" | "fixed" | "blocked" | "failed";
  findingCount?: number;
  summary?: string;
  stopReason?: string;
}
