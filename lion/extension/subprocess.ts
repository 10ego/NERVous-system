/**
 * LION — pi subprocess runner.
 *
 * One LION run = one isolated headless `pi --mode json -p --no-session`
 * subprocess. The worker returns a machine-readable WORKER_REPORT JSON block
 * plus any human-readable notes.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { MAX_ACTIVE_TOOL_NAME_CHARS, MAX_ACTIVE_TOOL_NAMES, coerceLionReport, redactLionDiagnosticText, type LionPartialEvidence, type LionProgressSnapshot, type LionReport, type LionRun, type LionTerminalDiagnostic, type LionTerminalDiagnosticReason } from "./schema.ts";
import { MAX_PROGRESS_TEXT } from "./lifecycle.ts";

const TEXT_PROGRESS_THROTTLE_MS = 1000;
const MAX_PROTOCOL_BUFFER_CHARS = 64 * 1024;

export interface LionRunnerOptions {
	cwd: string;
	extraArgs?: string[];
	forcePiBinary?: boolean;
}

export interface LionProcessInfo {
	pid: number;
	pgid: number | null;
	/** Observational process-birth identity; never grants signaling authority. */
	process_identity?: string | null;
	/** Return true only when a signal/control command was actually issued. */
	cancel?: (signal?: NodeJS.Signals) => Promise<boolean> | boolean;
	isAlive?: () => boolean;
}

export interface LionRunRequest {
	run: Pick<LionRun, "id" | "incarnation_id" | "agent_id" | "task_id" | "objective" | "context" | "model" | "tools" | "steering_messages">;
	signal?: AbortSignal;
	timeout_ms?: number;
	/** Opt in to raw assistant text tails in progress snapshots. Default false/redacted. */
	include_progress_text?: boolean;
	/** Optional live progress callback. Called opportunistically and defensively. */
	onProgress?: (progress: LionProgressSnapshot) => void;
	/** Called once the subprocess PID is known so callers can persist control metadata and active ownership. */
	onProcessStart?: (info: LionProcessInfo) => void;
	/** Called when the worker no longer accepts live control, which may precede process exit for RPC workers. */
	onControlClosed?: () => void;
	/** Called once the subprocess exits; owning callers should keep finalization authority until they persist the final state. */
	onProcessExit?: () => void;
	/**
	 * Atomically transfers an attached live RPC child and terminal intent to a
	 * process-local supervisor. False/throw retains the foreground wait.
	 */
	registerCleanupSupervisor?: (handoff: import("./cleanup-supervisor.ts").LionCleanupHandoff) => boolean | Promise<boolean>;
	/** Exact existing process-local capability transferred with a cleanup handoff. */
	cleanupOwner?: import("./active-runs.ts").ActiveRunOwner;
}

export interface LionRunOutput {
	text: string;
	report: LionReport | null;
	/** Structured terminal diagnostic for report-less outcomes; null on a usable report. */
	terminal?: LionTerminalDiagnostic | null;
}

export type LionRunnerOutcome =
	| ({ settlement: "settled" } & LionRunOutput)
	| { settlement: "cleanup_pending"; run_id: string; incarnation_id: string | null; owner_id: string };

/**
 * Error carrying a structured terminal diagnostic so executeRun can persist a
 * durable record (rather than a console-only message) for spawn/timeout/abort.
 */
export class LionRunnerError extends Error {
	constructor(message: string, public readonly terminal: LionTerminalDiagnostic) {
		super(message);
		this.name = "LionRunnerError";
	}
}

export const MAX_DIAGNOSTIC_TAIL_CHARS = 4_000;
export const MAX_PERSISTED_OUTPUT_CHARS = 16_000;
const OBSERVATIONAL_GIT_TIMEOUT_MS = 1_500;
/** Override repository-controlled integrations for timeout recovery reads. */
export const OBSERVATIONAL_GIT_CONFIG_ARGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;

export interface LionSubprocessDiagnosticContext {
	stdoutTail: string;
	stderrTail: string;
	eventCount: number;
	malformedLineCount: number;
	turnCount: number;
	toolUses: number;
	messageCount: number;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	lastToolAction: string | null;
	changedFiles: string[];
	testsRun: string[];
}

