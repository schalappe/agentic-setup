/**
 * @module feature-loop/github
 * GitHub CLI wrappers. `gh` is source of truth.
 */

import type { GitHubIssue } from "./types.ts";
import { execFile, type ExecResult } from "./shell.ts";

interface GhIssueJson {
  number: number;
  title: string;
  url?: string;
  body?: string;
  state?: string;
  subIssues?: { nodes?: GhIssueJson[]; totalCount?: number };
}

/**
 * Load GitHub issue.
 * @param cwd - Repo cwd.
 * @param number - Issue number.
 * @returns Issue data.
 * @throws If gh fails.
 */
export async function getIssue(
  cwd: string,
  number: number,
): Promise<GitHubIssue> {
  const result = await execFile(
    "gh",
    ["issue", "view", String(number), "--json", "number,title,url,body,state"],
    { cwd, timeoutMs: 20_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `gh issue view failed: ${number}`);
  const issue = JSON.parse(result.stdout) as GhIssueJson;
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    body: issue.body,
  };
}

/**
 * Find child issues from GitHub sub-issues, then task-list refs.
 * @param cwd - Repo cwd.
 * @param issue - Parent issue.
 * @returns Child issues. Empty if none.
 */
export async function getChildIssues(
  cwd: string,
  issue: GitHubIssue,
): Promise<GitHubIssue[]> {
  let source: GhIssueJson = { ...issue };
  const result = await execFile(
    "gh",
    [
      "issue",
      "view",
      String(issue.number),
      "--json",
      "number,title,url,body,subIssues",
    ],
    { cwd, timeoutMs: 20_000 },
  );
  if (result.code === 0) source = JSON.parse(result.stdout) as GhIssueJson;

  const children = parseSubIssues(source);
  const seen = new Set(children.map((child) => child.number));
  for (const number of parseTaskListIssueRefs(source.body ?? "")) {
    if (number === issue.number || seen.has(number)) continue;
    try {
      children.push(await getIssue(cwd, number));
      seen.add(number);
    } catch {
      // [?]: Cross-repo refs ignored until needed.
    }
  }
  return children;
}

/**
 * Parse GitHub sub-issues field.
 * @param issue - gh issue JSON.
 * @returns Child issue nodes.
 */
export function parseSubIssues(issue: GhIssueJson): GitHubIssue[] {
  return (issue.subIssues?.nodes ?? [])
    .filter(
      (child) =>
        typeof child.number === "number" && typeof child.title === "string",
    )
    .map((child) => ({
      number: child.number,
      title: child.title,
      url: child.url,
      body: child.body,
    }));
}

/**
 * Parse legacy task-list issue refs.
 * @param body - Issue body markdown.
 * @returns Issue numbers in body order.
 */
export function parseTaskListIssueRefs(body: string): number[] {
  const refs: number[] = [];
  const seen = new Set<number>();
  for (const line of body.split("\n")) {
    if (!/^\s*- \[[ xX-]\]/.test(line)) continue;
    for (const match of line.matchAll(/#(\d+)/g)) {
      const number = Number(match[1]);
      if (seen.has(number)) continue;
      seen.add(number);
      refs.push(number);
    }
  }
  return refs;
}

/**
 * Create PR via gh.
 * @param cwd - Worktree cwd.
 * @param head - Source branch.
 * @param base - Target branch.
 * @param title - PR title.
 * @param body - PR body.
 * @returns PR URL.
 * @throws If gh fails.
 */
export async function createPr(
  cwd: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<string> {
  const existing = await execFile(
    "gh",
    ["pr", "view", head, "--json", "url,state"],
    { cwd, timeoutMs: 15_000 },
  );
  if (existing.code === 0) {
    const parsed = JSON.parse(existing.stdout) as {
      url?: string;
      state?: string;
    };
    if (parsed.url && parsed.state === "OPEN") return parsed.url;
  }

  const result = await execFile(
    "gh",
    [
      "pr",
      "create",
      "--head",
      head,
      "--base",
      base,
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd, timeoutMs: 30_000 },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "gh pr create failed");
  return result.stdout.trim().split("\n").at(-1) ?? result.stdout.trim();
}

/**
 * Classify `gh pr checks` output.
 * gh exits 1 on failing checks and 8 on pending ones, so stdout must be
 * parsed regardless of exit code.
 * @param result - gh pr checks exec result.
 * @returns CI status.
 */
export function classifyPrChecks(
  result: ExecResult,
): "pending" | "green" | "red" | "unknown" {
  let checks: Array<{ state?: string }>;
  try {
    checks = JSON.parse(result.stdout) as Array<{ state?: string }>;
  } catch {
    return result.code === 8 ? "pending" : "unknown";
  }
  if (!Array.isArray(checks)) return "unknown";
  if (checks.length === 0) return "green";
  if (
    checks.some(
      (check) =>
        check.state === "FAILURE" ||
        check.state === "ERROR" ||
        check.state === "CANCELLED",
    )
  )
    return "red";
  if (
    checks.some(
      (check) => check.state !== "SUCCESS" && check.state !== "SKIPPED",
    )
  )
    return "pending";
  return "green";
}

/**
 * Check PR CI via gh.
 * @param cwd - Worktree cwd.
 * @param prUrl - PR URL/number.
 * @returns CI status.
 */
export async function checkPrCi(
  cwd: string,
  prUrl: string,
): Promise<"pending" | "green" | "red" | "unknown"> {
  const result: ExecResult = await execFile(
    "gh",
    ["pr", "checks", prUrl, "--json", "state"],
    { cwd, timeoutMs: 20_000 },
  );
  return classifyPrChecks(result);
}

/**
 * Wait for PR CI to settle.
 * @param cwd - Worktree cwd.
 * @param prUrl - PR URL/number.
 * @param timeoutMs - Max wait.
 * @returns Final CI status.
 */
export async function waitPrCi(
  cwd: string,
  prUrl: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<"pending" | "green" | "red" | "unknown"> {
  const end = Date.now() + timeoutMs;
  let status = await checkPrCi(cwd, prUrl);
  while (status === "pending" && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    status = await checkPrCi(cwd, prUrl);
  }
  return status;
}
