/**
 * @module feature-loop/args
 * Command argument parsing. Flag values never count as issue refs.
 */

import type { FeatureLoopOptions } from "./types.ts";

const VALUE_FLAGS = new Set(["--base", "--max-cycles"]);

/**
 * Parse /feature-loop args.
 * @param args - Raw command args.
 * @returns Options, or undefined when invalid.
 */
export function parseStartArgs(args: string): FeatureLoopOptions | undefined {
  const parts = tokenize(args);
  const issueNumber = findIssueNumber(parts);
  const baseBranch = valueAfter(parts, "--base") ?? "develop";
  const maxCycles = Number(valueAfter(parts, "--max-cycles") ?? "10");
  if (!issueNumber || baseBranch.startsWith("--") || !isValidCycles(maxCycles))
    return undefined;
  return {
    issueNumber,
    baseBranch,
    maxCycles,
    oneChild: parts.includes("--one-child"),
  };
}

/**
 * Parse /feature-loop-resume args.
 * @param args - Raw command args.
 * @returns Issue number and optional max-cycles override, or undefined when invalid.
 */
export function parseResumeArgs(
  args: string,
): { issueNumber: number; maxCycles?: number } | undefined {
  const parts = tokenize(args);
  const issueNumber = findIssueNumber(parts);
  if (!issueNumber) return undefined;
  const raw = valueAfter(parts, "--max-cycles");
  if (raw === undefined) return { issueNumber };
  const maxCycles = Number(raw);
  return isValidCycles(maxCycles) ? { issueNumber, maxCycles } : undefined;
}

/**
 * Parse bare issue number from args.
 * @param args - Raw command args.
 * @returns Issue number if present.
 */
export function parseIssueNumber(args: string): number | undefined {
  return findIssueNumber(tokenize(args));
}

function tokenize(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

function findIssueNumber(parts: string[]): number | undefined {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (VALUE_FLAGS.has(part)) {
      i++;
      continue;
    }
    if (/^#?\d+$/.test(part)) return Number(part.replace("#", ""));
  }
  return undefined;
}

function valueAfter(parts: string[], flag: string): string | undefined {
  const index = parts.indexOf(flag);
  return index >= 0 ? parts[index + 1] : undefined;
}

function isValidCycles(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}
