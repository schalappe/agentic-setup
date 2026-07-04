/**
 * @module goal-mode/commands
 * Slash command handlers.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderDetails } from "./prompts.ts";
import { runGuidedGoal } from "./guided.ts";
import type { GoalModeController } from "./controller.ts";
import type { GoalSubcommand } from "./types.ts";
import { goalSubcommands, parseBudget, parseGoalArgs } from "./parser.ts";

export function registerGoalCommands(pi: ExtensionAPI, controller: GoalModeController): void {
	pi.registerCommand("goal", {
		description: "Run persistent autonomous goal mode",
		handler: async (args, ctx) => handleGoalCommand(controller, args, ctx),
		getArgumentCompletions: (prefix) => {
			const items = goalSubcommands()
				.filter((command) => command.startsWith(prefix.trim()))
				.map((command) => ({ value: command, label: command }));
			return items.length > 0 ? items : null;
		},
	});

	pi.registerCommand("guided-goal", {
		description: "Interview and refine a goal before enabling goal mode",
		handler: async (args, ctx) => handleGuidedGoalCommand(controller, args, ctx),
	});
}

async function handleGoalCommand(controller: GoalModeController, args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const { subcommand, rest } = parseGoalArgs(args);
		if (subcommand) {
			await dispatchSubcommand(controller, subcommand, rest, ctx);
			return;
		}

		const goal = controller.goal;
		if (goal && !rest) {
			await openGoalMenu(controller, ctx);
			return;
		}
		if (goal && rest) {
			ctx.ui.notify("Goal already exists. Use /goal set or /goal drop.", "warning");
			return;
		}

		const objective = rest || (await ctx.ui.editor("Goal objective", ""))?.trim();
		if (!objective) return;
		await controller.start(ctx, { objective });
		ctx.ui.notify("Goal mode enabled.", "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function handleGuidedGoalCommand(controller: GoalModeController, args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		if (controller.goal && controller.goal.status !== "complete" && controller.goal.status !== "dropped") {
			ctx.ui.notify("Drop current goal before guided setup.", "warning");
			return;
		}
		const initial = args.trim() || (await ctx.ui.editor("Guided goal", ""))?.trim();
		if (!initial) return;
		const objective = await runGuidedGoal(ctx, initial);
		if (!objective) return;
		await controller.start(ctx, { objective });
		ctx.ui.notify("Guided goal enabled.", "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function dispatchSubcommand(
	controller: GoalModeController,
	subcommand: GoalSubcommand,
	rest: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (subcommand) {
		case "set": {
			const objective = rest || (await ctx.ui.editor("Goal objective", controller.goal?.objective ?? ""))?.trim();
			if (!objective) return;
			if (controller.goal && controller.goal.status !== "complete" && controller.goal.status !== "dropped") {
				await controller.replace(ctx, objective);
			} else {
				await controller.start(ctx, { objective });
			}
			ctx.ui.notify("Goal set.", "info");
			return;
		}
		case "show":
			controller.showDetails(ctx);
			return;
		case "pause":
			controller.pause(ctx);
			ctx.ui.notify("Goal paused.", "info");
			return;
		case "resume":
			controller.resume(ctx);
			ctx.ui.notify("Goal resumed.", "info");
			return;
		case "drop": {
			if (!controller.goal) {
				ctx.ui.notify("No goal to drop.", "warning");
				return;
			}
			const ok = await ctx.ui.confirm("Drop goal?", "This removes the active goal without marking it complete.");
			if (!ok) return;
			controller.drop(ctx);
			ctx.ui.notify("Goal dropped.", "info");
			return;
		}
		case "budget":
			controller.setBudget(ctx, parseBudget(rest || (await ctx.ui.input("Goal budget", "number or off")) || ""));
			ctx.ui.notify("Goal budget updated.", "info");
			return;
		case "child": {
			const value = rest.trim().toLowerCase();
			if (!value) {
				ctx.ui.notify(`Auto child: ${controller.state.autoChild ? "on" : "off"}`, "info");
				return;
			}
			if (!["on", "off"].includes(value)) throw new Error("Usage: /goal child <on|off>");
			controller.setAutoChild(ctx, value === "on");
			ctx.ui.notify(`Auto child ${value}.`, "info");
			return;
		}
	}
}

async function openGoalMenu(controller: GoalModeController, ctx: ExtensionCommandContext): Promise<void> {
	const goal = controller.goal;
	if (!goal) return;
	const title = `Goal: ${goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective}`;
	const choice = await ctx.ui.select(title, [
		"Show details",
		"Adjust budget",
		controller.state.autoChild ? "Disable auto child" : "Enable auto child",
		goal.status === "paused" || goal.status === "budget-limited" ? "Resume" : "Pause",
		"Drop",
	]);
	if (choice === "Show details") {
		ctx.ui.notify(renderDetails(goal, controller.state.autoChild), "info");
	} else if (choice === "Adjust budget") {
		await dispatchSubcommand(controller, "budget", "", ctx);
	} else if (choice === "Disable auto child") {
		controller.setAutoChild(ctx, false);
	} else if (choice === "Enable auto child") {
		controller.setAutoChild(ctx, true);
	} else if (choice === "Resume") {
		controller.resume(ctx);
	} else if (choice === "Pause") {
		controller.pause(ctx);
	} else if (choice === "Drop") {
		await dispatchSubcommand(controller, "drop", "", ctx);
	}
}

