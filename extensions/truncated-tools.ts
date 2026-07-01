import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob, e.g. '*.ts'" })),
});

interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	exitCode: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export default function truncatedTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "ripgrep",
		description: `Search file contents using ripgrep. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		promptSnippet: "Search file contents using ripgrep with truncation-safe output",
		promptGuidelines: ["Use rg for fast content search when shell command output is not otherwise needed."],
		parameters: RgParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path?.startsWith("@") ? params.path.slice(1) : params.path;
			const searchPath = rawPath || undefined;
			const args = ["--line-number", "--color=never"];
			if (params.glob) args.push("--glob", params.glob);
			args.push("--", params.pattern, searchPath ?? ".");

			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			try {
				const result = await execFileAsync("rg", args, { cwd: ctx.cwd, signal });
				stdout = result.stdout;
				stderr = result.stderr;
			} catch (error: any) {
				stdout = String(error.stdout ?? "");
				stderr = String(error.stderr ?? "");
				if (error.code !== 1) throw new Error(`ripgrep failed: ${stderr.trim() || error.message}`);
				exitCode = 1;
			}

			const matchCount = stdout.split("\n").filter((line) => line.trim()).length;
			if (matchCount === 0) {
				return {
					content: [{ type: "text", text: stderr.trim() ? `No matches found\n\n[stderr]\n${stderr.trimEnd()}` : "No matches found" }],
					details: { pattern: params.pattern, path: searchPath, glob: params.glob, matchCount, exitCode } as RgDetails,
				};
			}

			const fullOutput = stderr.trim() ? `${stdout.trimEnd()}\n\n[stderr]\n${stderr.trimEnd()}\n` : stdout;
			const truncation = truncateHead(fullOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const details: RgDetails = { pattern: params.pattern, path: searchPath, glob: params.glob, matchCount, exitCode };
			let text = truncation.content;

			if (truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-rg-"));
				const tempFile = join(tempDir, "output.txt");
				await withFileMutationQueue(tempFile, () => writeFile(tempFile, fullOutput, "utf8"));

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				const omittedLines = truncation.totalLines - truncation.outputLines;
				const omittedBytes = truncation.totalBytes - truncation.outputBytes;
				text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				text += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
				text += ` Full output saved to: ${tempFile}]`;
			}

			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("rg ")) + theme.fg("accent", `"${args.pattern}"`);
			if (args.path) text += theme.fg("muted", ` in ${args.path}`);
			if (args.glob) text += theme.fg("dim", ` --glob ${args.glob}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const details = result.details as RgDetails | undefined;
			if (!details || details.matchCount === 0) return new Text(theme.fg("dim", "No matches found"), 0, 0);

			let text = theme.fg("success", `${details.matchCount} matches`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") text += "\n" + content.text.split("\n").slice(0, 20).map((line) => theme.fg("dim", line)).join("\n");
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

function execFileAsync(
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { ...options, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				Object.assign(error, { stdout, stderr });
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}
