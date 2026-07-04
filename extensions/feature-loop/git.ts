/**
 * @module feature-loop/git
 * Git worktree/branch helpers.
 */

import { rm } from "node:fs/promises";
import { execFile } from "./shell.ts";

/**
 * Ensure branch worktree exists at path.
 * @param repoCwd - Repo root.
 * @param worktree - Worktree path.
 * @param branch - Branch name.
 * @param base - Base ref.
 * @throws If git fails.
 */
export async function ensureWorktree(
  repoCwd: string,
  worktree: string,
  branch: string,
  base: string,
): Promise<void> {
  const current = await execFile("git", ["branch", "--show-current"], {
    cwd: worktree,
    timeoutMs: 10_000,
  });
  if (current.code === 0) {
    if (current.stdout.trim() === branch) return;
    await removeWorktree(repoCwd, worktree);
  } else {
    await rm(worktree, { recursive: true, force: true });
  }

  // Stale registrations from deleted dirs make `worktree add` refuse the path.
  await execFile("git", ["worktree", "prune"], {
    cwd: repoCwd,
    timeoutMs: 30_000,
  });
  const exists = await execFile(
    "git",
    ["show-ref", "--verify", `refs/heads/${branch}`],
    { cwd: repoCwd, timeoutMs: 10_000 },
  );
  const args =
    exists.code === 0
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", "-b", branch, worktree, base];
  const result = await execFile("git", args, {
    cwd: repoCwd,
    timeoutMs: 60_000,
  });
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || `git worktree add failed: ${branch}`,
    );
}

/**
 * Push branch and set upstream.
 * @param cwd - Worktree cwd.
 * @param branch - Branch name.
 * @throws If git fails.
 */
export async function pushBranch(cwd: string, branch: string): Promise<void> {
  const result = await execFile("git", ["push", "-u", "origin", branch], {
    cwd,
    timeoutMs: 120_000,
  });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git push failed: ${branch}`);
}

/**
 * Current HEAD sha.
 * @param cwd - Worktree cwd.
 * @returns Commit sha.
 */
export async function headSha(cwd: string): Promise<string> {
  const result = await execFile("git", ["rev-parse", "HEAD"], {
    cwd,
    timeoutMs: 10_000,
  });
  return result.code === 0 ? result.stdout.trim() : "";
}

/**
 * True when worktree has changes.
 * @param cwd - Worktree cwd.
 * @returns Dirty flag.
 */
export async function isDirty(cwd: string): Promise<boolean> {
  const result = await execFile("git", ["status", "--porcelain"], {
    cwd,
    timeoutMs: 10_000,
  });
  return result.stdout.trim().length > 0;
}

/**
 * True when commits exist ahead of upstream.
 * @param cwd - Worktree cwd.
 * @returns Unpushed flag.
 */
export async function hasUnpushedCommits(cwd: string): Promise<boolean> {
  const upstream = await execFile(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd, timeoutMs: 10_000 },
  );
  if (upstream.code !== 0) return true;
  const result = await execFile("git", ["rev-list", "--count", "@{u}..HEAD"], {
    cwd,
    timeoutMs: 10_000,
  });
  return Number(result.stdout.trim() || "0") > 0;
}

/**
 * Remove git worktree then leftover dir.
 * @param repoCwd - Repo root.
 * @param worktree - Worktree path.
 */
export async function removeWorktree(
  repoCwd: string,
  worktree: string,
): Promise<void> {
  await execFile("git", ["worktree", "remove", "--force", worktree], {
    cwd: repoCwd,
    timeoutMs: 60_000,
  });
  await rm(worktree, { recursive: true, force: true });
}

/**
 * Merge branch into checked-out worktree branch.
 * @param cwd - Worktree cwd.
 * @param branch - Branch to merge.
 * @throws If merge fails.
 */
export async function mergeBranch(cwd: string, branch: string): Promise<void> {
  const result = await execFile(
    "git",
    ["merge", "--no-ff", branch, "-m", `Merge ${branch}`],
    { cwd, timeoutMs: 120_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git merge failed: ${branch}`);
}

/**
 * Delete merged child branch locally and remotely.
 * @param repoCwd - Repo root.
 * @param branch - Branch name.
 * @param worktree - Branch worktree path.
 */
export async function deleteMergedBranch(
  repoCwd: string,
  branch: string,
  worktree: string,
): Promise<void> {
  await removeWorktree(repoCwd, worktree);
  await execFile("git", ["branch", "-D", branch], {
    cwd: repoCwd,
    timeoutMs: 30_000,
  });
  await execFile("git", ["push", "origin", "--delete", branch], {
    cwd: repoCwd,
    timeoutMs: 60_000,
  });
}