export function boundedPersistedOutput(text: string, max = MAX_PERSISTED_OUTPUT_CHARS): string {
	const bounded = text.length > max ? `[truncated ${text.length - max} leading characters]\n${text.slice(-max)}` : text;
	return redactDiagnosticSecrets(bounded);
}

export function sanitizeDiagnosticTail(text: string, max = MAX_DIAGNOSTIC_TAIL_CHARS): string {
	const stripped = text
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI escape sequences
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ") // non-tab/newline control chars
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	const redacted = redactDiagnosticSecrets(stripped);
	return redacted.length > max ? `${redacted.slice(0, Math.max(0, max - 1))}…` : redacted;
}

function redactDiagnosticSecrets(text: string): string {
	return redactLionDiagnosticText(text);
}

export function buildTerminalDiagnostic(
	reason: LionTerminalDiagnosticReason,
	ctx: LionSubprocessDiagnosticContext,
	extra?: { outputTail?: string; reportAttempted?: boolean; partialEvidence?: LionPartialEvidence | null },
): LionTerminalDiagnostic {
	return {
		reason,
		stdout_tail: sanitizeDiagnosticTail(ctx.stdoutTail),
		stderr_tail: sanitizeDiagnosticTail(ctx.stderrTail),
		output_tail: extra?.outputTail != null ? sanitizeDiagnosticTail(extra.outputTail) : null,
		event_count: ctx.eventCount,
		message_count: ctx.messageCount,
		turn_count: ctx.turnCount,
		tool_uses: ctx.toolUses,
		malformed_line_count: ctx.malformedLineCount,
		exit_code: ctx.exitCode,
		signal: ctx.signal,
		timed_out: ctx.timedOut,
		git_head: extra?.partialEvidence?.git_head ?? null,
		git_status: extra?.partialEvidence?.git_status ?? null,
		last_tool_action: ctx.lastToolAction,
		partial_evidence: extra?.partialEvidence ?? partialEvidence(ctx),
		report_attempted: extra?.reportAttempted ?? null,
		captured_at: new Date().toISOString(),
	};
}

/**
 * Captures observational Git evidence after activity on timeout/abort. Strictly
 * read-only: no shell, short bounded timeout, and never process-control
 * authority. Failures resolve to null rather than throwing.
 */
export async function captureObservationalGit(cwd: string): Promise<{ head: string | null; status: string | null; changedFiles: string[] }> {
	const run = (args: string[]): Promise<string | null> =>
		new Promise((resolve) => {
			execFile("git", [...OBSERVATIONAL_GIT_CONFIG_ARGS, ...args], {
				cwd,
				timeout: OBSERVATIONAL_GIT_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
				windowsHide: true,
				env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0" },
			}, (err, stdout) => {
				resolve(err ? null : stdout);
			});
		});
	const [head, status] = await Promise.all([run(["rev-parse", "HEAD"]), run(["status", "--porcelain=v1"])]);
	const safeStatus = status ? sanitizeDiagnosticTail(status) : null;
	return {
		head: head && /^[0-9a-f]{7,64}$/i.test(head.trim()) ? head.trim().slice(0, 64) : null,
		status: safeStatus,
		changedFiles: status ? changedFilesFromPorcelain(status) : [],
	};
}

function changedFilesFromPorcelain(status: string): string[] {
	const files: string[] = [];
	for (const line of status.split("\n")) {
		if (!/^[ MADRCU?!]{2} /.test(line)) continue;
		const candidate = sanitizeRepoRelativePath(line.slice(3));
		if (candidate && !files.includes(candidate) && files.length < 100) files.push(candidate);
	}
	return files;
}

function diagnosticHadActivity(terminal: LionTerminalDiagnostic): boolean {
	return Boolean((terminal.tool_uses ?? 0) > 0 || (terminal.turn_count ?? 0) > 0 || (terminal.message_count ?? 0) > 0 || (terminal.event_count ?? 0));
}

