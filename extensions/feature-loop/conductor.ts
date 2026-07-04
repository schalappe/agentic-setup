/**
 * @module feature-loop/conductor
 * Feature loop state machine. Main Pi owns orchestration only.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  ensureRunDirs,
  newRunId,
  runBranch,
  runDir as makeRunDir,
} from "./paths.ts";
import { appendEvent, hasExistingRun, readState, writeState } from "./state.ts";
import { extractAssistantText, runPiChild, runPiText } from "./child.ts";
import { getChildIssues, getIssue, waitPrCi } from "./github.ts";
import {
  deleteMergedBranch,
  ensureWorktree,
  headSha,
  mergeBranch,
  pushBranch,
} from "./git.ts";
import { execFile } from "./shell.ts";
import {
  implementationPrompt,
  ponytailFixPrompt,
  ponytailReviewPrompt,
  prPrompt,
  shipPrompt,
  thermoFixPrompt,
  thermoReviewPrompt,
} from "./prompts.ts";
import type {
  ChildRun,
  FeatureLoopOptions,
  FeatureLoopState,
  PRQualityRun,
  QualityCycle,
  WorkerRef,
} from "./types.ts";

const THERMO_SKILL_PATHS = [
  path.join(
    homedir(),
    ".pi",
    "agent",
    "skills",
    "thermo-nuclear-code-quality-review",
    "SKILL.md",
  ),
  path.join(
    homedir(),
    ".agents",
    "skills",
    "thermo-nuclear-code-quality-review",
    "SKILL.md",
  ),
];

/**
 * Parse first GitHub PR URL.
 * @param text - Command output.
 * @returns PR URL if present.
 */
export function parsePrUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0];
}

async function readMaybe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Detect forbidden thermo fallback text.
 * @param text - Assistant/artifact text only.
 * @returns Block reason if fallback happened.
 */
export function detectThermoFallback(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (
    lower.includes("not installed") &&
    lower.includes("thermo-nuclear-code-quality-review")
  )
    return "thermo skill unavailable; fallback forbidden";
  if (
    lower.includes("unavailable") &&
    lower.includes("thermo-nuclear-code-quality-review")
  )
    return "thermo skill unavailable; fallback forbidden";
  if (lower.includes("manual fallback") || lower.includes("fallback review"))
    return "thermo fallback forbidden";
  return undefined;
}

/**
 * Stable thermo finding id.
 * @param text - Thermo artifact.
 * @returns Hash; undefined when clean/empty.
 */
