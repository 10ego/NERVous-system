/**
 * MAGI — production LLM runner.
 *
 * Implements {@link GenerateFn} by spawning a headless `pi` process per request
 * (one isolated context per call), mirroring the proven subagent pattern:
 *   pi --mode json -p --no-session [--model M] [--tools a,b] \
 *      --append-system-prompt <persona-file>  "Task: <prompt>"
 *
 * stdout is a stream of JSON events; we collect the final assistant text and
 * return it. council.ts parses the JSON payload out of that text.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { GenerateFn, GenerateRequest } from "./council.ts";

export interface SubprocessRunnerOptions {
	cwd: string;
	/** Extra args appended to every invocation (rarely needed). */
	extraArgs?: string[];
	/**
	 * Force invocation via the `pi` binary on PATH instead of auto-detecting the
	 * current runtime. Auto-detection assumes this code is running inside pi
	 * (it keys off `process.argv[1]`). Set this when driving the runner from a
	 * non-pi host context (e.g. tests, an external orchestrator).
	 */
	forcePiBinary?: boolean;
}

/** Determine how to invoke pi (matches the subagent example). */
export function getPiInvocation(
	args: string[],
	opts?: { forceBinary?: boolean },
): { command: string; args: string[] } {
	if (!opts?.forceBinary) {
		const currentScript = process.argv[1];
		const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
		if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
			return { command: process.execPath, args: [currentScript, ...args] };
		}
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-magi-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Extract the final assistant text from a list of JSON-mode messages. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

interface RunOptions {
	systemPrompt: string;
	userPrompt: string;
	cwd: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	extraArgs?: string[];
}

async function runPiOnce(opts: RunOptions, forceBinary?: boolean): Promise<string> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	try {
		if (opts.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile("persona", opts.systemPrompt);
			tmpDir = tmp.dir;
			tmpPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPath);
		}
		args.push(`Task:\n${opts.userPrompt}`);

		const messages = await collectMessages(args, opts, forceBinary);
		return getFinalOutput(messages);
	} finally {
		if (tmpPath)
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		if (tmpDir)
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
	}
}

function collectMessages(args: string[], opts: RunOptions, forceBinary?: boolean): Promise<Message[]> {
	return new Promise((resolve, reject) => {
		const invocation = getPiInvocation([...args, ...(opts.extraArgs ?? [])], { forceBinary });
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const messages: Message[] = [];
		let buffer = "";
		let stderr = "";
		let aborted = false;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Message };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const killProc = () => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};

		proc.on("close", () => {
			if (buffer.trim()) processLine(buffer);
			if (aborted) return reject(new Error("MAGI subprocess was aborted"));
			if (messages.length === 0 && stderr.trim()) {
				return reject(new Error(`MAGI subprocess produced no output. stderr: ${stderr.trim().slice(0, 1000)}`));
			}
			resolve(messages);
		});
		proc.on("error", (err) => reject(err));

		if (opts.signal) {
			if (opts.signal.aborted) killProc();
			else opts.signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

/**
 * Create a {@link GenerateFn} backed by headless `pi` subprocesses.
 * Each call gets its own isolated context window.
 */
export function createSubprocessRunner(runnerOpts: SubprocessRunnerOptions): GenerateFn {
	return async (req: GenerateRequest, signal?: AbortSignal): Promise<string> => {
		return runPiOnce({
			systemPrompt: req.systemPrompt,
			userPrompt: req.userPrompt,
			cwd: runnerOpts.cwd,
			model: req.model,
			tools: req.tools,
			signal,
			extraArgs: runnerOpts.extraArgs,
		}, runnerOpts.forcePiBinary);
	};
}
