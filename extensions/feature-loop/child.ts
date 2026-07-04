/**
 * @module feature-loop/child
 * Short-lived Pi child runner.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resultRecoveryPrompt } from "./prompts.ts";
import { spawnLogged, type SpawnLogResult } from "./shell.ts";
import type { ChildResult, WorkerKind, WorkerRef } from "./types.ts";

// Tolerates markdown wrapping: **FEATURE_LOOP_RESULT:** `{...}` / fenced json.
const RESULT_RE =
  /FEATURE_LOOP_RESULT\**:?\**\s*`{0,3}(?:json\s*)?(\{[^\n]*\})/g;

const RESULT_STATUSES: ReadonlySet<string> = new Set([
  "clean",
  "findings",
  "fixed",
  "blocked",
  "failed",
]);

const RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;

// Linux caps one argv entry at 128 KiB; larger prompts go through @file.
const MAX_INLINE_PROMPT_BYTES = 60_000;

interface ChildInput {
  runDir: string;
  kind: WorkerKind;
  name: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  onWorker?: (worker: WorkerRef) => Promise<void>;
}

/**
 * Parse child result from decoded text or Pi JSONL.
 * @param text - Captured stdout/stderr.
 * @returns Last valid contract line, or undefined when absent.
 */
export function parseChildResult(text: string): ChildResult | undefined {
  let last: ChildResult | undefined;
  for (const chunk of resultChunks(text)) {
    for (const match of chunk.matchAll(RESULT_RE)) {
      try {
        const parsed = JSON.parse(match[1] ?? "") as ChildResult;
        // [>]: Prompts echo the contract template; only real statuses count.
        if (RESULT_STATUSES.has(parsed.status)) last = parsed;
      } catch {
        // [?]: Bad model JSON -> keep looking.
      }
    }
  }
  return last;
}

function resultChunks(text: string): string[] {
  return [text, extractAssistantText(text)].filter(Boolean);
}

/**
 * Extract final assistant text from Pi JSONL.
 * @param text - Pi JSONL/plain output.
 * @returns Decoded assistant text.
 */
export function extractAssistantText(text: string): string {
  let last = "";
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      if (event.type !== "message_end" || event.message?.role !== "assistant")
        continue;
      const decoded = event.message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      if (decoded) last = decoded;
    } catch {
      // Plain text line.
    }
  }
  return last;
}

/**
 * Inline prompt, or @file reference when too big for one argv entry.
 * @param prompt - Prompt text.
 * @param promptPath - Path the prompt was written to.
 * @returns Argument to pass to pi.
 */
export function promptArg(prompt: string, promptPath: string): string {
  return Buffer.byteLength(prompt, "utf8") > MAX_INLINE_PROMPT_BYTES
    ? `@${promptPath}`
    : prompt;
}

async function spawnPi(
  input: ChildInput,
  defaultTimeoutMs: number,
): Promise<{ worker: WorkerRef; output: SpawnLogResult }> {
  await mkdir(path.join(input.runDir, "logs"), { recursive: true });
  await mkdir(path.join(input.runDir, "prompts"), { recursive: true });
  const promptPath = path.join(input.runDir, "prompts", `${input.name}.md`);
  const logPath = path.join(input.runDir, "logs", `${input.name}.jsonl`);
  await writeFile(promptPath, input.prompt, "utf8");

  const worker: WorkerRef = {
    id: input.name,
    kind: input.kind,
    status: "running",
    cwd: input.cwd,
    logPath,
    promptPath,
    startedAt: new Date().toISOString(),
  };

  const output = await spawnLogged(
    "pi",
    [
      "--mode",
      "json",
      "--no-session",
      "-p",
      promptArg(input.prompt, promptPath),
    ],
    {
      cwd: input.cwd,
      logPath,
      timeoutMs: input.timeoutMs ?? defaultTimeoutMs,
      noOutputTimeoutMs: input.noOutputTimeoutMs ?? 120_000,
      onPid: async (pid) => {
        worker.pid = pid;
        await input.onWorker?.({ ...worker });
      },
    },
  );

  worker.endedAt = new Date().toISOString();
  worker.exitCode = output.code;
  return { worker, output };
}

/**
 * Run one Pi child.
 * @param input - Worker contract.
 * @returns Worker ref and parsed result.
 */
export async function runPiChild(
  input: ChildInput,
): Promise<{ worker: WorkerRef; result: ChildResult }> {
  const { worker, output } = await spawnPi(input, 60 * 60 * 1000);
  const result = await resolveChildResult(input, output);
  worker.status =
    output.code === 0 && result.status !== "failed" ? "done" : "failed";
  worker.summary = result.summary;
  worker.stopReason = result.stopReason;
  return { worker, result };
}

async function resolveChildResult(
  input: ChildInput,
  output: SpawnLogResult,
): Promise<ChildResult> {
  if (output.code === 125)
    return {
      status: "blocked",
      stopReason: "child produced no output before watchdog",
    };
  const parsed = parseChildResult(`${output.stdout}\n${output.stderr}`);
  if (parsed) return parsed;
  const recovered =
    output.code === 0
      ? await recoverResult(input, extractAssistantText(output.stdout))
      : undefined;
  return (
    recovered ?? {
      status: "blocked",
      stopReason: "missing FEATURE_LOOP_RESULT",
    }
  );
}

/**
 * One retry: worker finished without contract line -> ask a fresh child to
 * grade its final message instead of blocking the whole run.
 */
async function recoverResult(
  input: ChildInput,
  finalMessage: string,
): Promise<ChildResult | undefined> {
  if (!finalMessage.trim()) return undefined;
  const { output } = await spawnPi(
    {
      ...input,
      name: `${input.name}-result`,
      prompt: resultRecoveryPrompt(finalMessage),
      timeoutMs: RECOVERY_TIMEOUT_MS,
    },
    RECOVERY_TIMEOUT_MS,
  );
  if (output.code !== 0) return undefined;
  return parseChildResult(`${output.stdout}\n${output.stderr}`);
}

/**
 * Run one Pi child and return final assistant text.
 * @param input - Worker contract.
 * @returns Worker ref and final text.
 */
export async function runPiText(
  input: ChildInput,
): Promise<{ worker: WorkerRef; text: string }> {
  const { worker, output } = await spawnPi(input, 20 * 60 * 1000);
  worker.status = output.code === 0 ? "done" : "failed";
  const text =
    extractAssistantText(output.stdout) ||
    output.stdout.trim() ||
    output.stderr.trim();
  worker.summary = text.split("\n").find(Boolean)?.slice(0, 200);
  if (output.code !== 0) worker.stopReason = text || `exit ${output.code}`;
  return { worker, text };
}