export function thermoFindingSignature(text: string): string | undefined {
  const headings = [...text.matchAll(/^###\s+(?:\d+[.)]?\s*)?(.+)$/gm)]
    .map((match) => normalizeFindingText(match[1] ?? ""))
    .filter(Boolean)
    .sort();
  const normalized =
    headings.length > 0
      ? headings.join("\n")
      : normalizeFindingText(text.replace(/^Finding count:\s*\d+\s*$/gim, ""));
  if (
    !normalized ||
    /\bstatus:\s*clean\b/i.test(text) ||
    /\bno findings\b/i.test(text)
  )
    return undefined;
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

/**
 * True when same thermo findings repeat at tail.
 * @param cycles - Review cycles.
 * @param repeat - Tail length.
 * @returns Exact-repeat flag.
 */
export function repeatedThermoFindingSignature(
  cycles: Array<{ thermoFindingSignature?: string }>,
  repeat = 3,
): boolean {
  const tail = cycles
    .slice(-repeat)
    .map((cycle) => cycle.thermoFindingSignature);
  return (
    tail.length === repeat &&
    tail.every((signature) => signature && signature === tail[0])
  );
}

function normalizeFindingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDoneReview(review: PRQualityRun): boolean {
  return review.status === "done";
}

/**
 * Long-lived conductor. Children do actual work.
 */
export class FeatureLoopConductor {
  private stopped = false;
  private state?: FeatureLoopState;

  constructor(
    private cwd: string,
    private options: FeatureLoopOptions,
    private onUpdate?: (state: FeatureLoopState) => void,
  ) {}

  /**
   * Start loop in background caller awaits if desired.
   * @throws If failure happens before any state exists (nothing to record).
   */
  async start(): Promise<void> {
    try {
      await this.initialize();
      await this.run();
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Request stop before next child.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Pause scheduling new children.
   */
  async pause(): Promise<void> {
    if (!this.state) return;
    this.state.paused = true;
    this.state.status = "paused";
    await this.save("paused");
  }

  /**
   * Resume scheduling.
   */
  async resume(): Promise<void> {
    if (!this.state) return;
    this.state.paused = false;
    this.state.status = "running";
    await this.save("resumed");
  }

  /**
   * Resume saved run.
   * @param runDir - Existing run dir.
   * @param overrides - Optional per-resume overrides.
   * @throws If no readable run state exists.
   */
  async resumeExisting(
    runDir = makeRunDir(this.cwd, this.options.issueNumber),
    overrides: { maxCycles?: number } = {},
  ): Promise<void> {
    try {
      this.state = await readState(runDir);
    } catch {
      throw new Error(`no resumable feature-loop run at ${runDir}`);
    }
    this.state.paused = false;
    this.state.status = "running";
    this.state.stopReason = undefined;
    // [!]: Another run may have repointed the shared feature worktree.
    await ensureWorktree(
      this.cwd,
      this.state.featureWorktree,
      this.state.featureBranch,
      await this.resolveBaseRef(this.state.featureBranch),
    );
    if (overrides.maxCycles) {
      this.state.maxCycles = overrides.maxCycles;
      const reviews = [
        this.state.finalReview,
        ...this.state.children.map((child) => child.review),
      ];
      for (const review of reviews) {
        if (review && review.status !== "done")
          review.maxCycles = overrides.maxCycles;
      }
    }
    await this.save("resumed existing run");
    await this.run();
  }

  private async initialize(): Promise<void> {
    // [!]: Starting over a saved run would clobber state and branches.
    const existingDir = makeRunDir(this.cwd, this.options.issueNumber);
    if (await hasExistingRun(existingDir))
      throw new Error(
        `run already exists at ${existingDir}; use /feature-loop-resume #${this.options.issueNumber} to continue or /feature-loop-clean #${this.options.issueNumber} to discard it`,
      );
    const issue = await getIssue(this.cwd, this.options.issueNumber);
    const dir = makeRunDir(this.cwd, issue.number);
    await ensureRunDirs(dir);
    const runId = newRunId();
    const featureBranch = runBranch(
      "feature",
      issue.number,
      issue.title,
      runId,
    );
    const featureWorktree = path.join(
      dir,
      "worktrees",
      `feature-${issue.number}`,
    );
    const baseRef = await this.resolveBaseRef(this.options.baseBranch);
    await ensureWorktree(this.cwd, featureWorktree, featureBranch, baseRef);
    await pushBranch(featureWorktree, featureBranch);

    let children = await getChildIssues(this.cwd, issue);
    if (this.options.oneChild) children = children.slice(0, 1);
    const childRuns: ChildRun[] = children.map((child) => ({
      issue: child,
      branch: runBranch("child", child.number, child.title, runId),
      worktree: path.join(dir, "worktrees", `child-${child.number}`),
      status: "queued",
    }));

    this.state = {
      version: 1,
      issue,
      baseBranch: this.options.baseBranch,
      featureBranch,
      featureWorktree,
      runDir: dir,
      status: "running",
      mode: childRuns.length > 0 ? "children" : "direct",
      maxCycles: this.options.maxCycles,
      children: childRuns,
      paused: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.save(`initialized ${issue.number}`);
  }

  private async run(): Promise<void> {
    const state = this.mustState();
    if (state.mode === "children") {
      for (const child of state.children) {
        await this.waitIfPaused();
        if (this.stopped) return this.markStopped("stopped by user");
        if (child.status !== "clean") {
          if (
            child.review &&
            (child.status === "reviewing" || child.status === "blocked")
          )
            await this.resumeChildReview(child);
          else await this.implementChild(child);
        }
        if (child.status !== "clean")
          return this.block(
            `child #${child.issue.number}: ${child.stopReason ?? child.status}`,
          );
        if (child.merged) continue;
        await mergeBranch(state.featureWorktree, child.branch);
        await pushBranch(state.featureWorktree, state.featureBranch);
        child.merged = true;
        await this.save(
          `merged child #${child.issue.number} into ${state.featureBranch}`,
        );
        await deleteMergedBranch(this.cwd, child.branch, child.worktree);
        await this.save(`deleted ${child.branch}`);
      }
    } else {
      await this.implementDirect();
      if (state.status !== "running") return;
    }

    if (!state.finalPrUrl) {
      state.finalPrUrl = await this.openPrWithPi(
        state.featureWorktree,
        state.baseBranch,
        state.issue.number,
        `feature-${state.issue.number}-pr`,
      );
      await this.save(`final PR opened ${state.finalPrUrl}`);
    }
    state.finalReview ??= this.newQualityRun(
      state.finalPrUrl,
      state.baseBranch,
      state.featureWorktree,
    );
    if (state.finalReview.status === "blocked") {
      state.finalReview.status = "running";
      state.finalReview.stopReason = undefined;
      state.finalReview.endedAt = undefined;
    }
    await this.runQuality(state.finalReview);
    state.status = state.finalReview.status === "done" ? "done" : "blocked";
    state.stopReason = state.finalReview.stopReason;
    await this.save(state.status === "done" ? "done" : "blocked");
  }

  private async implementChild(child: ChildRun): Promise<void> {
    const state = this.mustState();
    child.status = "implementing";
    await ensureWorktree(
      this.cwd,
      child.worktree,
      child.branch,
      state.featureBranch,
    );
    await this.save(`implement child #${child.issue.number}`);
    const { worker, result } = await this.childWorker(
      "implement",
      `child-${child.issue.number}-implement`,
      child.worktree,
      implementationPrompt(child.issue, state.featureBranch),
    );
    child.worker = worker;
    if (result.status === "blocked" || result.status === "failed") {
      child.status = result.status;
      child.stopReason = result.stopReason ?? result.summary;
      await this.save(`child #${child.issue.number} ${child.status}`);
      return;
    }

    await pushBranch(child.worktree, child.branch);
    child.status = "pr";
    child.prUrl = await this.openPrWithPi(
      child.worktree,
      state.featureBranch,
      child.issue.number,
      `child-${child.issue.number}-pr`,
    );
    await this.save(`child PR opened ${child.prUrl}`);
    child.status = "reviewing";
    child.review = this.newQualityRun(
      child.prUrl,
      state.featureBranch,
      child.worktree,
    );
    await this.runQuality(child.review);
    child.status = child.review.status === "done" ? "clean" : "blocked";
    child.stopReason = child.review.stopReason;
    await this.save(`child #${child.issue.number} ${child.status}`);
  }

  private async implementDirect(): Promise<void> {
    const state = this.mustState();
    const { worker, result } = await this.childWorker(
      "implement",
      `feature-${state.issue.number}-implement`,
      state.featureWorktree,
      implementationPrompt(state.issue, state.baseBranch),
    );
    state.activeWorker = worker;
    if (result.status === "blocked" || result.status === "failed")
      await this.block(
        result.stopReason ?? result.summary ?? "direct implementation failed",
      );
  }

  private async resumeChildReview(child: ChildRun): Promise<void> {
    if (!child.review)
      throw new Error(`child #${child.issue.number} has no review to resume`);
    if (child.review.status !== "done") {
      child.status = "reviewing";
      child.stopReason = undefined;
      child.review.status = "running";
      child.review.stopReason = undefined;
      child.review.endedAt = undefined;
      await this.save(`resume child #${child.issue.number} review`);
      await this.runQuality(child.review);
    }
    child.status = isDoneReview(child.review) ? "clean" : "blocked";
    child.stopReason = child.review.stopReason;
    await this.save(`child #${child.issue.number} ${child.status}`);
  }

  private async openPrWithPi(
    worktree: string,
    baseBranch: string,
    issueNumber: number,
    name: string,
  ): Promise<string> {
    const { worker, text } = await this.textWorker(
      "pr",
      name,
      worktree,
      prPrompt(baseBranch, issueNumber),
    );
    if (worker.status !== "done")
      throw new Error(worker.stopReason ?? `PR child failed: ${name}`);
    const prUrl = parsePrUrl(text);
    if (!prUrl)
      throw new Error(`PR child did not output PR URL: ${text.slice(0, 200)}`);
    await this.assertOpenPr(worktree, prUrl, baseBranch);
    return prUrl;
  }

  private async assertOpenPr(
    worktree: string,
    prUrl: string,
    baseBranch: string,
  ): Promise<void> {
    const result = await execFile(
      "gh",
      ["pr", "view", prUrl, "--json", "state,baseRefName,url"],
      { cwd: worktree, timeoutMs: 20_000 },
    );
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `failed to inspect PR ${prUrl}`);
    const pr = JSON.parse(result.stdout) as {
      state?: string;
      baseRefName?: string;
      url?: string;
    };
    if (pr.state !== "OPEN")
      throw new Error(
        `PR is not open: ${pr.url ?? prUrl} (${pr.state ?? "unknown"})`,
      );
    if (pr.baseRefName !== baseBranch)
      throw new Error(
        `PR base mismatch: ${pr.baseRefName ?? "unknown"} != ${baseBranch}`,
      );
  }

  private newQualityRun(
    prUrl: string,
    targetBranch: string,
    worktree: string,
  ): PRQualityRun {
    return {
      prUrl,
      targetBranch,
      worktree,
      status: "running",
      cycles: [],
      maxCycles: this.mustState().maxCycles ?? this.options.maxCycles,
      startedAt: new Date().toISOString(),
    };
  }

  private async runQuality(review: PRQualityRun): Promise<void> {
    if (review.status === "done") return;
    for (let i = review.cycles.length + 1; i <= review.maxCycles; i++) {
      await this.waitIfPaused();
      if (this.stopped) {
        review.status = "blocked";
        review.stopReason = "stopped by user";
        return;
      }
      const cycle: QualityCycle = { index: i, status: "running", steps: {} };
      review.cycles.push(cycle);
      await this.save(`PR quality cycle ${i}: thermo review`);

      const findingsPath = path.join(
        this.mustState().runDir,
        "artifacts",
        `pr-${this.safePrId(review.prUrl)}-cycle-${i}-thermo.md`,
      );
      const thermo = await this.childWorker(
        "thermo-review",
        `pr-${this.safePrId(review.prUrl)}-c${i}-thermo-review`,
        review.worktree,
        thermoReviewPrompt(
          review.prUrl,
          findingsPath,
          await this.loadThermoSkill(),
        ),
      );
      cycle.steps.THERMO_REVIEW = thermo.worker;
      cycle.thermoFindingCount =
        thermo.result.findingCount ??
        (thermo.result.status === "clean" ? 0 : undefined);
      cycle.thermoFindingSignature = thermoFindingSignature(
        await readMaybe(findingsPath),
      );
      const badThermo = await this.thermoFallbackDetected(
        findingsPath,
        thermo.worker.logPath,
      );
      if (badThermo) return this.stopReview(review, cycle, badThermo);
      if (
        thermo.result.status === "blocked" ||
        thermo.result.status === "failed"
      )
        return this.stopReview(
          review,
          cycle,
          thermo.result.stopReason ?? "thermo review failed",
        );
      if (repeatedThermoFindingSignature(review.cycles))
        return this.stopReview(
          review,
          cycle,
          "same thermo findings repeated 3 cycles",
        );

      if (
        (cycle.thermoFindingCount ?? 1) === 0 ||
        thermo.result.status === "clean"
      ) {
        cycle.steps.PONYTAIL_REVIEW = this.skippedWorker(
          "PONYTAIL_REVIEW",
          review.worktree,
          "thermo clean",
        );
        cycle.ciStatus = await waitPrCi(review.worktree, review.prUrl);
        cycle.status = cycle.ciStatus === "green" ? "done" : "blocked";
        review.status = cycle.status === "done" ? "done" : "blocked";
        review.stopReason =
          cycle.ciStatus === "red"
            ? "CI red"
            : cycle.ciStatus === "pending"
              ? "CI pending"
              : cycle.ciStatus === "unknown"
                ? "CI unknown"
                : undefined;
        review.endedAt = new Date().toISOString();
        await this.save(`PR quality ${review.status}`);
        return;
      }

      cycle.beforeFixSha = await headSha(review.worktree);
      const fix = await this.childWorker(
        "thermo-fix",
        `pr-${this.safePrId(review.prUrl)}-c${i}-thermo-fix`,
        review.worktree,
        thermoFixPrompt(review.prUrl, findingsPath),
      );
      cycle.steps.THERMO_FIX = fix.worker;
      cycle.afterFixSha = await headSha(review.worktree);
      if (fix.result.status === "blocked" || fix.result.status === "failed")
        return this.stopReview(
          review,
          cycle,
          fix.result.stopReason ?? "thermo fix failed",
        );

      const ponyPath = path.join(
        this.mustState().runDir,
        "artifacts",
        `pr-${this.safePrId(review.prUrl)}-cycle-${i}-ponytail.md`,
      );
      const pony = await this.childWorker(
        "ponytail-review",
        `pr-${this.safePrId(review.prUrl)}-c${i}-ponytail-review`,
        review.worktree,
        ponytailReviewPrompt(cycle.beforeFixSha, cycle.afterFixSha, ponyPath),
      );
      cycle.steps.PONYTAIL_REVIEW = pony.worker;
      cycle.ponytailFindingCount =
        pony.result.findingCount ??
        (pony.result.status === "clean" ? 0 : undefined);
      if (pony.result.status === "blocked" || pony.result.status === "failed")
        return this.stopReview(
          review,
          cycle,
          pony.result.stopReason ?? "ponytail review failed",
        );
      if (
        (cycle.ponytailFindingCount ?? 1) > 0 &&
        pony.result.status !== "clean"
      ) {
        const ponyFix = await this.childWorker(
          "ponytail-fix",
          `pr-${this.safePrId(review.prUrl)}-c${i}-ponytail-fix`,
          review.worktree,
          ponytailFixPrompt(ponyPath),
        );
        cycle.steps.PONYTAIL_FIX = ponyFix.worker;
        if (
          ponyFix.result.status === "blocked" ||
          ponyFix.result.status === "failed"
        )
          return this.stopReview(
            review,
            cycle,
            ponyFix.result.stopReason ?? "ponytail fix failed",
          );
      }

      const ship = await this.childWorker(
        "ship",
        `pr-${this.safePrId(review.prUrl)}-c${i}-ship`,
        review.worktree,
        shipPrompt(),
      );
      cycle.steps.SHIP = ship.worker;
      if (ship.result.status === "blocked" || ship.result.status === "failed")
        return this.stopReview(
          review,
          cycle,
          ship.result.stopReason ?? "ship failed",
        );
      cycle.ciStatus = await waitPrCi(review.worktree, review.prUrl);
      cycle.status = "done";
      await this.save(`PR quality cycle ${i} complete`);
    }
    const last = review.cycles.at(-1);
    this.stopReview(
      review,
      last?.status === "done" ? undefined : last,
      `max cycles ${review.maxCycles} reached`,
    );
  }

  private async loadThermoSkill(): Promise<string> {
    for (const filePath of THERMO_SKILL_PATHS) {
      const text = await readMaybe(filePath);
      if (text) return text;
    }
    throw new Error(`missing thermo skill: ${THERMO_SKILL_PATHS.join(", ")}`);
  }

  private async thermoFallbackDetected(
    findingsPath: string,
    logPath: string,
  ): Promise<string | undefined> {
    const artifact = await readMaybe(findingsPath);
    const assistant = extractAssistantText(await readMaybe(logPath));
    return detectThermoFallback(`${artifact}\n${assistant}`);
  }

  private stopReview(
    review: PRQualityRun,
    cycle: QualityCycle | undefined,
    reason: string,
  ): void {
    if (cycle) {
      cycle.status = "blocked";
      cycle.stopReason = reason;
    }
    review.status = "blocked";
    review.stopReason = reason;
    review.endedAt = new Date().toISOString();
  }

  private async childWorker(
    kind: WorkerRef["kind"],
    name: string,
    cwd: string,
    prompt: string,
  ) {
    const result = await runPiChild({
      runDir: this.mustState().runDir,
      kind,
      name,
      cwd,
      prompt,
      onWorker: (worker) => this.setActiveWorker(worker),
    });
    await this.setActiveWorker(result.worker);
    return result;
  }

  private async textWorker(
    kind: WorkerRef["kind"],
    name: string,
    cwd: string,
    prompt: string,
  ) {
    const result = await runPiText({
      runDir: this.mustState().runDir,
      kind,
      name,
      cwd,
      prompt,
      onWorker: (worker) => this.setActiveWorker(worker),
    });
    await this.setActiveWorker(result.worker);
    return result;
  }

  private async setActiveWorker(worker: WorkerRef): Promise<void> {
    const state = this.mustState();
    state.activeWorker = worker;
    await writeState(state);
    this.onUpdate?.(state);
  }

  private skippedWorker(id: string, cwd: string, reason: string): WorkerRef {
    return {
      id,
      kind: "ponytail-review",
      status: "skipped",
      cwd,
      logPath: "",
      promptPath: "",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      stopReason: reason,
    };
  }

  private async resolveBaseRef(baseBranch: string): Promise<string> {
    await execFile("git", ["fetch", "origin", baseBranch], {
      cwd: this.cwd,
      timeoutMs: 60_000,
    });
    const remote = await execFile(
      "git",
      ["rev-parse", "--verify", `origin/${baseBranch}`],
      { cwd: this.cwd, timeoutMs: 10_000 },
    );
    return remote.code === 0 ? `origin/${baseBranch}` : baseBranch;
  }

  private safePrId(prUrl: string): string {
    return (
      prUrl
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(-60) || "pr"
    );
  }

  private async waitIfPaused(): Promise<void> {
    while (this.state?.paused && !this.stopped)
      await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async markStopped(reason: string): Promise<void> {
    const state = this.mustState();
    state.status = "stopped";
    state.stopReason = reason;
    await this.save(reason);
  }

  private async block(reason: string): Promise<void> {
    const state = this.mustState();
    state.status = "blocked";
    state.stopReason = reason;
    await this.save(reason, "warning");
  }

  private async fail(reason: string): Promise<void> {
    if (!this.state) throw new Error(reason);
    this.state.status = "failed";
    this.state.stopReason = reason;
    await this.save(reason, "error");
  }

  private mustState(): FeatureLoopState {
    if (!this.state) throw new Error("feature loop not initialized");
    return this.state;
  }

  private async save(
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): Promise<void> {
    const state = this.mustState();
    await writeState(state);
    await appendEvent(state.runDir, { level, message });
    this.onUpdate?.(state);
  }
}
