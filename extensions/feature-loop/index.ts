/**
 * @module feature-loop
 * Pi feature-loop extension. Conductor + dashboard + cleanup.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FeatureLoopConductor } from "./conductor.ts";
import { cleanRuns } from "./cleanup.ts";
import { parseIssueNumber, parseResumeArgs, parseStartArgs } from "./args.ts";
import { featureLoopRoot, runDir as makeRunDir } from "./paths.ts";
import { openDashboard } from "./dashboard.ts";

const conductors = new Map<string, FeatureLoopConductor>();

function conductorKey(cwd: string, issueNumber: number): string {
  return `${cwd}::${issueNumber}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register feature-loop commands.
 * @param pi - Pi extension API.
 */
export default function featureLoopExtension(pi: ExtensionAPI): void {
  pi.registerCommand("feature-loop", {
    description: "Start GitHub issue feature loop and open dashboard",
    handler: async (args, ctx) => {
      const options = parseStartArgs(args);
      if (!options) {
        ctx.ui.notify(
          "Usage: /feature-loop #123 [--base develop] [--one-child] [--max-cycles 10]",
          "warning",
        );
        return;
      }
      const key = conductorKey(ctx.cwd, options.issueNumber);
      if (conductors.has(key)) {
        ctx.ui.notify(
          `Feature loop #${options.issueNumber} already active; use /feature-loop-dashboard ${options.issueNumber}`,
          "warning",
        );
        return;
      }

      const conductor = new FeatureLoopConductor(ctx.cwd, options);
      conductors.set(key, conductor);
      void conductor
        .start()
        .catch((error) =>
          ctx.ui.notify(
            `Feature loop #${options.issueNumber} failed: ${errorText(error)}`,
            "error",
          ),
        )
        .finally(() => {
          if (conductors.get(key) === conductor) conductors.delete(key);
        });
      await openDashboard(ctx, makeRunDir(ctx.cwd, options.issueNumber), {
        pause: () => conductor.pause(),
        resume: () => conductor.resume(),
        stop: () => conductor.stop(),
      });
    },
  });

  pi.registerCommand("feature-loop-resume", {
    description: "Resume existing feature-loop run",
    handler: async (args, ctx) => {
      const parsed = parseResumeArgs(args);
      if (!parsed) {
        ctx.ui.notify(
          "Usage: /feature-loop-resume #123 [--max-cycles 10]",
          "warning",
        );
        return;
      }
      const key = conductorKey(ctx.cwd, parsed.issueNumber);
      if (conductors.has(key)) {
        ctx.ui.notify(
          `Feature loop #${parsed.issueNumber} already active; use /feature-loop-dashboard ${parsed.issueNumber}`,
          "warning",
        );
        return;
      }

      const conductor = new FeatureLoopConductor(ctx.cwd, {
        issueNumber: parsed.issueNumber,
        baseBranch: "develop",
        maxCycles: parsed.maxCycles ?? 10,
        oneChild: false,
      });
      conductors.set(key, conductor);
      void conductor
        .resumeExisting(undefined, { maxCycles: parsed.maxCycles })
        .catch((error) =>
          ctx.ui.notify(
            `Feature loop #${parsed.issueNumber} resume failed: ${errorText(error)}`,
            "error",
          ),
        )
        .finally(() => {
          if (conductors.get(key) === conductor) conductors.delete(key);
        });
      await openDashboard(ctx, makeRunDir(ctx.cwd, parsed.issueNumber), {
        pause: () => conductor.pause(),
        resume: () => conductor.resume(),
        stop: () => conductor.stop(),
      });
    },
  });

  pi.registerCommand("feature-loop-dashboard", {
    description: "Open feature-loop dashboard",
    handler: async (args, ctx) => {
      const issue = parseIssueNumber(args);
      const dir = issue
        ? makeRunDir(ctx.cwd, issue)
        : await latestRunDir(ctx.cwd);
      if (!dir) {
        ctx.ui.notify("No feature-loop run found", "warning");
        return;
      }
      const conductor = issue
        ? conductors.get(conductorKey(ctx.cwd, issue))
        : undefined;
      await openDashboard(
        ctx,
        dir,
        conductor
          ? {
              pause: () => conductor.pause(),
              resume: () => conductor.resume(),
              stop: () => conductor.stop(),
            }
          : {},
      );
    },
  });

  pi.registerCommand("feature-loop-stop", {
    description: "Stop active feature-loop conductor",
    handler: async (args, ctx) => {
      const issue = parseIssueNumber(args);
      if (!issue) {
        ctx.ui.notify("Usage: /feature-loop-stop #123", "warning");
        return;
      }
      const conductor = conductors.get(conductorKey(ctx.cwd, issue));
      if (!conductor) {
        ctx.ui.notify(`No active conductor for #${issue}`, "warning");
        return;
      }
      conductor.stop();
      ctx.ui.notify(`Stopping feature loop #${issue}`, "info");
    },
  });

  pi.registerCommand("feature-loop-clean", {
    description: "Clean .pi/feature-loop run residue",
    handler: async (args, ctx) => cleanRuns(ctx.cwd, args, ctx),
  });
}

async function latestRunDir(cwd: string): Promise<string | undefined> {
  const root = featureLoopRoot(cwd);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  const dirs = await Promise.all(
    names
      .filter((name) => name.startsWith("run-"))
      .map(async (name) => {
        const dir = path.join(root, name);
        try {
          return { dir, mtime: (await stat(dir)).mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );
  return dirs
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.mtime - a.mtime)[0]?.dir;
}
