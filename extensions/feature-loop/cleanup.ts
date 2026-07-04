/**
 * @module feature-loop/cleanup
 * Delete run residue after safety checks.
 */

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { featureLoopRoot, runDir as makeRunDir } from "./paths.ts";
import { readState } from "./state.ts";
import { hasUnpushedCommits, isDirty, removeWorktree } from "./git.ts";
import { isPidAlive } from "./shell.ts";
import type { FeatureLoopState } from "./types.ts";

interface CleanOptions {
  issueNumber?: number;
  all: boolean;
  force: boolean;
  kill: boolean;
}

/**
 * Parse clean command args.
 * @param args - Raw command args.
 * @returns Cleanup options.
 */
export function parseCleanArgs(args: string): CleanOptions {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  return {
    issueNumber:
      Number(parts.find((part) => /^#?\d+$/.test(part))?.replace("#", "")) ||
      undefined,
    all: parts.includes("--all"),
    force: parts.includes("--force"),
    kill: parts.includes("--kill"),
  };
}

/**
 * Run cleanup command.
 * @param cwd - Repo cwd.
 * @param args - Raw command args.
 * @param ctx - Command context.
 */
export async function cleanRuns(
  cwd: string,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const options = parseCleanArgs(args);
  const dirs = await targetRunDirs(cwd, options);
  if (dirs.length === 0) {
    ctx.ui.notify("No feature-loop runs to clean", "info");
    return;
  }

  for (const dir of dirs) {
    let state: FeatureLoopState | undefined;
    try {
      state = await readState(dir);
    } catch {
      // Unreadable state: only plain dir removal is safe.
    }
    if (state) {
      const refusal = await cleanupRefusal(state, options);
      if (refusal) {
        ctx.ui.notify(`Refusing ${path.basename(dir)}: ${refusal}`, "warning");
        continue;
      }
    }
    const ok = await ctx.ui.confirm(
      `Delete ${path.basename(dir)}?`,
      state
        ? `Removes logs, artifacts, prompts, state, and worktrees under ${dir}. Branches/PRs stay untouched.`
        : `State unreadable. Removes ${dir} only; clean any worktrees manually.`,
    );
    if (!ok) continue;
    if (state)
      for (const worktree of collectWorktrees(state))
        await removeWorktree(cwd, worktree);
    await rm(dir, { recursive: true, force: true });
    ctx.ui.notify(`Deleted ${dir}`, "info");
  }
}

async function targetRunDirs(
  cwd: string,
  options: CleanOptions,
): Promise<string[]> {
  if (options.issueNumber) {
    const dir = makeRunDir(cwd, options.issueNumber);
    try {
      await stat(dir);
      return [dir];
    } catch {
      return [];
    }
  }
  const root = featureLoopRoot(cwd);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const dirs = names
    .filter((name) => name.startsWith("run-"))
    .map((name) => path.join(root, name));
  if (options.all) return dirs;
  const finished: string[] = [];
  for (const dir of dirs) {
    try {
      const state = await readState(dir);
      if (["done", "failed", "blocked", "stopped"].includes(state.status))
        finished.push(dir);
    } catch {
      // [?]: Broken run dir: --all can handle later.
    }
  }
  return finished;
}

async function cleanupRefusal(
  state: FeatureLoopState,
  options: CleanOptions,
): Promise<string | undefined> {
  const worker = state.activeWorker;
  if (worker?.pid && isPidAlive(worker.pid)) {
    if (!options.kill || !options.force)
      return `active pid ${worker.pid}; use --kill --force`;
    try {
      process.kill(worker.pid, "SIGTERM");
    } catch {
      // Died between the liveness check and the signal.
    }
  }
  if (state.status === "running" && !options.force) return "run still running";
  for (const worktree of collectWorktrees(state)) {
    if (!options.force && (await isDirty(worktree)))
      return `dirty worktree ${worktree}`;
    if (!options.force && (await hasUnpushedCommits(worktree)))
      return `unpushed commits ${worktree}`;
  }
  return undefined;
}

function collectWorktrees(state: FeatureLoopState): string[] {
  return [
    state.featureWorktree,
    ...state.children.map((child) => child.worktree),
  ].filter(Boolean);
}
