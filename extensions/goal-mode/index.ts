/**
 * @module goal-mode
 * Persistent autonomous goals for Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerGoalCommands } from "./commands.ts";
import { GoalModeController } from "./controller.ts";
import { registerGoalTool } from "./tools.ts";

export default function goalModeExtension(pi: ExtensionAPI): void {
	const controller = new GoalModeController(pi);

	registerGoalTool(pi, controller);
	registerGoalCommands(pi, controller);

	pi.registerMessageRenderer<{ goal?: unknown }>("goal-completed", (message, _options, theme) => {
		return new Text(`${theme.fg("success", "✓ Goal complete")}\n${message.content}`, 0, 0);
	});

	pi.on("session_start", (event, ctx) => controller.onSessionStart(event, ctx));
	pi.on("session_shutdown", (_event, ctx) => controller.onSessionShutdown(ctx));
	pi.on("agent_start", () => controller.onAgentStart());
	pi.on("tool_execution_start", (event) => controller.onToolExecutionStart(event.toolName));
	pi.on("before_agent_start", () => controller.onBeforeAgentStart());
	pi.on("context", (event) => controller.onContext(event));
	pi.on("agent_end", (event, ctx) => controller.onAgentEnd(event, ctx));
}
