/**
 * @module feature-loop/dashboard
 * Rich TUI dashboard. Reads compact state, never child logs.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readEvents, readState } from "./state.ts";
import type { FeatureLoopEvent, FeatureLoopState } from "./types.ts";

interface DashboardActions {
	pause?: () => Promise<void>;
	resume?: () => Promise<void>;
	stop?: () => void;
}

class FeatureLoopDashboard {
	private state?: FeatureLoopState;
	private events: FeatureLoopEvent[] = [];
	private selected = 0;
	private detail = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private theme: Theme,
		private runDir: string,
		private requestRender: () => void,
		private done: () => void,
		private actions: DashboardActions,
	) {}

	async refresh(): Promise<void> {
		try {
			this.state = await readState(this.runDir);
			this.events = await readEvents(this.runDir, 8);
			this.invalidate();
			this.requestRender();
		} catch {
			// [?]: Run may be initializing.
		}
	}

	handleInput(data: string): void {
		const max = Math.max(0, (this.state?.children.length ?? 1) - 1);
		if (matchesKey(data, "q") || matchesKey(data, "escape")) return this.done();
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(max, this.selected + 1);
		else if (matchesKey(data, "enter")) this.detail = !this.detail;
		else if (matchesKey(data, "p")) void (this.state?.paused ? this.actions.resume?.() : this.actions.pause?.());
		else if (matchesKey(data, "s")) this.actions.stop?.();
		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const state = this.state;
		if (!state) return [th.fg("warning", "Loading feature loop...")];
		const lines: string[] = [];
		const title = ` Feature Loop #${state.issue.number} `;
		lines.push(this.rule(width, title));
		lines.push(this.line(width, `${state.baseBranch} → ${state.featureBranch}`, state.status.toUpperCase()));
		lines.push(this.line(width, `mode ${state.mode} | children ${state.children.filter((c) => c.status === "clean").length}/${state.children.length} | paused ${state.paused ? "yes" : "no"}`, `updated ${new Date(state.updatedAt).toLocaleTimeString()}`));
		lines.push(this.rule(width, " Queue "));

		if (state.children.length === 0) {
			lines.push(this.fit(`  ${this.statusIcon(state.status)} direct implementation on feature branch`, width));
		} else {
			for (let i = 0; i < state.children.length; i++) {
				const child = state.children[i];
				const cursor = i === this.selected ? th.fg("accent", "›") : " ";
				const pr = child.prUrl ? ` ${th.fg("muted", child.prUrl)}` : "";
				lines.push(this.fit(`${cursor} ${this.statusIcon(child.status)} #${child.issue.number} ${child.issue.title} ${th.fg("dim", child.status)}${pr}`, width));
			}
		}

		lines.push(this.rule(width, " Active Step "));
		const worker = state.activeWorker;
		if (worker) {
			lines.push(this.fit(`  ${th.fg("accent", worker.kind)} ${worker.status} pid=${worker.pid ?? "-"}`, width));
			lines.push(this.fit(`  log: ${worker.logPath}`, width));
			if (worker.summary) lines.push(this.fit(`  summary: ${worker.summary}`, width));
		} else {
			lines.push(this.fit(`  ${th.fg("dim", "no active worker")}`, width));
		}

		this.renderReview(lines, width, state);
		this.renderDetails(lines, width, state);
		lines.push(this.rule(width, " Recent events "));
		for (const event of this.events) lines.push(this.fit(`  ${new Date(event.time).toLocaleTimeString()} ${event.level} ${event.message}`, width));
		lines.push(this.rule(width, " ↑↓ select | enter details | p pause/resume | s stop | q hide "));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderReview(lines: string[], width: number, state: FeatureLoopState): void {
		const child = state.children[this.selected];
		const review = child?.review ?? state.finalReview;
		lines.push(this.rule(width, " PR Quality "));
		if (!review) {
			lines.push(this.fit(`  ${this.theme.fg("dim", "not started")}`, width));
			return;
		}
		lines.push(this.fit(`  PR: ${review.prUrl} → ${review.targetBranch} ${review.status}`, width));
		const cycle = review.cycles.at(-1);
		if (!cycle) return;
		lines.push(this.fit(`  cycle ${cycle.index}/${review.maxCycles} thermo=${cycle.thermoFindingCount ?? "?"} ponytail=${cycle.ponytailFindingCount ?? "skipped"} ci=${cycle.ciStatus ?? "?"}`, width));
		for (const [name, step] of Object.entries(cycle.steps)) lines.push(this.fit(`  ${name}: ${step?.status ?? "pending"}`, width));
	}

	private renderDetails(lines: string[], width: number, state: FeatureLoopState): void {
		if (!this.detail) return;
		const child = state.children[this.selected];
		lines.push(this.rule(width, " Details "));
		if (child) {
			lines.push(this.fit(`  issue: #${child.issue.number} ${child.issue.url ?? ""}`, width));
			lines.push(this.fit(`  branch: ${child.branch}`, width));
			lines.push(this.fit(`  worktree: ${child.worktree}`, width));
			if (child.stopReason) lines.push(this.fit(`  stop: ${child.stopReason}`, width));
		} else {
			lines.push(this.fit(`  run: ${state.runDir}`, width));
			if (state.stopReason) lines.push(this.fit(`  stop: ${state.stopReason}`, width));
		}
	}

	private statusIcon(status: string): string {
		if (["done", "clean"].includes(status)) return this.theme.fg("success", "✓");
		if (["failed", "blocked"].includes(status)) return this.theme.fg("error", "✗");
		if (["running", "implementing", "reviewing", "pr"].includes(status)) return this.theme.fg("warning", "⏳");
		if (status === "paused") return this.theme.fg("warning", "Ⅱ");
		return this.theme.fg("dim", "○");
	}

	private rule(width: number, label: string): string {
		const th = this.theme;
		const left = th.fg("borderMuted", "─".repeat(2));
		const right = th.fg("borderMuted", "─".repeat(Math.max(0, width - label.length - 2)));
		return truncateToWidth(`${left}${th.fg("accent", label)}${right}`, width);
	}

	private line(width: number, left: string, right: string): string {
		const gap = Math.max(1, width - left.length - right.length);
		return this.fit(`${left}${" ".repeat(gap)}${this.theme.fg("accent", right)}`, width);
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, width);
	}
}

/**
 * Open dashboard for run.
 * @param ctx - Command context.
 * @param runDir - Run dir.
 * @param actions - Optional live conductor controls.
 */
export async function openDashboard(ctx: ExtensionCommandContext, runDir: string, actions: DashboardActions = {}): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Feature loop state: ${runDir}`, "info");
		return;
	}

	let timer: NodeJS.Timeout | undefined;
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const dashboard = new FeatureLoopDashboard(theme, runDir, () => tui.requestRender(), () => {
			if (timer) clearInterval(timer);
			done();
		}, actions);
		void dashboard.refresh();
		timer = setInterval(() => void dashboard.refresh(), 1000);
		return dashboard;
	});
}
