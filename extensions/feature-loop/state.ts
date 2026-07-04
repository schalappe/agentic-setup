/**
 * @module feature-loop/state
 * Durable state and event log.
 */

import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureLoopEvent, FeatureLoopState } from "./types.ts";

/**
 * State file path.
 * @param runDir - Run dir.
 * @returns state.json path.
 */
export function statePath(runDir: string): string {
  return path.join(runDir, "state.json");
}

/**
 * Event log path.
 * @param runDir - Run dir.
 * @returns events.jsonl path.
 */
export function eventsPath(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

/**
 * Read run state.
 * @param runDir - Run dir.
 * @returns Parsed state.
 * @throws If file missing/invalid.
 */
export async function readState(runDir: string): Promise<FeatureLoopState> {
  return JSON.parse(
    await readFile(statePath(runDir), "utf8"),
  ) as FeatureLoopState;
}

/**
 * True when a readable run state already exists.
 * @param runDir - Run dir.
 * @returns Existing-run flag.
 */
export async function hasExistingRun(runDir: string): Promise<boolean> {
  try {
    await readState(runDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write run state atomically via temp file + rename.
 * @param state - New state.
 */
export async function writeState(state: FeatureLoopState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const target = statePath(state.runDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * Append event.
 * @param runDir - Run dir.
 * @param event - Event without time.
 */
export async function appendEvent(
  runDir: string,
  event: Omit<FeatureLoopEvent, "time">,
): Promise<void> {
  const full: FeatureLoopEvent = { time: new Date().toISOString(), ...event };
  await appendFile(eventsPath(runDir), `${JSON.stringify(full)}\n`, "utf8");
}

/**
 * Read latest events.
 * @param runDir - Run dir.
 * @param limit - Max events.
 * @returns Latest events, oldest first.
 */
export async function readEvents(
  runDir: string,
  limit = 100,
): Promise<FeatureLoopEvent[]> {
  try {
    const text = await readFile(eventsPath(runDir), "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as FeatureLoopEvent);
  } catch {
    return [];
  }
}
