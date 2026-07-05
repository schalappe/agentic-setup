import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { extractAssistantText, parseChildResult, promptArg } from "./child.ts";
import { ensureWorktree } from "./git.ts";
import { execFile, spawnLogged } from "./shell.ts";
import { cleanRuns, parseCleanArgs } from "./cleanup.ts";
import { parseIssueNumber, parseResumeArgs, parseStartArgs } from "./args.ts";
import {
  detectThermoFallback,
  FeatureLoopConductor,
  parsePrUrl,
  repeatedThermoFindingSignature,
  thermoFindingSignature,
} from "./conductor.ts";
import {
  classifyPrChecks,
  parseSubIssues,
  parseTaskListIssueRefs,
} from "./github.ts";
import { shipPrompt, thermoReviewPrompt } from "./prompts.ts";
import { runBranch, runDir, slugify } from "./paths.ts";
import { hasExistingRun, readState, statePath, writeState } from "./state.ts";
import type { FeatureLoopState } from "./types.ts";

test("parse child result uses last contract line", () => {
  expect(
    parseChildResult(
      'noise\nFEATURE_LOOP_RESULT: {"status":"findings","findingCount":2}\nFEATURE_LOOP_RESULT: {"status":"clean","findingCount":0}',
    ),
  ).toEqual({ status: "clean", findingCount: 0 });
});

test("parse child result tolerates markdown wrapping", () => {
  expect(
    parseChildResult(
      '**FEATURE_LOOP_RESULT:** `{"status":"fixed","findingCount":0}`',
    ),
  ).toEqual({ status: "fixed", findingCount: 0 });
  expect(
    parseChildResult(
      'FEATURE_LOOP_RESULT:\n{"status":"clean","findingCount":0}',
    ),
  ).toEqual({ status: "clean", findingCount: 0 });
});

test("parse child result normalizes status case", () => {
  expect(
    parseChildResult(
      'FEATURE_LOOP_RESULT: {"status":"Fixed","findingCount":0}',
    ),
  ).toEqual({ status: "fixed", findingCount: 0 });
});

test("parse child result returns undefined when sentinel missing", () => {
  expect(
    parseChildResult(
      "Already implemented/committed/pushed.\n- Commit: 72119dc",
    ),
  ).toBeUndefined();
});

test("parse child result rejects echoed contract template", () => {
  expect(
    parseChildResult(
      'FEATURE_LOOP_RESULT: {"status":"clean|findings|fixed|blocked|failed","findingCount":0,"summary":"short","stopReason":"short or null"}',
    ),
  ).toBeUndefined();
});

test("extract final assistant text from Pi JSONL", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "https://github.com/acme/repo/pull/42" }],
    },
  });
  expect(extractAssistantText(line)).toBe(
    "https://github.com/acme/repo/pull/42",
  );
});

test("extract assistant text from streamed Pi deltas", () => {
  const lines = ["hello ", "world"].map((delta) =>
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta,
        partial: { ignored: "x".repeat(1000) },
      },
    }),
  );
  expect(extractAssistantText(lines.join("\n"))).toBe("hello world");
});

test("parse child result from Pi JSONL assistant message", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Implemented.\nFEATURE_LOOP_RESULT: {"status":"fixed","findingCount":0,"summary":"ok","stopReason":null}',
        },
      ],
    },
  });
  expect(parseChildResult(line)).toEqual({
    status: "fixed",
    findingCount: 0,
    summary: "ok",
    stopReason: null,
  });
});

test("parse PR URL", () => {
  expect(parsePrUrl("created\nhttps://github.com/acme/repo/pull/42\n")).toBe(
    "https://github.com/acme/repo/pull/42",
  );
  expect(parsePrUrl("Usage: /pr <base-branch>")).toBeUndefined();
});

test("thermo prompt embeds skill", () => {
  const prompt = thermoReviewPrompt(
    "https://github.com/acme/repo/pull/42",
    "/tmp/findings.md",
    "# Skill body",
  );
  expect(prompt).toContain("# Skill body");
  expect(prompt.startsWith("/skill:")).toBe(false);
});

