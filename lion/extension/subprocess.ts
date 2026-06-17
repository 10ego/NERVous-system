/**
 * LION — pi subprocess runner.
 *
 * One LION run = one isolated headless `pi --mode json -p --no-session`
 * subprocess. The worker returns a machine-readable WORKER_REPORT JSON block
 * plus any human-readable notes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { LionReport, LionRun } from "./schema.ts";

export interface LionRunnerOptions {
	cwd: string;
	extraArgs?: string[];
	forcePiBinary?: boolean;
}

export interface LionRunRequest {
	run: Pick<LionRun, "id" | "agent_id" | "task_id" | "objective" | "context" | "model" | "tools">;
	signal?: AbortSignal;
	timeout_ms?: number;
}

export interface LionRunOutput {
	text: string;
	report: LionReport | null;
}

export function getPiInvocation(args: string[], opts?: { forceBinary?: boolean }): { command: string; args: string[] } {
	if (!opts?.forceBinary) {
		const currentScript = process.argv[1];
		const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
		if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
			return { command: process.execPath, args: [currentScript, ...args] };
		}
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-lion-"));
	const safeName = label.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;
		for (const part of msg.content) if (part.type === "text") return part.text;
	}
	return "";
}

export function buildLionSystemPrompt(run: LionRunRequest["run"]): string {
	return [
		`You are ${run.agent_id}, a LION (Local Intelligence Operations Node) in the NERVous System.`,
		"You are an isolated coding subagent. Complete exactly the assignment you were given; do not broaden scope.",
		"Use available pi coding tools to inspect/edit/run tests as needed. If AXON is available, update the assigned task status. If SYNAPSE is available, post short started/completed/blocker coordination notes.",
		"If you are blocked, stop safely, explain the blocker, and do not invent success.",
		"Return a final WORKER_REPORT JSON block exactly in this shape:",
		"```json",
		JSON.stringify(
			{
				WORKER_REPORT: {
					outcome: "completed | blocked | failed | partial",
					summary: "what you did",
					changed_files: ["path/or/file"],
					tests_run: ["command or check"],
					blockers: ["blocking issue"],
					next_steps: ["follow-up"],
					notes: "optional extra context",
				},
			},
			null,
			2,
		),
		"```",
		"The JSON must be parseable. Keep all other prose concise.",
	].join("\n");
}

export function buildLionUserPrompt(run: LionRunRequest["run"]): string {
	const lines = [
		`LION run id: ${run.id}`,
		`Agent id: ${run.agent_id}`,
		`AXON task id: ${run.task_id ?? "(none)"}`,
		"",
		"Objective:",
		run.objective,
	];
	if (run.context.trim()) lines.push("", "Context / constraints / acceptance criteria:", run.context);
	if (run.task_id) {
		lines.push(
			"",
			"If the axon tool is available: get the assigned AXON task first, set it in_progress when starting, add concise progress notes, and set it needs_review/completed/blocked according to your outcome.",
		);
	}
	lines.push("", "Work now. Finish with the WORKER_REPORT JSON block.");
	return lines.join("\n");
}

export function parseLionReport(text: string): LionReport | null {
	for (const candidate of candidateJsonStrings(text)) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const obj = isObject(parsed) && isObject(parsed.WORKER_REPORT) ? parsed.WORKER_REPORT : parsed;
			const report = coerceReport(obj);
			if (report) return report;
		} catch {
			/* next candidate */
		}
	}
	return null;
}

function candidateJsonStrings(text: string): string[] {
	const out: string[] = [];
	const fences = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
	for (const m of fences) out.push(m[1]?.trim() ?? "");
	const marker = text.indexOf("WORKER_REPORT");
	if (marker >= 0) {
		const start = text.lastIndexOf("{", marker);
		const end = text.indexOf("}\n", marker);
		if (start >= 0) out.push(text.slice(start).trim());
		if (start >= 0 && end > start) out.push(text.slice(start, end + 1).trim());
	}
	out.push(text.trim());
	return out.filter(Boolean);
}

function coerceReport(value: unknown): LionReport | null {
	if (!isObject(value)) return null;
	const rawOutcome = typeof value.outcome === "string" ? value.outcome : "failed";
	const outcome = ["completed", "blocked", "failed", "partial"].includes(rawOutcome)
		? (rawOutcome as LionReport["outcome"])
		: "failed";
	const summary = typeof value.summary === "string" ? value.summary : "";
	if (!summary && !Array.isArray(value.blockers)) return null;
	return {
		outcome,
		summary,
		changed_files: strings(value.changed_files),
		tests_run: strings(value.tests_run),
		blockers: strings(value.blockers),
		next_steps: strings(value.next_steps),
		notes: typeof value.notes === "string" ? value.notes : undefined,
	};
}

function strings(x: unknown): string[] {
	return Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
}
function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}

export function createLionRunner(opts: LionRunnerOptions) {
	return async (req: LionRunRequest): Promise<LionRunOutput> => runPiOnce(req, opts);
}

async function runPiOnce(req: LionRunRequest, opts: LionRunnerOptions): Promise<LionRunOutput> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (req.run.model) args.push("--model", req.run.model);
	if (req.run.tools && req.run.tools.length > 0) args.push("--tools", req.run.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	try {
		const tmp = await writePromptToTempFile(req.run.agent_id, buildLionSystemPrompt(req.run));
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);
		args.push(buildLionUserPrompt(req.run));

		const messages = await collectMessages(args, opts, req.signal, req.timeout_ms);
		const text = getFinalOutput(messages);
		return { text, report: parseLionReport(text) };
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

function collectMessages(
	args: string[],
	opts: LionRunnerOptions,
	signal?: AbortSignal,
	timeout_ms = 10 * 60_000,
): Promise<Message[]> {
	return new Promise((resolve, reject) => {
		const invocation = getPiInvocation([...args, ...(opts.extraArgs ?? [])], { forceBinary: opts.forcePiBinary });
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const messages: Message[] = [];
		let buffer = "";
		let stderr = "";
		let aborted = false;
		let settled = false;

		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message);
			} catch {
				/* ignore non-json line */
			}
		};

		const killProc = (reason: string) => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
			return reason;
		};

		const timer = setTimeout(() => killProc(`LION subprocess timed out after ${timeout_ms}ms`), timeout_ms);

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => (stderr += data.toString()));
		proc.on("error", (err) => done(() => reject(err)));
		proc.on("close", () => {
			if (buffer.trim()) processLine(buffer);
			if (aborted) return done(() => reject(new Error("LION subprocess was aborted or timed out")));
			if (messages.length === 0 && stderr.trim()) {
				return done(() => reject(new Error(`LION subprocess produced no output. stderr: ${stderr.trim().slice(0, 1000)}`)));
			}
			done(() => resolve(messages));
		});

		if (signal) {
			if (signal.aborted) killProc("aborted");
			else signal.addEventListener("abort", () => killProc("aborted"), { once: true });
		}
	});
}