function partialEvidence(context: LionSubprocessDiagnosticContext, git?: { head: string | null; status: string | null; changedFiles: string[] }): LionPartialEvidence {
	return {
		changed_files: uniqueBounded([...context.changedFiles, ...(git?.changedFiles ?? [])]),
		tests_run: uniqueBounded(context.testsRun),
		last_tool_action: context.lastToolAction,
		git_head: git?.head ?? null,
		git_status: git?.status ?? null,
		observational: true,
	};
}

function uniqueBounded(items: string[], maximum = 100): string[] {
	const result: string[] = [];
	for (const item of items) {
		const clean = sanitizeDiagnosticTail(item, 512);
		if (clean && !result.includes(clean)) result.push(clean);
		if (result.length >= maximum) break;
	}
	return result;
}

function sanitizeRepoRelativePath(value: string): string | null {
	const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0") || normalized.length > 512) return null;
	return /^[^\x00-\x1f\x7f]+$/.test(normalized) ? normalized : null;
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

export function getProcessIdentity(pid: number): string | null {
	try {
		if (process.platform !== "linux") return null;
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const startTicks = fields[19]; // field 22 after removing pid/comm
		const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
	} catch {
		return null;
	}
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			/* fall back to direct process signal */
		}
	}
	process.kill(pid, signal);
}