test("ship prompt pushes current branch", () => {
  const prompt = shipPrompt();
  expect(prompt).toContain("git push -u origin HEAD");
  expect(prompt.startsWith("/ship")).toBe(false);
  expect(prompt).toContain("FEATURE_LOOP_RESULT");
});

test("thermo fallback detection ignores prompt text", () => {
  const log = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Never perform a manual fallback review" },
        ],
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: 'FEATURE_LOOP_RESULT: {"status":"clean","findingCount":0}',
          },
        ],
      },
    }),
  ].join("\n");
  expect(detectThermoFallback(extractAssistantText(log))).toBeUndefined();
  expect(
    detectThermoFallback(
      "thermo-nuclear-code-quality-review is not installed; manual fallback review performed",
    ),
  ).toContain("fallback forbidden");
});

test("thermo repeat detection uses finding identity, not count", () => {
  const first = thermoFindingSignature(
    "Finding count: 2\n### 1. Boundary invariant leaked into Usage UI\n### 2. Dynamic i18n key cast weakens the status contract",
  );
  const second = thermoFindingSignature(
    "Finding count: 2\n### 1. Starter quota is modeled as always-present fields\n### 2. Progress state mixes math, CSS, and translation keys",
  );
  expect(first).not.toBe(second);
  expect(
    repeatedThermoFindingSignature([
      { thermoFindingSignature: first },
      { thermoFindingSignature: second },
      { thermoFindingSignature: first },
    ]),
  ).toBe(false);
  expect(
    repeatedThermoFindingSignature([
      { thermoFindingSignature: first },
      { thermoFindingSignature: first },
      { thermoFindingSignature: first },
    ]),
  ).toBe(true);
});

test("parse GitHub sub-issues", () => {
  expect(
    parseSubIssues({
      number: 375,
      title: "parent",
      subIssues: {
        nodes: [
          { number: 376, title: "one", url: "https://example.com/376" },
          { number: 377, title: "two", url: "https://example.com/377" },
        ],
      },
    }),
  ).toEqual([
    {
      number: 376,
      title: "one",
      url: "https://example.com/376",
      body: undefined,
    },
    {
      number: 377,
      title: "two",
      url: "https://example.com/377",
      body: undefined,
    },
  ]);
});

test("parse task-list issue refs as fallback", () => {
  expect(
    parseTaskListIssueRefs(
      "- [ ] #376 one\n- [x] owner/repo#377 done\n- [ ] https://github.com/o/r/issues/378\nplain #999\n- [ ] duplicate #376\n- [ ] All accounts referenced by issue #8 mappings exist",
    ),
  ).toEqual([376, 377, 378]);
});

test("parse clean args", () => {
  expect(parseCleanArgs("#123 --force --kill")).toEqual({
    issueNumber: 123,
    all: false,
    force: true,
    kill: true,
  });
  expect(parseCleanArgs("--all")).toEqual({
    issueNumber: undefined,
    all: true,
    force: false,
    kill: false,
  });
});

test("clean removes unpushed worktree without deleting branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-clean-"));
  const repo = join(dir, "repo");
  const worktree = join(
    repo,
    ".pi",
    "feature-loop",
    "run-9",
    "worktrees",
    "feature-9",
  );
  const run = runDir(repo, 9);
  await execFile("git", ["init", repo], { cwd: dir });
  await execFile("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "x\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });
  await ensureWorktree(repo, worktree, "feature/9-t-aaaaaaaa", "HEAD");
  await writeFile(join(worktree, "feature.txt"), "x\n", "utf8");
  await execFile("git", ["add", "feature.txt"], { cwd: worktree });
  await execFile("git", ["commit", "-m", "feature"], { cwd: worktree });

  const now = new Date().toISOString();
  await writeState({
    version: 1,
    issue: { number: 9, title: "t" },
    baseBranch: "develop",
    featureBranch: "feature/9-t-aaaaaaaa",
    featureWorktree: worktree,
    runDir: run,
    status: "done",
    mode: "direct",
    maxCycles: 10,
    children: [],
    paused: false,
    createdAt: now,
    updatedAt: now,
  });
  const notices: string[] = [];
  await cleanRuns(repo, "#9", {
    ui: {
      confirm: async () => true,
      notify: (message: string) => notices.push(message),
    },
  } as never);

  await expect(readState(run)).rejects.toThrow();
  const branch = await execFile(
    "git",
    ["show-ref", "--verify", "refs/heads/feature/9-t-aaaaaaaa"],
    { cwd: repo },
  );
  expect(branch.code).toBe(0);
  expect(notices.join("\n")).not.toContain("unpushed commits");
});

