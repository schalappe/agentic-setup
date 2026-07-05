/**
 * @module feature-loop/prompts
 * Child Pi prompts. One child = one contract.
 * Issue titles/bodies flow verbatim into autonomous children with push
 * access: run only against trusted issues.
 */

import type { GitHubIssue } from "./types.ts";

const resultContract = `
End final response with exactly one line:
FEATURE_LOOP_RESULT: {"status":"clean|findings|fixed|blocked|failed","findingCount":0,"summary":"short","stopReason":"short or null"}
This line is machine-parsed; omitting it blocks the whole run. Always emit it,
even when there is nothing to do or the work was already done.
`;

/**
 * Prompt for implementation child.
 * @param issue - Issue to implement.
 * @param baseBranch - Branch source/target.
 * @returns Prompt text.
 */
export function implementationPrompt(
  issue: GitHubIssue,
  baseBranch: string,
): string {
  return `Implement GitHub issue #${issue.number}: ${issue.title}

Branch is already checked out from ${baseBranch}.

Required flow:
1. Use scout subagent to explore affected code.
2. Use designer subagent to design the solution.
3. Use planner subagent to produce implementation plan.
4. Implement the plan.
5. Verify with smallest useful checks.
6. Commit using caveman-commit rules.
7. Push the current branch.

This may be a resumed run: if the branch already implements the issue, skip to
verification, push, and report status fixed with summary "already implemented".
Stop and report blocked if requirements are ambiguous, destructive, or need human taste.
${resultContract}`;
}

/**
 * Prompt for thermo review child.
 * @param prUrl - PR URL.
 * @param artifactPath - Findings artifact path.
 * @returns Prompt text.
 */
export function thermoReviewPrompt(
  prUrl: string,
  artifactPath: string,
  skillText: string,
): string {
  return `Use embedded thermo-nuclear-code-quality-review skill. It is authoritative; do not claim missing slash command.

<thermo-nuclear-code-quality-review>
${skillText}
</thermo-nuclear-code-quality-review>

Review PR ${prUrl}.
Write findings to ${artifactPath}.
Comment actionable findings on the PR.
Do not fix code in this step.
If you cannot apply embedded skill instructions, status=blocked.
If no blockers/issues, findingCount=0 and status=clean.
${resultContract}`;
}

/**
 * Prompt for thermo fix child.
 * @param prUrl - PR URL.
 * @param findingsPath - Findings artifact path.
 * @returns Prompt text.
 */
export function thermoFixPrompt(prUrl: string, findingsPath: string): string {
  return `Fix thermo-nuclear findings for PR ${prUrl}.

Read findings from ${findingsPath}.
Fix blockers/issues only. Do not broaden scope.
Do not run ponytail-review here.
Verify with smallest useful checks.
Commit changes but do not push.
${resultContract.replace("clean|findings|fixed|blocked|failed", "fixed|blocked|failed")}`;
}

/**
 * Prompt for ponytail review child.
 * @param beforeSha - Before thermo fix.
 * @param afterSha - After thermo fix.
 * @param artifactPath - Findings artifact path.
 * @returns Prompt text.
 */
export function ponytailReviewPrompt(
  beforeSha: string,
  afterSha: string,
  artifactPath: string,
): string {
  return `Run /ponytail-review only on this diff:

${beforeSha}..${afterSha}

Write findings to ${artifactPath}.
Do not review the whole PR. Do not fix code in this step.
If no findings, findingCount=0 and status=clean.
${resultContract}`;
}

/**
 * Prompt for ponytail fix child.
 * @param findingsPath - Findings artifact path.
 * @returns Prompt text.
 */
export function ponytailFixPrompt(findingsPath: string): string {
  return `Fix ponytail findings from ${findingsPath}.

Only simplify the thermo-fix diff. Do not broaden scope.
Verify with smallest useful checks.
Commit changes but do not push.
${resultContract.replace("clean|findings|fixed|blocked|failed", "fixed|blocked|failed")}`;
}

/**
 * Prompt recovering a missing FEATURE_LOOP_RESULT line.
 * @param finalMessage - Prior worker's final message.
 * @returns Prompt text.
 */
export function resultRecoveryPrompt(finalMessage: string): string {
  return `A previous automated worker completed its task but omitted the required status line.

Its final message:
<final-message>
${finalMessage}
</final-message>

Judge the outcome from that message alone. Do not run tools or redo the work.
${resultContract}`;
}

/**
 * Prompt for PR command child.
 * @param baseBranch - PR base branch.
 * @param issueNumber - Optional issue number.
 * @returns Slash command prompt.
 */
export function prPrompt(baseBranch: string, issueNumber?: number): string {
  return `/pr ${baseBranch}${issueNumber ? ` #${issueNumber}` : ""}`;
}

/**
 * Prompt for ship child.
 * @returns Prompt text.
 */
export function shipPrompt(): string {
  return `Push current branch to its upstream.

Required flow:
1. Run \`git status --short --branch\`.
2. If branch is ahead or has no upstream, push current branch with \`git push -u origin HEAD\`.
3. If branch is not ahead, report fixed with summary "nothing to push".

Do not merge PRs.
${resultContract.replace("clean|findings|fixed|blocked|failed", "fixed|blocked|failed")}`;
}
