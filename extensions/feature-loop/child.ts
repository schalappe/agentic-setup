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
const MAX_STREAM_TEXT_CHARS = 256_000;

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

interface PiSpawnResult {
  worker: WorkerRef;
  output: SpawnLogResult;
  result?: ChildResult;
  finalText: string;
}

interface AssistantTextEvent {
  mode: "append" | "replace";
  text: string;
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
    const event = assistantTextEvent(line);
    if (!event) continue;
    last =
      event.mode === "replace"
        ? event.text
        : appendTextTail(last, event.text, MAX_STREAM_TEXT_CHARS);
  }
  return last;
}

function appendTextTail(current: string, text: string, maxChars: number): string {
  const next = current + text;
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return "";
  }
}

function assistantTextEvent(line: string): AssistantTextEvent | undefined {
  const delta = line.match(
    /"assistantMessageEvent":\{"type":"text_delta"[\s\S]*?"delta":"((?:\\.|[^"\\])*)"/,
  );
  if (delta?.[1]) return { mode: "append", text: decodeJsonString(delta[1]) };

  if (
    !line.includes('"type":"message_end"') ||
    !line.includes('"role":"assistant"')
  )
    return undefined;

  try {
    const event = JSON.parse(line) as {
      type?: string;
      message?: {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    if (event.type !== "message_end" || event.message?.role !== "assistant")
      return undefined;
    const text = event.message.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return text ? { mode: "replace", text } : undefined;
  } catch {
    return undefined;
  }
}

function createPiOutputCollector(): {
  onStdout: (text: string) => void;
  finish: () => void;
  readonly result: ChildResult | undefined;
  readonly finalText: string;
} {
  let pending = "";
  let finalText = "";
  let result: ChildResult | undefined;

  const applyText = (event: AssistantTextEvent) => {
    finalText =
      event.mode === "replace"
        ? event.text.slice(-MAX_STREAM_TEXT_CHARS)
        : appendTextTail(finalText, event.text, MAX_STREAM_TEXT_CHARS);
    result = parseChildResult(finalText) ?? result;
  };

  const scanLine = (line: string) => {
    const parsed = parseChildResult(line);
    if (parsed) result = parsed;

    const event = assistantTextEvent(line);
    if (event) applyText(event);
    else if (!line.startsWith("{"))
      applyText({ mode: "append", text: `${line}\n` });
  };

  const onStdout = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) scanLine(line);
  };

  return {
    onStdout,
    finish: () => {
      if (pending) scanLine(pending);
      pending = "";
    },
    get result() {
      return result;
    },
    get finalText() {
      return finalText;
    },
  };
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
): Promise<PiSpawnResult> {
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

  const collector = createPiOutputCollector();
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
      onStdout: collector.onStdout,
      onPid: async (pid) => {
        worker.pid = pid;
        await input.onWorker?.({ ...worker });
      },
    },
  );
  collector.finish();

  worker.endedAt = new Date().toISOString();
  worker.exitCode = output.code;
  return {
    worker,
    output,
    result: collector.result,
    finalText: collector.finalText,
  };
}

/**
 * Run one Pi child.
 * @param input - Worker contract.
 * @returns Worker ref and parsed result.
 */
export async function runPiChild(
  input: ChildInput,
): Promise<{ worker: WorkerRef; result: ChildResult }> {
  const spawned = await spawnPi(input, 60 * 60 * 1000);
  const { worker } = spawned;
  const result = await resolveChildResult(input, spawned);
  worker.status =
    spawned.output.code === 0 && result.status !== "failed" ? "done" : "failed";
  worker.summary = result.summary;
  worker.stopReason = result.stopReason;
  return { worker, result };
}

async function resolveChildResult(
  input: ChildInput,
  spawned: PiSpawnResult,
): Promise<ChildResult> {
  const { output } = spawned;
  if (output.code === 125)
    return {
      status: "blocked",
      stopReason: "child produced no output before watchdog",
    };
  const parsed =
    spawned.result ?? parseChildResult(`${output.stdout}\n${output.stderr}`);
  if (parsed) return parsed;
  const recovered =
    output.code === 0
      ? await recoverResult(
          input,
          spawned.finalText || extractAssistantText(output.stdout),
        )
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
  const spawned = await spawnPi(
    {
      ...input,
      name: `${input.name}-result`,
      prompt: resultRecoveryPrompt(finalMessage),
      timeoutMs: RECOVERY_TIMEOUT_MS,
    },
    RECOVERY_TIMEOUT_MS,
  );
  if (spawned.output.code !== 0) return undefined;
  return (
    spawned.result ??
    parseChildResult(`${spawned.output.stdout}\n${spawned.output.stderr}`)
  );
}

/**
 * Run one Pi child and return final assistant text.
 * @param input - Worker contract.
 * @returns Worker ref and final text.
 */
export async function runPiText(
  input: ChildInput,
): Promise<{ worker: WorkerRef; text: string }> {
  const spawned = await spawnPi(input, 20 * 60 * 1000);
  const { worker, output } = spawned;
  worker.status = output.code === 0 ? "done" : "failed";
  const text =
    spawned.finalText ||
    extractAssistantText(output.stdout) ||
    output.stdout.trim() ||
    output.stderr.trim();
  worker.summary = text.split("\n").find(Boolean)?.slice(0, 200);
  if (output.code !== 0) worker.stopReason = text || `exit ${output.code}`;
  return { worker, text };
}
