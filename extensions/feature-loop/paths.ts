/**
 * @module feature-loop/paths
 * Run paths under project `.pi/feature-loop` only.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const FEATURE_LOOP_DIR = path.join(".pi", "feature-loop");

/**
 * Return feature-loop root.
 * @param cwd - Repo root.
 * @returns Absolute root path.
 */
export function featureLoopRoot(cwd: string): string {
  return path.join(cwd, FEATURE_LOOP_DIR);
}

/**
 * Return run dir for issue.
 * @param cwd - Repo root.
 * @param issueNumber - Parent issue number.
 * @returns Absolute run dir.
 */
export function runDir(cwd: string, issueNumber: number): string {
  return path.join(featureLoopRoot(cwd), `run-${issueNumber}`);
}

/**
 * Ensure run subdirs exist.
 * @param dir - Run dir.
 */
export async function ensureRunDirs(dir: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(dir, "logs"), { recursive: true }),
    mkdir(path.join(dir, "artifacts"), { recursive: true }),
    mkdir(path.join(dir, "worktrees"), { recursive: true }),
  ]);
}

/**
 * Make filename-safe slug.
 * @param text - Raw title/name.
 * @returns Lowercase slug.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "issue";
}

/**
 * New run suffix.
 * @returns Short branch-safe id.
 */
export function newRunId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Per-run branch name.
 * @param prefix - Branch namespace.
 * @param issueNumber - Issue number.
 * @param title - Issue title.
 * @param runId - Run suffix.
 * @returns Branch name.
 */
export function runBranch(
  prefix: "feature" | "child",
  issueNumber: number,
  title: string,
  runId: string,
): string {
  return `${prefix}/${issueNumber}-${slugify(title)}-${runId}`;
}