export function signalOwnedProcessIfAlive(isAlive: () => boolean, signal: () => void): boolean {
	if (!isAlive()) return false;
	try {
		signal();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
		throw error;
	}
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

export interface LionProgressState {
	activeTools: string[];
	activeToolCounts: Record<string, number>;
	toolUses: number;
	turnCount: number;
	tokenTotal: number | null;
	currentText: string;
	lastTextEmitAt: number;
	includeText: boolean;
}

export function createLionProgressState(options: { includeText?: boolean } = {}): LionProgressState {
	return { activeTools: [], activeToolCounts: Object.create(null) as Record<string, number>, toolUses: 0, turnCount: 0, tokenTotal: null, currentText: "", lastTextEmitAt: 0, includeText: options.includeText ?? false };
}

export function progressFromEvent(raw: unknown, state: LionProgressState = createLionProgressState(), nowMs = Date.now()): LionProgressSnapshot | null {
	if (!isObject(raw) || typeof raw.type !== "string") return null;
	const eventType = raw.type;
	if (eventType === "tool_execution_start") {
		const tool = normalizeToolName(stringProp(raw, "toolName") ?? stringProp(raw, "tool_name") ?? stringProp(raw, "name") ?? "tool");
		incrementTool(state, tool);
		return snapshot(state, "tool_start", `running ${tool}…`, nowMs);
	}
	if (eventType === "tool_execution_end") {
		const tool = normalizeToolName(stringProp(raw, "toolName") ?? stringProp(raw, "tool_name") ?? stringProp(raw, "name") ?? state.activeTools[0] ?? "tool");
		decrementTool(state, tool);
		state.toolUses++;
		return snapshot(state, "tool_end", state.activeTools.length ? activityFromTools(state.activeTools) : `finished ${tool}`, nowMs);
	}
	if (eventType === "message_update") {
		const delta = textDelta(raw);
		if (delta && state.includeText) state.currentText = tail(state.currentText + delta);
		if (nowMs - state.lastTextEmitAt < TEXT_PROGRESS_THROTTLE_MS) return null;
		state.lastTextEmitAt = nowMs;
		return snapshot(state, "message", state.includeText ? (summarizeText(state.currentText) || "responding…") : "responding…", nowMs);
	}
	if (eventType === "message_end") {
		addUsage(state, raw.message);
		if (state.includeText && isObject(raw.message)) {
			const text = extractMessageText(raw.message);
			if (text) state.currentText = tail(text);
		}
		return snapshot(state, "message_end", state.activeTools.length ? activityFromTools(state.activeTools) : "message complete", nowMs);
	}
	if (eventType === "turn_end") {
		state.turnCount++;
		return snapshot(state, "turn_end", state.activeTools.length ? activityFromTools(state.activeTools) : `turn ${state.turnCount} complete`, nowMs);
	}
	return null;
}

function snapshot(state: LionProgressState, event: LionProgressSnapshot["event"], activity: string, nowMs = Date.now()): LionProgressSnapshot {
	return {
		event,
		activity,
		active_tools: [...state.activeTools],
		tool_uses: state.toolUses,
		turn_count: state.turnCount,
		token_total: state.tokenTotal,
		last_text: state.includeText ? (state.currentText || null) : null,
		last_event_at: new Date(nowMs).toISOString(),
	};
}

function activityFromTools(tools: string[]): string {
	return tools.length === 1 ? `running ${tools[0]}…` : `running ${tools.length} tools…`;
}

function normalizeToolName(tool: string): string {
	return tool.trim().slice(0, MAX_ACTIVE_TOOL_NAME_CHARS) || "tool";
}

function incrementTool(state: LionProgressState, tool: string): void {
	if (!(tool in state.activeToolCounts) && state.activeTools.length >= MAX_ACTIVE_TOOL_NAMES) return;
	state.activeToolCounts[tool] = (state.activeToolCounts[tool] ?? 0) + 1;
	state.activeTools = Object.entries(state.activeToolCounts).filter(([, count]) => count > 0).map(([name]) => name).slice(0, MAX_ACTIVE_TOOL_NAMES);
}

function decrementTool(state: LionProgressState, tool: string): void {
	const next = Math.max(0, (state.activeToolCounts[tool] ?? 0) - 1);
	if (next > 0) state.activeToolCounts[tool] = next;
	else delete state.activeToolCounts[tool];
	state.activeTools = Object.entries(state.activeToolCounts).filter(([, count]) => count > 0).map(([name]) => name);
}

function textDelta(raw: Record<string, unknown>): string {
	const assistantEvent = raw.assistantMessageEvent;
	if (isObject(assistantEvent) && assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") return assistantEvent.delta;
	return typeof raw.delta === "string" ? raw.delta : "";
}

function addUsage(state: LionProgressState, message: unknown): void {
	if (!isObject(message) || !isObject(message.usage)) return;
	const usage = message.usage;
	const total = numberProp(usage, "total") ?? numberProp(usage, "totalTokens") ?? (numberProp(usage, "input") ?? 0) + (numberProp(usage, "output") ?? 0) + (numberProp(usage, "cacheWrite") ?? 0);
	if (total > 0) state.tokenTotal = (state.tokenTotal ?? 0) + total;
}

function extractMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

function summarizeText(text: string): string {
	return truncateSingleLine(text, 120);
}

function tail(text: string): string {
	return text.length > MAX_PROGRESS_TEXT ? text.slice(-MAX_PROGRESS_TEXT) : text;
}

function truncateSingleLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stringProp(obj: Record<string, unknown>, key: string): string | undefined {
	return typeof obj[key] === "string" ? obj[key] as string : undefined;
}

function numberProp(obj: Record<string, unknown>, key: string): number | undefined {
	return typeof obj[key] === "number" ? obj[key] as number : undefined;
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
	const appliedSteering = (run.steering_messages ?? []).filter((m) => m.status === "applied");
	if (appliedSteering.length) {
		lines.push("", "Pre-start steering messages to incorporate before you begin:");
		for (const msg of appliedSteering) lines.push(`- ${msg.message}`);
	}
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
	// The worker contract requires its final response to be one fenced JSON
	// block. Do not salvage marker-shaped JSON from prose or earlier turns: that
	// would let stale/intermediate output claim a success after final failure.
	const fenced = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i.exec(text);
	if (!fenced?.[1]) return null;
	try {
		const parsed = JSON.parse(fenced[1]) as unknown;
		return isObject(parsed) && isObject(parsed.WORKER_REPORT) ? coerceReport(parsed.WORKER_REPORT) : null;
	} catch {
		return null;
	}
}

function coerceReport(value: unknown): LionReport | null {
	return coerceLionReport(value);
}
function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}

function appendBoundedTail(current: string, chunk: string, maximum = MAX_DIAGNOSTIC_TAIL_CHARS): string {
	if (chunk.length >= maximum) return chunk.slice(-maximum);
	const combined = current + chunk;
	return combined.length > maximum ? combined.slice(-maximum) : combined;
}

/**
 * Splits all complete NDJSON lines before bounding only the unterminated
 * remainder. A malformed oversized line must not discard a later complete
 * event received in the same stdout chunk.
 */
function consumeProtocolChunk(current: string, chunk: string, onDiscard: () => void): { lines: string[]; remainder: string } {
	const combined = current + chunk;
	const newline = combined.lastIndexOf("\n");
	if (newline < 0) {
		if (combined.length <= MAX_PROTOCOL_BUFFER_CHARS) return { lines: [], remainder: combined };
		onDiscard();
		return { lines: [], remainder: "" };
	}
	const lines: string[] = [];
	for (const line of combined.slice(0, newline).split("\n")) {
		if (line.length > MAX_PROTOCOL_BUFFER_CHARS) onDiscard();
		else lines.push(line);
	}
	const remainder = combined.slice(newline + 1);
	if (remainder.length <= MAX_PROTOCOL_BUFFER_CHARS) return { lines, remainder };
	onDiscard();
	return { lines, remainder: "" };
}

function observeStructuredToolEvidence(
	event: Record<string, unknown>,
	cwd: string,
	changedFiles: string[],
	testsRun: string[],
): void {
	if (event.type !== "tool_execution_start" || typeof event.toolName !== "string" || !isObject(event.args)) return;
	const args = event.args;
	if (event.toolName === "edit" || event.toolName === "write") {
		const suppliedPath = typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : null;
		if (suppliedPath) {
			const relative = path.isAbsolute(suppliedPath) ? path.relative(cwd, suppliedPath) : suppliedPath;
			const safePath = sanitizeRepoRelativePath(relative);
			if (safePath && !changedFiles.includes(safePath) && changedFiles.length < 100) changedFiles.push(safePath);
		}
	}
	if (event.toolName === "bash" && typeof args.command === "string") {
		const command = safeTestCommand(args.command);
		if (command && !testsRun.includes(command) && testsRun.length < 100) testsRun.push(command);
	}
}

/** Preserve only a single allowlisted test command, never arbitrary shell input or output. */
function safeTestCommand(command: string): string | null {
	const compact = command.trim();
	if (compact.length === 0 || compact.length > 512 || /[\r\n;&|`$<>]/.test(compact)) return null;
	if (!/^(?:npm\s+(?:run\s+)?test\b|pnpm\s+(?:run\s+)?test\b|yarn\s+test\b|bun\s+test\b|npx\s+vitest\b|vitest\b|node\s+--test\b)/.test(compact)) return null;
	return /^[A-Za-z0-9_./:@=, +\-[\]"']+$/.test(compact) ? compact : null;
}

export function createLionRunner(opts: LionRunnerOptions) {
	return async (req: LionRunRequest): Promise<LionRunnerOutcome> => runPiOnce(req, opts);
}

async function runPiOnce(req: LionRunRequest, opts: LionRunnerOptions): Promise<LionRunnerOutcome> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (req.run.model) args.push("--model", req.run.model);
	if (req.run.tools && req.run.tools.length > 0) args.push("--tools", req.run.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	try {
		let tmp: { dir: string; filePath: string };
		try {
			tmp = await writePromptToTempFile(req.run.agent_id, buildLionSystemPrompt(req.run));
		} catch (error) {
			throw new LionRunnerError(
				`LION subprocess setup failed: ${error instanceof Error ? error.message : String(error)}`,
				buildTerminalDiagnostic("spawn_failure", emptyDiagnosticContext()),
			);
		}
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);
		args.push(buildLionUserPrompt(req.run));

		let collection: { messages: Message[]; context: LionSubprocessDiagnosticContext };
		try {
			collection = await collectMessages(args, opts, req.signal, req.timeout_ms, req.onProgress, req.onProcessStart, req.onProcessExit, req.include_progress_text ?? false);
		} catch (err) {
			const diagErr =
				err instanceof LionRunnerError
					? err
					: new LionRunnerError(
						err instanceof Error ? err.message : String(err),
						buildTerminalDiagnostic("spawn_failure", emptyDiagnosticContext(), {}),
					);
			// On timeout/abort after activity, persist bounded observational evidence.
			if (diagErr.terminal.reason === "timeout" && diagnosticHadActivity(diagErr.terminal)) {
				const git = await captureObservationalGit(opts.cwd);
				diagErr.terminal.git_head = git.head;
				diagErr.terminal.git_status = git.status;
				diagErr.terminal.partial_evidence = partialEvidenceFromTerminal(diagErr.terminal, git);
			}
			throw diagErr;
		}
		let text: string;
		try {
			text = getFinalOutput(collection.messages);
		} catch (error) {
			throw new LionRunnerError(
				`LION final result collection failed: ${error instanceof Error ? error.message : String(error)}`,
				buildTerminalDiagnostic("result_collection_failure", collection.context),
			);
		}
		const output = boundedPersistedOutput(text);
		const report = parseLionReport(text);
		if (report) return { settlement: "settled", text: output, report, terminal: null };
		// A collected final assistant candidate that violates the strict worker
		// contract is a protocol failure. A clean close with no final candidate is
		// a collection failure; neither may resolve as completed.
		const reason: LionTerminalDiagnosticReason = text.trim() ? "protocol_parse_failure" : "result_collection_failure";
		const terminal = buildTerminalDiagnostic(reason, collection.context, {
			outputTail: text,
			reportAttempted: text.trim().length > 0,
			partialEvidence: partialEvidence(collection.context),
		});
		return { settlement: "settled", text: output, report: null, terminal };
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

function partialEvidenceFromTerminal(terminal: LionTerminalDiagnostic, git: { head: string | null; status: string | null; changedFiles: string[] }): LionPartialEvidence {
	return {
		changed_files: uniqueBounded([...(terminal.partial_evidence?.changed_files ?? []), ...git.changedFiles]),
		tests_run: terminal.partial_evidence?.tests_run ?? [],
		last_tool_action: terminal.last_tool_action,
		git_head: git.head,
		git_status: git.status,
		observational: true,
	};
}

function emptyDiagnosticContext(): LionSubprocessDiagnosticContext {
	return { stdoutTail: "", stderrTail: "", eventCount: 0, malformedLineCount: 0, turnCount: 0, toolUses: 0, messageCount: 0, exitCode: null, signal: null, timedOut: false, lastToolAction: null, changedFiles: [], testsRun: [] };
}

function collectMessages(
	args: string[],
	opts: LionRunnerOptions,
	signal?: AbortSignal,
	timeout_ms = 10 * 60_000,
	onProgress?: (progress: LionProgressSnapshot) => void,
	onProcessStart?: (info: LionProcessInfo) => void,
	onProcessExit?: () => void,
	includeProgressText = false,
): Promise<{ messages: Message[]; context: LionSubprocessDiagnosticContext }> {
	return new Promise((resolve, reject) => {
		const invocation = getPiInvocation([...args, ...(opts.extraArgs ?? [])], { forceBinary: opts.forcePiBinary });
		const detached = process.platform !== "win32";
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			detached,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let aborted = false;
		let exitCode: number | null = null;
		let signalCode: string | null = null;
		const processIsAlive = () => proc.exitCode === null && proc.signalCode === null && Boolean(proc.pid && isPidAlive(proc.pid));
		const cancelOwnedProcess = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
			if (!proc.pid) return false;
			const delivered = signalOwnedProcessIfAlive(processIsAlive, () => signalProcessTree(proc.pid!, signal));
			if (delivered) aborted = true;
			return delivered;
		};
		if (proc.pid) {
			try { onProcessStart?.({ pid: proc.pid, pgid: detached ? proc.pid : null, process_identity: getProcessIdentity(proc.pid), cancel: cancelOwnedProcess, isAlive: processIsAlive }); } catch { /* control metadata is best-effort */ }
		}

		const messages: Message[] = [];
		let buffer = "";
		let stderr = "";
		let stdoutRaw = "";
		let eventCount = 0;
		let malformedLineCount = 0;
		let lastToolAction: string | null = null;
		const changedFiles: string[] = [];
		const testsRun: string[] = [];
		let settled = false;
		const progressState = createLionProgressState({ includeText: includeProgressText });

		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		const buildContext = (timedOutFlag: boolean): LionSubprocessDiagnosticContext => ({
			stdoutTail: stdoutRaw,
			stderrTail: stderr,
			eventCount,
			malformedLineCount,
			turnCount: progressState.turnCount,
			toolUses: progressState.toolUses,
			messageCount: messages.length,
			exitCode,
			signal: signalCode,
			timedOut: timedOutFlag,
			lastToolAction,
			changedFiles: [...changedFiles],
			testsRun: [...testsRun],
		});

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as { type?: string; message?: Message };
				eventCount++;
				observeStructuredToolEvidence(event as Record<string, unknown>, opts.cwd, changedFiles, testsRun);
				const progress = progressFromEvent(event, progressState);
				if (progress) {
					if (progress.event === "tool_start" || progress.event === "tool_end") lastToolAction = progress.activity;
					try { onProgress?.(progress); } catch { /* progress callbacks must not break message collection */ }
				}
				if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message);
			} catch {
				malformedLineCount++;
			}
		};

		const killProc = (reason: string) => {
			aborted = true;
			try { cancelOwnedProcess("SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* ignore */ } }
			setTimeout(() => {
				try { cancelOwnedProcess("SIGKILL"); } catch { try { if (processIsAlive()) proc.kill("SIGKILL"); } catch { /* ignore */ } }
			}, 5000);
			return reason;
		};

		const timer = setTimeout(() => killProc(`LION subprocess timed out after ${timeout_ms}ms`), timeout_ms);

		proc.stdout.on("data", (data) => {
			const chunk = data.toString();
			stdoutRaw = appendBoundedTail(stdoutRaw, chunk);
			const protocol = consumeProtocolChunk(buffer, chunk, () => { malformedLineCount++; });
			buffer = protocol.remainder;
			for (const line of protocol.lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr = appendBoundedTail(stderr, data.toString());
		});
		let processExitNotified = false;
		const notifyProcessExit = () => {
			if (processExitNotified) return;
			processExitNotified = true;
			try { onProcessExit?.(); } catch { /* best effort */ }
		};
		proc.on("error", (err) => {
			notifyProcessExit();
			done(() => reject(new LionRunnerError(
				err instanceof Error ? err.message : String(err),
				buildTerminalDiagnostic("spawn_failure", buildContext(false)),
			)));
		});
		proc.on("close", (code, closeSignal) => {
			notifyProcessExit();
			exitCode = code ?? null;
			signalCode = closeSignal ?? null;
			if (buffer.trim()) processLine(buffer);
			if (aborted) {
				return done(() => reject(new LionRunnerError(
					`LION subprocess was aborted or timed out after ${timeout_ms}ms`,
					buildTerminalDiagnostic("timeout", buildContext(true)),
				)));
			}
			if (closeSignal || (code !== null && code !== 0)) {
				const exitDescription = closeSignal ? `signal ${closeSignal}` : `code ${code}`;
				return done(() => reject(new LionRunnerError(
					`LION subprocess exited abnormally (${exitDescription})`,
					buildTerminalDiagnostic("model_exit", buildContext(false)),
				)));
			}
			if (messages.length === 0 && stderr.trim()) {
				return done(() => reject(new LionRunnerError(
					`LION subprocess produced no output. stderr: ${stderr.trim().slice(0, 1000)}`,
					buildTerminalDiagnostic("result_collection_failure", buildContext(false)),
				)));
			}
			done(() => resolve({ messages, context: buildContext(false) }));
		});

		if (signal) {
			if (signal.aborted) killProc("aborted");
			else signal.addEventListener("abort", () => killProc("aborted"), { once: true });
		}
	});
}