test("slugify branch text", () => {
  expect(slugify("Add OAuth Login!!")).toBe("add-oauth-login");
});

test("run branches include run suffix", () => {
  expect(runBranch("child", 376, "Add Usage route", "aaaaaaaa")).toBe(
    "child/376-add-usage-route-aaaaaaaa",
  );
  expect(runBranch("child", 376, "Add Usage route", "aaaaaaaa")).not.toBe(
    runBranch("child", 376, "Add Usage route", "bbbbbbbb"),
  );
});

test("ensure worktree replaces stale branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-git-"));
  const repo = join(dir, "repo");
  const worktree = join(dir, "wt");
  await execFile("git", ["init", repo], { cwd: dir });
  await execFile("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "x\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });

  await ensureWorktree(repo, worktree, "child/one", "HEAD");
  await ensureWorktree(repo, worktree, "child/two", "HEAD");

  const current = await execFile("git", ["branch", "--show-current"], {
    cwd: worktree,
  });
  expect(current.stdout.trim()).toBe("child/two");
});

test("silent child gets watchdog log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-test-"));
  const logPath = join(dir, "child.log");
  const result = await spawnLogged(
    process.execPath,
    ["-e", "setTimeout(() => {}, 1000)"],
    {
      cwd: dir,
      logPath,
      noOutputTimeoutMs: 50,
    },
  );
  expect(result.code).toBe(125);
  expect(await readFile(logPath, "utf8")).toContain("no output");
});

test("spawnLogged keeps bounded output tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-test-"));
  const logPath = join(dir, "child.log");
  const result = await spawnLogged(
    process.execPath,
    [
      "-e",
      'process.stdout.write("x".repeat(5000)); process.stdout.write("FEATURE_LOOP_RESULT: {\\"status\\":\\"clean\\",\\"findingCount\\":0}")',
    ],
    {
      cwd: dir,
      logPath,
      maxOutputChars: 128,
    },
  );
  expect(result.code).toBe(0);
  expect(result.stdout.length).toBeLessThanOrEqual(128);
  expect(result.stdout).toContain("FEATURE_LOOP_RESULT");
  expect((await readFile(logPath, "utf8")).length).toBeGreaterThan(5000);
});

test("classify PR checks parses stdout despite nonzero gh exit codes", () => {
  expect(
    classifyPrChecks({
      code: 1,
      stdout: '[{"state":"FAILURE"},{"state":"SUCCESS"}]',
      stderr: "",
    }),
  ).toBe("red");
  expect(
    classifyPrChecks({
      code: 8,
      stdout: '[{"state":"IN_PROGRESS"}]',
      stderr: "",
    }),
  ).toBe("pending");
  expect(classifyPrChecks({ code: 8, stdout: "", stderr: "" })).toBe("pending");
  expect(
    classifyPrChecks({
      code: 0,
      stdout: '[{"state":"SUCCESS"},{"state":"SKIPPED"}]',
      stderr: "",
    }),
  ).toBe("green");
  expect(classifyPrChecks({ code: 0, stdout: "[]", stderr: "" })).toBe("none");
  expect(
    classifyPrChecks({
      code: 1,
      stdout: "garbage",
      stderr: "no checks reported",
    }),
  ).toBe("none");
  expect(
    classifyPrChecks({ code: 1, stdout: "garbage", stderr: "gh failed" }),
  ).toBe("unknown");
});

