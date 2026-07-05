/**
 * @module feature-loop/shell
 * Thin process helpers. No shell unless needed.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SpawnLogResult extends ExecResult {
	pid?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 256_000;

function appendTail(current: string, text: string, maxChars: number): string {
	const next = current + text;
	return next.length > maxChars ? next.slice(-maxChars) : next;
}

/**
 * Run command and capture output.
 * @param command - Binary.
 * @param args - Args.
 * @param options - cwd/timeout/signal.
 * @returns Exit code and output.
 */
export async function execFile(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs?: number; signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, shell: false });
		let stdout = "";
		let stderr = "";
		let done = false;
		const finish = (code: number) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		const timer = options.timeoutMs
			? setTimeout(() => {
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
				finish(124);
			}, options.timeoutMs)
			: undefined;

		child.stdout.on("data", (data) => (stdout += data.toString()));
		child.stderr.on("data", (data) => (stderr += data.toString()));
		child.on("close", (code) => finish(code ?? 0));
		child.on("error", (error) => {
			stderr += error.message;
			finish(1);
		});
		options.signal?.addEventListener("abort", () => {
			child.kill("SIGTERM");
			finish(130);
		});
	});
}

/**
 * Spawn command and tee stdout/stderr to log.
 * @param command - Binary.
 * @param args - Args.
 * @param options - cwd/log/timeout/signal.
 * @returns Exit code and output.
 */
export async function spawnLogged(
	command: string,
	args: string[],
	options: {
		cwd: string;
		logPath: string;
		timeoutMs?: number;
		noOutputTimeoutMs?: number;
		maxOutputChars?: number;
		signal?: AbortSignal;
		onPid?: (pid: number) => void;
		onStdout?: (text: string) => void;
		onStderr?: (text: string) => void;
	},
): Promise<SpawnLogResult> {
	await mkdir(path.dirname(options.logPath), { recursive: true });
	await writeFile(options.logPath, `$ ${command} ${args.join(" ")}\ncwd: ${options.cwd}\n`, "utf8");

	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		if (child.pid) options.onPid?.(child.pid);
		let stdout = "";
		let stderr = "";
		let done = false;
		let sawOutput = false;
		let logWrite: Promise<void> = Promise.resolve();
		const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
		const appendLog = (text: string) => {
			logWrite = logWrite
				.catch(() => undefined)
				.then(() => appendFile(options.logPath, text, "utf8"));
		};
		const write = (stream: "stdout" | "stderr", data: Buffer) => {
			sawOutput = true;
			if (noOutputTimer) clearTimeout(noOutputTimer);
			const text = data.toString();
			if (stream === "stdout") {
				stdout = appendTail(stdout, text, maxOutputChars);
				options.onStdout?.(text);
			} else {
				stderr = appendTail(stderr, text, maxOutputChars);
				options.onStderr?.(text);
			}
			appendLog(text);
		};
		const finish = (code: number) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			if (noOutputTimer) clearTimeout(noOutputTimer);
			void logWrite
				.catch((error: unknown) => {
					stderr = appendTail(
						stderr,
						error instanceof Error ? error.message : String(error),
						maxOutputChars,
					);
				})
				.then(() => resolve({ code, stdout, stderr, pid: child.pid }));
		};
		const timer = options.timeoutMs
			? setTimeout(() => {
				appendLog(`\n[feature-loop] timeout after ${options.timeoutMs}ms\n`);
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
				finish(124);
			}, options.timeoutMs)
			: undefined;
		const noOutputTimer = options.noOutputTimeoutMs
			? setTimeout(() => {
				if (sawOutput) return;
				appendLog(`\n[feature-loop] no output after ${options.noOutputTimeoutMs}ms\n`);
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
				finish(125);
			}, options.noOutputTimeoutMs)
			: undefined;

		child.stdout.on("data", (data) => write("stdout", data));
		child.stderr.on("data", (data) => write("stderr", data));
		child.on("close", (code) => finish(code ?? 0));
		child.on("error", (error) => {
			stderr = appendTail(stderr, error.message, maxOutputChars);
			options.onStderr?.(error.message);
			appendLog(error.message);
			finish(1);
		});
		options.signal?.addEventListener("abort", () => {
			child.kill("SIGTERM");
			finish(130);
		});
	});
}

/**
 * Test whether process lives.
 * @param pid - Process id.
 * @returns True if signal 0 works.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
