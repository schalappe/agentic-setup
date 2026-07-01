import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type GitState = {
	branch?: string;
	dirty: boolean;
};

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

function fitCell(text: string, width: number): string {
	if (width <= 0) return "";
	const trimmed = truncateToWidth(text, width, "");
	return `${trimmed}${" ".repeat(Math.max(0, width - visibleWidth(trimmed)))}`;
}

function borderBar(
	leftChar: string,
	rightChar: string,
	label: string,
	meta: string,
	width: number,
	border: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (width < 4) return border("─".repeat(width));

	let leftText = label;
	let rightText = meta;
	while (visibleWidth(leftText) + visibleWidth(rightText) + 7 > width && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, visibleWidth(rightText) - 1, "");
	}
	while (visibleWidth(leftText) + visibleWidth(rightText) + 7 > width && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, visibleWidth(leftText) - 1, "");
	}

	const gap = Math.max(0, width - 2 - 3 - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(leftChar + "───")}${leftText}${border("─".repeat(gap))}${rightText}${border(rightChar)}`;
}

function borderRow(text: string, width: number, border: (text: string) => string): string {
	if (width < 4) return fitCell(text, width);
	return `${border("│")} ${fitCell(text, width - 4)} ${border("│")}`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatTokens(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!usage || !contextWindow || usage.percent === null || usage.tokens === null) return "ctx ?";
	return `ctx ${formatTokens(usage.tokens)}/${formatTokens(contextWindow)}`;
}

function contextBar(ctx: ExtensionContext, color: (text: string) => string): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "[??????????]";
	const width = 10;
	const filled = Math.max(0, Math.min(width, Math.round((usage.percent / 100) * width)));
	return `[${color("█".repeat(filled))}${"░".repeat(width - filled)}]`;
}

function formatModel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
}

function formatDraft(editor: CustomEditor): string {
	const cursor = editor.getCursor();
	const lines = editor.getLines().length;
	const chars = [...editor.getText()].length;
	return `ln ${cursor.line + 1}/${lines} · col ${cursor.col + 1} · ${chars}ch`;
}

function formatGit(state: GitState): string | undefined {
	if (!state.branch) return undefined;
	return `${state.branch}${state.dirty ? " ±" : ""}`;
}

function sessionUsage(ctx: ExtensionContext): { cost: number; input: number; output: number } {
	let cost = 0;
	let input = 0;
	let output = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		input += usage.input;
		output += usage.output;
		cost += usage.cost.total;
	}
	return { cost, input, output };
}

function formatSpeed(tokensPerSecond: number | undefined): string {
	return tokensPerSecond === undefined ? "tok/s ?" : `${tokensPerSecond.toFixed(1)} tok/s`;
}

function thinkingBorderColor(level: ReturnType<ExtensionAPI["getThinkingLevel"]>) {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingOff";
	}
}

async function readGitState(pi: ExtensionAPI, cwd: string): Promise<GitState> {
	const result = await pi.exec("git", ["status", "--short", "--branch"], { cwd, timeout: 5_000 }).catch(() => undefined);
	if (!result || result.code !== 0) return { dirty: false };

	const lines = result.stdout.trimEnd().split("\n");
	const header = lines[0]?.replace(/^##\s+/, "").trim();
	const branch = header ? header.split("...")[0]?.replace(/^HEAD \(no branch\)$/, "detached") : undefined;
	return { branch, dirty: lines.length > 1 };
}

export default function (pi: ExtensionAPI): void {
	let enabled = true;
	let working = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let activeTui: TUI | undefined;
	let gitState: GitState = { dirty: false };
	let assistantStartedAt: number | undefined;
	let lastTokensPerSecond: number | undefined;

	const requestRender = () => activeTui?.requestRender();
	const stopSpinner = () => {
		if (!spinnerTimer) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		gitState = await readGitState(pi, ctx.cwd);
		requestRender();
	};

	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		enabled = true;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter(() => new EmptyFooter());
		void refreshGit(ctx);

		class BorderEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				activeTui = tui;
			}

			render(width: number): string[] {
				if (width < 8) return super.render(width);

				const innerWidth = width - 4;
				const lines = super.render(innerWidth);
				if (lines.length < 2) return lines;

				const theme = ctx.ui.theme;
				const thinking = pi.getThinkingLevel();
				const border = (text: string) => theme.fg(thinkingBorderColor(thinking), text);
				const usage = sessionUsage(ctx);
				const barColor = usage.output > 0 ? (text: string) => theme.fg("accent", text) : (text: string) => theme.fg("dim", text);
				const state = working
					? theme.fg("accent", ` ${SPINNER[spinnerIndex]} working `)
					: theme.fg("success", " ✓ ready ");
				const context = theme.fg("muted", ` ${formatContext(ctx)} `) + contextBar(ctx, barColor);
				const draft = theme.fg("muted", ` ${formatDraft(this)} `);
				const model = theme.fg("muted", ` ${formatModel(ctx)} · ${thinking} `);
				const cost = theme.fg("muted", ` $${usage.cost.toFixed(4)} · ${formatSpeed(lastTokensPerSecond)} `);
				const git = formatGit(gitState);
				const location = theme.fg("muted", ` ${formatCwd(ctx.cwd)}${git ? ` (${git})` : ""} `);

				return [
					borderBar("╭", "╮", `${state}${context}`, draft, width, border),
					...lines.slice(1, -1).map((line) => borderRow(line, width, border)),
					borderBar("╰", "╯", `${model}${cost}`, location, width, border),
				];
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BorderEditor(tui, theme, keybindings));
	};

	const uninstall = (ctx: ExtensionContext) => {
		enabled = false;
		stopSpinner();
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		ctx.ui.setWorkingVisible(true);
	};

	pi.on("session_start", (_event, ctx) => install(ctx));
	pi.on("agent_start", () => {
		if (!enabled) return;
		working = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
			requestRender();
		}, 80);
		requestRender();
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		assistantStartedAt = Date.now();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const startedAt = assistantStartedAt ?? event.message.timestamp;
		const elapsedSeconds = Math.max(0.1, (Date.now() - startedAt) / 1000);
		const output = (event.message as AssistantMessage).usage.output;
		lastTokensPerSecond = output > 0 ? output / elapsedSeconds : undefined;
		assistantStartedAt = undefined;
		requestRender();
	});
	pi.on("agent_end", (_event, ctx) => {
		working = false;
		stopSpinner();
		void refreshGit(ctx);
		requestRender();
	});
	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);
	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
	});

	pi.registerCommand("border-editor", {
		description: "Enable enhanced border editor",
		handler: async (_args, ctx) => {
			install(ctx);
			ctx.ui.notify("Border editor enabled", "info");
		},
	});

	pi.registerCommand("border-editor-off", {
		description: "Restore built-in editor/footer",
		handler: async (_args, ctx) => {
			uninstall(ctx);
			ctx.ui.notify("Border editor disabled", "info");
		},
	});
}