test("start args never mistake flag values for issue refs", () => {
  expect(parseStartArgs("--max-cycles 5 #123")).toEqual({
    issueNumber: 123,
    baseBranch: "develop",
    maxCycles: 5,
    oneChild: false,
  });
  expect(parseStartArgs("#123 --base main --one-child")).toEqual({
    issueNumber: 123,
    baseBranch: "main",
    maxCycles: 10,
    oneChild: true,
  });
  expect(parseStartArgs("--max-cycles abc #123")).toBeUndefined();
  expect(parseStartArgs("--max-cycles 5")).toBeUndefined();
  expect(parseStartArgs("")).toBeUndefined();
});

test("resume args accept max-cycles override", () => {
  expect(parseResumeArgs("#123")).toEqual({ issueNumber: 123 });
  expect(parseResumeArgs("--max-cycles 6 #123")).toEqual({
    issueNumber: 123,
    maxCycles: 6,
  });
  expect(parseResumeArgs("#123 --max-cycles 0")).toBeUndefined();
  expect(parseResumeArgs("")).toBeUndefined();
});

test("parse bare issue number", () => {
  expect(parseIssueNumber("#42")).toBe(42);
  expect(parseIssueNumber("42")).toBe(42);
  expect(parseIssueNumber("nope")).toBeUndefined();
});

test("oversized prompt goes through @file", () => {
  expect(promptArg("small", "/tmp/p.md")).toBe("small");
  expect(promptArg("x".repeat(70_000), "/tmp/p.md")).toBe("@/tmp/p.md");
});

test("write state atomically and round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-state-"));
  const now = new Date().toISOString();
  const state: FeatureLoopState = {
    version: 1,
    issue: { number: 1, title: "t" },
    baseBranch: "develop",
    featureBranch: "feature/1-t-aaaaaaaa",
    featureWorktree: join(dir, "wt"),
    runDir: dir,
    status: "running",
    mode: "direct",
    maxCycles: 3,
    children: [],
    paused: false,
    createdAt: now,
    updatedAt: now,
  };
  await writeState(state);
  const read = await readState(dir);
  expect(read.maxCycles).toBe(3);
  expect(read.issue.number).toBe(1);
  await expect(readFile(`${statePath(dir)}.tmp`, "utf8")).rejects.toThrow();
});

test("start refuses to clobber an existing run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "feature-loop-guard-"));
  const dir = runDir(cwd, 42);
  await mkdir(dir, { recursive: true });
  expect(await hasExistingRun(dir)).toBe(false);
  const now = new Date().toISOString();
  await writeState({
    version: 1,
    issue: { number: 42, title: "t" },
    baseBranch: "develop",
    featureBranch: "feature/42-t-aaaaaaaa",
    featureWorktree: join(dir, "worktrees", "feature-42"),
    runDir: dir,
    status: "blocked",
    mode: "children",
    maxCycles: 10,
    children: [],
    paused: false,
    createdAt: now,
    updatedAt: now,
  });
  expect(await hasExistingRun(dir)).toBe(true);

  const conductor = new FeatureLoopConductor(cwd, {
    issueNumber: 42,
    baseBranch: "develop",
    maxCycles: 10,
    oneChild: false,
  });
  await expect(conductor.start()).rejects.toThrow("run already exists");
  expect((await readState(dir)).status).toBe("blocked");
});

test("ensure worktree survives stale registration of deleted dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "feature-loop-stale-"));
  const repo = join(dir, "repo");
  const worktree = join(dir, "wt");
  await execFile("git", ["init", repo], { cwd: dir });
  await execFile("git", ["config", "user.email", "test@example.com"], {
    cwd: repo,
  });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "x\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repo });
  await execFile("git", ["commit", "-m", "init"], { cwd: repo });

  await ensureWorktree(repo, worktree, "child/one", "HEAD");
  await rm(worktree, { recursive: true, force: true });
  await ensureWorktree(repo, worktree, "child/two", "HEAD");

  const current = await execFile("git", ["branch", "--show-current"], {
    cwd: worktree,
  });
  expect(current.stdout.trim()).toBe("child/two");
});
