/**
 * LION — pure run ledger.
 *
 * No filesystem or pi subprocess logic here. This module handles ids, run
 * lifecycle, summaries, and JSON coercion so it is easy to test and reuse by
 * CEREBEL later.
 */

import { randomUUID } from "node:crypto";
import {
	LION_CANCEL_DELIVERY_STATUSES,
	LION_PROGRESS_EVENTS,
	LION_RUN_STATUSES,
	LionError,
	LION_STEERING_STATUSES,
	type LionFile,
	type LionModelRole,
	type LionProgressEvent,
	type LionRunnerMode,
	type LionCancelDeliveryStatus,
	type LionControlState,
	type LionProgressSnapshot,
	type LionReport,
	type LionRun,
	type LionSteeringMessage,
	type LionRunStatus,
	type LionSummary,
} from "./schema.ts";
import { MAX_PROGRESS_TEXT } from "./lifecycle.ts";

const VERSION = 1;

const STATUS_SET = new Set<string>(LION_RUN_STATUSES);
const PROGRESS_EVENT_SET = new Set<string>(LION_PROGRESS_EVENTS);
const CANCEL_DELIVERY_STATUS_SET = new Set<string>(LION_CANCEL_DELIVERY_STATUSES);
const STEERING_STATUS_SET = new Set<string>(LION_STEERING_STATUSES);
const DEFAULT_RECONCILE_GRACE_MS = 30_000;
const MAX_STEERING_MESSAGE_CHARS = 4_000;
const MAX_OPEN_STEERING_MESSAGES = 100;
const MAX_TERMINAL_STEERING_HISTORY = 100;
const OPEN_STEERING_STATUSES = new Set<LionSteeringMessage["status"]>(["queued", "pending_delivery", "delivering"]);

function now(): string {
	return new Date().toISOString();
}

function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x)) as T;
}

function normalizeStringList(xs: unknown): string[] {
	return Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [];
}

export function canTransition(from: LionRunStatus, to: LionRunStatus): boolean {
	if (from === to) return true;
	if (from === "queued") return to === "running" || to === "aborted";
	if (from === "running") return to === "completed" || to === "blocked" || to === "failed" || to === "aborted";
	return false;
}

export interface CreateRunInput {
	agent_id?: string;
	task_id?: string | null;
	objective: string;
	context?: string;
	model?: string | null;
	model_role?: LionModelRole | null;
	runner_mode?: LionRunnerMode | null;
	tools?: string[] | null;
	start?: boolean;
}

export interface FinishRunInput {
	output: string;
	report?: LionReport | null;
	status?: LionRunStatus;
	error?: string | null;
}

export type UpdateProgressInput = Partial<Omit<LionProgressSnapshot, "last_event_at">> & {
	last_event_at?: string;
};

export type UpdateControlInput = Partial<LionControlState>;

export interface CancelRunResult {
	run: LionRun;
	signal?: "SIGTERM";
	pid?: number;
	pgid?: number | null;
	already_terminal?: boolean;
}

export interface ReconcileControlsOptions {
	active_run_refs?: Iterable<Pick<LionRun, "id" | "incarnation_id">>;
	now_ms?: number;
	stale_after_ms?: number;
	/** Observational lookup only; never signaling authority. Null means unverifiable. */
	get_process_identity?: (pid: number) => string | null;
}

export interface SteerRunResult {
	run: LionRun;
	message: LionSteeringMessage;
	accepted: boolean;
}

export interface SteerRunOptions {
	liveDeliveryAvailable?: boolean;
	reason?: string | null;
}

export interface ListFilter {
	status?: LionRunStatus;
	agent_id?: string;
	task_id?: string;
	limit?: number;
}

export class LionLedger {
	readonly project?: string;
	private runsById: Map<string, LionRun>;

	constructor(project?: string, runs: LionRun[] = []) {
		this.project = project;
		this.runsById = new Map(runs.map((r) => [r.id, clone(r)]));
	}

	create(input: CreateRunInput): LionRun {
		const objective = (input.objective ?? "").trim();
		if (!objective && !input.task_id) throw new LionError("invalid_arg", "run requires objective or task_id");
		const id = this.nextId();
		const ts = now();
		const run: LionRun = {
			id,
			incarnation_id: randomUUID(),
			agent_id: (input.agent_id?.trim() || `lion-${id.replace(/^run-/, "")}`).toLowerCase(),
			status: input.start === false ? "queued" : "running",
			task_id: input.task_id ?? null,
			objective: objective || `Work AXON task ${input.task_id}`,
			context: input.context ?? "",
			model: input.model ?? null,
			model_role: input.model_role ?? null,
			runner_mode: input.runner_mode ?? "json",
			tools: input.tools ? [...input.tools] : null,
			started_at: ts,
			updated_at: ts,
			finished_at: null,
			duration_ms: null,
			output: null,
			report: null,
			progress: null,
			control: null,
			steering_messages: [],
			error: null,
		};
		this.runsById.set(id, run);
		return clone(run);
	}

	start(id: string): LionRun {
		const r = this.require(id);
		if (r.status !== "queued") throw new LionError("invalid_transition", `cannot start ${r.id} from ${r.status}`);
		this.transition(r, "running");
		const ts = now();
		for (const msg of r.steering_messages ?? []) {
			if (msg.status === "queued") {
				msg.status = "applied";
				msg.applied_at = ts;
			}
		}
		r.started_at = ts;
		r.updated_at = ts;
		return clone(r);
	}

	finish(id: string, input: FinishRunInput): LionRun {
		const r = this.require(id);
		const status = input.status ?? statusFromReport(input.report, input.error);
		this.transition(r, status);
		const ts = now();
		this.failOpenSteeringForRun(r, `run finalized as ${status}`, ts);
		r.output = input.output;
		r.report = input.report ?? null;
		r.error = input.error ?? null;
		r.finished_at = ts;
		r.updated_at = ts;
		r.duration_ms = Math.max(0, Date.parse(ts) - Date.parse(r.started_at));
		return clone(r);
	}

	updateProgress(id: string, input: UpdateProgressInput): LionRun {
		const r = this.require(id);
		if (r.status !== "running" && r.status !== "queued") {
			throw new LionError("invalid_transition", `cannot update progress for ${r.id} while ${r.status}`);
		}
		const previous = r.progress ?? defaultProgress();
		const ts = input.last_event_at ?? now();
		r.progress = {
			event: isProgressEvent(input.event) ? input.event : previous.event,
			activity: trimText(input.activity ?? previous.activity),
			active_tools: input.active_tools ? normalizeStringList(input.active_tools) : previous.active_tools,
			tool_uses: typeof input.tool_uses === "number" ? Math.max(0, Math.floor(input.tool_uses)) : previous.tool_uses,
			turn_count: typeof input.turn_count === "number" ? Math.max(0, Math.floor(input.turn_count)) : previous.turn_count,
			token_total: typeof input.token_total === "number" ? Math.max(0, Math.floor(input.token_total)) : (input.token_total === null ? null : previous.token_total),
			last_text: typeof input.last_text === "string" ? trimText(input.last_text) : (input.last_text === null ? null : previous.last_text),
			last_event_at: ts,
		};
		r.updated_at = ts;
		return clone(r);
	}

	updateProgressIfCurrent(id: string, incarnationId: string | null | undefined, input: UpdateProgressInput): { run: LionRun | undefined; committed: boolean } {
		const current = this.runsById.get(id);
		if (!current || (current.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: current ? clone(current) : undefined, committed: false };
		return { run: this.updateProgress(id, input), committed: true };
	}

	updateControl(id: string, input: UpdateControlInput): LionRun {
		const r = this.require(id);
		if (r.status !== "running" && r.status !== "queued") throw new LionError("invalid_transition", `cannot update control for ${r.id} while ${r.status}`);
		const ts = now();
		r.control = { ...(r.control ?? {}), ...input, last_seen_at: input.last_seen_at ?? ts };
		r.updated_at = ts;
		return clone(r);
	}

	requestCancel(id: string, reason?: string | null): CancelRunResult {
		const r = this.require(id);
		const ts = now();
		if (["completed", "blocked", "failed", "aborted"].includes(r.status)) {
			return { run: clone(r), already_terminal: true };
		}
		const deliveryStatus = r.control?.cancel_delivery_status === "delivered"
			? "delivered"
			: r.status === "running" ? "requested" : "not_needed";
		r.control = { ...(r.control ?? {}), cancel_requested_at: r.control?.cancel_requested_at ?? ts, cancel_reason: reason ?? r.control?.cancel_reason ?? null, cancel_signal: "SIGTERM", cancel_delivery_status: deliveryStatus, last_seen_at: r.control?.last_seen_at ?? null };
		if (r.status === "queued") {
			this.transition(r, "aborted");
			this.failOpenSteeringForRun(r, "run cancelled before queued steering could be applied", ts);
			r.error = reason ? `Cancelled before start: ${reason}` : "Cancelled before start";
			r.finished_at = ts;
			r.duration_ms = Math.max(0, Date.parse(ts) - Date.parse(r.started_at));
		}
		r.updated_at = ts;
		return { run: clone(r), signal: r.status === "running" ? "SIGTERM" : undefined, pid: r.control.pid ?? undefined, pgid: r.control.pgid ?? null };
	}

	markCancelDelivery(id: string, status: LionCancelDeliveryStatus, error?: string | null): LionRun {
		const r = this.require(id);
		if (r.control?.cancel_delivery_status === "delivered" && status !== "delivered") return clone(r);
		const ts = now();
		r.control = {
			...(r.control ?? {}),
			cancel_delivery_status: status,
			cancel_delivered_at: status === "delivered" ? ts : r.control?.cancel_delivered_at ?? null,
			cancel_delivery_error: status === "delivered" ? null : error ?? status,
			last_seen_at: r.control?.last_seen_at ?? null,
		};
		r.updated_at = ts;
		return clone(r);
	}

	markCancelDeliveryIfCurrent(id: string, incarnationId: string | null | undefined, status: LionCancelDeliveryStatus, error?: string | null): { run: LionRun; committed: boolean } {
		const r = this.require(id);
		if ((r.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: clone(r), committed: false };
		return { run: this.markCancelDelivery(id, status, error), committed: true };
	}

	steer(id: string, message: string, options: SteerRunOptions = {}): SteerRunResult {
		const r = this.require(id);
		const text = message.trim().slice(0, MAX_STEERING_MESSAGE_CHARS);
		if (!text) throw new LionError("invalid_arg", "steer requires non-empty message");
		const ts = now();
		const msg: LionSteeringMessage = {
			id: this.nextSteeringId(r),
			message: text,
			status: "queued",
			created_at: ts,
			applied_at: null,
			delivery_attempted_at: null,
			delivered_at: null,
			rejected_at: null,
			reason: null,
		};
		if (r.status === "running") {
			if (options.liveDeliveryAvailable && r.runner_mode === "rpc") {
				msg.status = "pending_delivery";
				msg.reason = options.reason ?? "queued for live RPC delivery";
			} else {
				msg.status = "rejected_running";
				msg.rejected_at = ts;
				msg.reason = options.reason ?? (r.runner_mode === "rpc" ? "rpc steering channel is not attached to a live worker" : "running json subprocess backend does not support live steering");
			}
		} else if (r.status !== "queued") {
			msg.status = "rejected_terminal";
			msg.rejected_at = ts;
			msg.reason = options.reason ?? `cannot steer terminal run ${r.status}`;
		}
		r.steering_messages ??= [];
		if (OPEN_STEERING_STATUSES.has(msg.status) && r.steering_messages.filter((entry) => OPEN_STEERING_STATUSES.has(entry.status)).length >= MAX_OPEN_STEERING_MESSAGES) {
			throw new LionError("invalid_arg", `run ${r.id} already has the maximum ${MAX_OPEN_STEERING_MESSAGES} open steering messages`);
		}
		r.steering_messages.push(msg);
		this.compactSteeringHistory(r);
		r.updated_at = ts;
		return { run: clone(r), message: clone(msg), accepted: msg.status === "queued" || msg.status === "pending_delivery" };
	}

	hasPendingSteering(id: string): boolean {
		const r = this.require(id);
		return r.status === "running" && r.runner_mode === "rpc" && (r.steering_messages ?? []).some((msg) => msg.status === "pending_delivery");
	}

	hasPendingSteeringIfCurrent(id: string, incarnationId: string | null | undefined): boolean {
		const r = this.runsById.get(id);
		return Boolean(r && (r.incarnation_id ?? null) === (incarnationId ?? null) && r.status === "running" && r.runner_mode === "rpc" && (r.steering_messages ?? []).some((msg) => msg.status === "pending_delivery"));
	}

	reservePendingSteering(id: string, limit = 10): LionSteeringMessage[] {
		const r = this.require(id);
		if (r.status !== "running" || r.runner_mode !== "rpc") return [];
		const ts = now();
		const out: LionSteeringMessage[] = [];
		for (const msg of r.steering_messages ?? []) {
			if (msg.status !== "pending_delivery") continue;
			msg.status = "delivering";
			msg.delivery_attempted_at = ts;
			msg.reason = "delivering via RPC steer";
			out.push(clone(msg));
			if (out.length >= limit) break;
		}
		if (out.length) r.updated_at = ts;
		return out;
	}

	reservePendingSteeringIfCurrent(id: string, incarnationId: string | null | undefined, limit = 10): LionSteeringMessage[] {
		const r = this.runsById.get(id);
		if (!r || (r.incarnation_id ?? null) !== (incarnationId ?? null)) return [];
		return this.reservePendingSteering(id, limit);
	}

	markSteeringDelivered(id: string, steeringId: string): LionRun {
		const r = this.require(id);
		const msg = this.requireSteering(r, steeringId);
		const ts = now();
		msg.status = "delivered";
		msg.delivered_at = ts;
		msg.reason = "delivered via RPC steer";
		this.compactSteeringHistory(r);
		r.updated_at = ts;
		return clone(r);
	}

	markSteeringDeliveredIfCurrent(id: string, incarnationId: string | null | undefined, steeringId: string): { run: LionRun | undefined; committed: boolean } {
		const r = this.runsById.get(id);
		if (!r || (r.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: r ? clone(r) : undefined, committed: false };
		return { run: this.markSteeringDelivered(id, steeringId), committed: true };
	}

	markSteeringFailed(id: string, steeringId: string, reason: string): LionRun {
		const r = this.require(id);
		const msg = this.requireSteering(r, steeringId);
		const ts = now();
		msg.status = "delivery_failed";
		msg.rejected_at = ts;
		msg.reason = reason;
		this.compactSteeringHistory(r);
		r.updated_at = ts;
		return clone(r);
	}

	markSteeringFailedIfCurrent(id: string, incarnationId: string | null | undefined, steeringId: string, reason: string): { run: LionRun | undefined; committed: boolean } {
		const r = this.runsById.get(id);
		if (!r || (r.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: r ? clone(r) : undefined, committed: false };
		return { run: this.markSteeringFailed(id, steeringId, reason), committed: true };
	}

	settleSteeringBatchIfCurrent(id: string, incarnationId: string | null | undefined, outcomes: Array<{ steering_id: string; delivered: boolean; reason?: string }>): { run: LionRun | undefined; committed: boolean } {
		const r = this.runsById.get(id);
		if (!r || (r.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: r ? clone(r) : undefined, committed: false };
		const ts = now();
		for (const outcome of outcomes) {
			const msg = this.requireSteering(r, outcome.steering_id);
			if (outcome.delivered) {
				msg.status = "delivered";
				msg.delivered_at = ts;
				msg.reason = "delivered via RPC steer";
			} else {
				msg.status = "delivery_failed";
				msg.rejected_at = ts;
				msg.reason = outcome.reason ?? "RPC steer failed";
			}
		}
		if (outcomes.length) {
			this.compactSteeringHistory(r);
			r.updated_at = ts;
		}
		return { run: clone(r), committed: true };
	}

	failOpenSteering(id: string, reason: string): LionRun {
		const r = this.require(id);
		const ts = now();
		if (this.failOpenSteeringForRun(r, reason, ts)) r.updated_at = ts;
		return clone(r);
	}

	failOpenSteeringIfCurrent(id: string, incarnationId: string | null | undefined, reason: string): { run: LionRun | undefined; committed: boolean } {
		const r = this.runsById.get(id);
		if (!r || (r.incarnation_id ?? null) !== (incarnationId ?? null)) return { run: r ? clone(r) : undefined, committed: false };
		return { run: this.failOpenSteering(id, reason), committed: true };
	}

	reconcileControls(isAlive: (pid: number) => boolean, options: ReconcileControlsOptions = {}): LionRun[] {
		const changed: LionRun[] = [];
		const active = new Set(Array.from(options.active_run_refs ?? [], (ref) => JSON.stringify([ref.id, ref.incarnation_id ?? null])));
		const nowMs = options.now_ms ?? Date.now();
		const staleAfterMs = options.stale_after_ms ?? DEFAULT_RECONCILE_GRACE_MS;
		for (const r of this.runsById.values()) {
			if (r.status !== "running") continue;
			if (active.has(JSON.stringify([r.id, r.incarnation_id ?? null]))) continue;
			if (!isReconcileStale(r, nowMs, staleAfterMs)) continue;
			const pid = r.control?.pid;
			if (typeof pid === "number" && isAlive(pid)) {
				const expectedIdentity = r.control?.process_identity;
				const observedIdentity = expectedIdentity && options.get_process_identity ? options.get_process_identity(pid) : null;
				if (!expectedIdentity || !observedIdentity || observedIdentity === expectedIdentity) continue;
				// Same numeric PID now belongs to another process. This proves the
				// original child is gone, but never grants authority over the replacement.
			}
			const ts = new Date(nowMs).toISOString();
			const terminalStatus = r.control?.cancel_requested_at ? "aborted" : "failed";
			this.transition(r, terminalStatus);
			this.failOpenSteeringForRun(r, `run reconciled as ${terminalStatus}`, ts);
			r.error = r.control?.cancel_requested_at
				? (r.control.cancel_reason ? `Cancelled: ${r.control.cancel_reason}` : "Cancelled")
				: typeof pid === "number" ? "Subprocess is no longer running" : "Active owner was lost before process metadata attached";
			r.finished_at = ts;
			r.updated_at = ts;
			r.duration_ms = Math.max(0, Date.parse(ts) - Date.parse(r.started_at));
			r.control = { ...(r.control ?? {}), reconciled_at: ts, last_seen_at: ts };
			changed.push(clone(r));
		}
		return changed;
	}

	delete(id: string): LionRun {
		const r = this.require(id);
		if (r.status === "queued" || r.status === "running") {
			throw new LionError("invalid_transition", `cannot delete nonterminal run ${r.id} while ${r.status}`);
		}
		this.runsById.delete(id);
		return clone(r);
	}

	get(id: string): LionRun | undefined {
		const r = this.runsById.get(id);
		return r ? clone(r) : undefined;
	}

	all(): LionRun[] {
		return Array.from(this.runsById.values())
			.map(clone)
			.sort((a, b) => b.started_at.localeCompare(a.started_at));
	}

	list(filter: ListFilter = {}): LionRun[] {
		let runs = this.all();
		if (filter.status) runs = runs.filter((r) => r.status === filter.status);
		if (filter.agent_id) runs = runs.filter((r) => r.agent_id === filter.agent_id);
		if (filter.task_id) runs = runs.filter((r) => r.task_id === filter.task_id);
		const limit = filter.limit ?? 20;
		return limit > 0 ? runs.slice(0, limit) : runs;
	}

	summary(limit = 10): LionSummary {
		const all = this.all();
		const by_status: Partial<Record<LionRunStatus, number>> = {};
		for (const r of all) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
		return {
			total: all.length,
			by_status,
			running: all.filter((r) => r.status === "running" || r.status === "queued"),
			recent: limit > 0 ? all.slice(0, limit) : all,
		};
	}

	toJSON(): LionFile {
		const ts = now();
		const runs: Record<string, LionRun> = {};
		for (const r of this.runsById.values()) runs[r.id] = clone(r);
		return { version: VERSION, project: this.project, updated_at: ts, runs };
	}

	static fromJSON(raw: unknown): LionLedger {
		const obj = isObject(raw) ? raw : {};
		const runsObj = isObject(obj.runs) ? obj.runs : {};
		const runs: LionRun[] = [];
		for (const [id, value] of Object.entries(runsObj)) {
			const r = coerceRun(id, value);
			if (r) runs.push(r);
		}
		return new LionLedger(typeof obj.project === "string" ? obj.project : undefined, runs);
	}

	private require(id: string): LionRun {
		const r = this.runsById.get(id);
		if (!r) throw new LionError("not_found", `run ${id} not found`);
		return r;
	}

	private compactSteeringHistory(run: LionRun): void {
		const messages = run.steering_messages ?? [];
		const open = messages.filter((message) => OPEN_STEERING_STATUSES.has(message.status));
		const terminal = messages.filter((message) => !OPEN_STEERING_STATUSES.has(message.status));
		run.steering_messages = [...terminal.slice(-MAX_TERMINAL_STEERING_HISTORY), ...open];
	}

	private requireSteering(run: LionRun, steeringId: string): LionSteeringMessage {
		const msg = (run.steering_messages ?? []).find((m) => m.id === steeringId);
		if (!msg) throw new LionError("not_found", `steering message ${steeringId} not found on ${run.id}`);
		return msg;
	}

	private failOpenSteeringForRun(run: LionRun, reason: string, ts: string): boolean {
		let changed = false;
		for (const msg of run.steering_messages ?? []) {
			if (!OPEN_STEERING_STATUSES.has(msg.status)) continue;
			msg.status = "delivery_failed";
			msg.rejected_at = ts;
			msg.reason = reason;
			changed = true;
		}
		if (changed) this.compactSteeringHistory(run);
		return changed;
	}

	private transition(r: LionRun, to: LionRunStatus): void {
		if (!canTransition(r.status, to)) {
			throw new LionError("invalid_transition", `cannot transition ${r.id} from ${r.status} to ${to}`);
		}
		r.status = to;
	}

	private nextSteeringId(run: LionRun): string {
		let max = 0;
		for (const msg of run.steering_messages ?? []) {
			const m = /^steer-(\d+)$/.exec(msg.id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return `steer-${String(max + 1).padStart(3, "0")}`;
	}

	private nextId(): string {
		let max = 0;
		for (const id of this.runsById.keys()) {
			const m = /^run-(\d+)$/.exec(id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return `run-${String(max + 1).padStart(3, "0")}`;
	}
}

function statusFromReport(report: LionReport | null | undefined, error?: string | null): LionRunStatus {
	if (error) return "failed";
	if (!report) return "completed";
	if (report.outcome === "completed" || report.outcome === "partial") return "completed";
	if (report.outcome === "blocked") return "blocked";
	return "failed";
}

function isModelRole(value: unknown): value is LionModelRole {
	return value === "implementation" || value === "review" || value === "default";
}

function isRunnerMode(value: unknown): value is LionRunnerMode {
	return value === "json" || value === "rpc";
}

function isProgressEvent(value: unknown): value is LionProgressEvent {
	return typeof value === "string" && PROGRESS_EVENT_SET.has(value);
}

function trimText(value: string): string {
	return value.length > MAX_PROGRESS_TEXT ? value.slice(-MAX_PROGRESS_TEXT) : value;
}

function isReconcileStale(run: LionRun, nowMs: number, staleAfterMs: number): boolean {
	// Cancellation and ledger bookkeeping are not owner heartbeats. Using updated_at
	// here lets repeated control requests postpone owner-loss reconciliation forever.
	const candidates = [run.control?.last_seen_at, run.started_at]
		.filter((value): value is string => typeof value === "string")
		.map((value) => Date.parse(value))
		.filter((value) => Number.isFinite(value));
	const newest = candidates.length ? Math.max(...candidates) : 0;
	return nowMs - newest >= staleAfterMs;
}

function defaultProgress(): LionProgressSnapshot {
	return {
		event: "heartbeat",
		activity: "running…",
		active_tools: [],
		tool_uses: 0,
		turn_count: 0,
		token_total: null,
		last_text: null,
		last_event_at: now(),
	};
}

function coerceRun(id: string, value: unknown): LionRun | null {
	if (!isObject(value)) return null;
	const status = typeof value.status === "string" && STATUS_SET.has(value.status) ? (value.status as LionRunStatus) : "failed";
	const started = typeof value.started_at === "string" ? value.started_at : now();
	const updated = typeof value.updated_at === "string" ? value.updated_at : started;
	return {
		id: typeof value.id === "string" ? value.id : id,
		incarnation_id: typeof value.incarnation_id === "string" ? value.incarnation_id : null,
		agent_id: typeof value.agent_id === "string" ? value.agent_id : "lion-unknown",
		status,
		task_id: typeof value.task_id === "string" ? value.task_id : null,
		objective: typeof value.objective === "string" ? value.objective : "",
		context: typeof value.context === "string" ? value.context : "",
		model: typeof value.model === "string" ? value.model : null,
		model_role: isModelRole(value.model_role) ? value.model_role : null,
		runner_mode: isRunnerMode(value.runner_mode) ? value.runner_mode : "json",
		tools: Array.isArray(value.tools) ? normalizeStringList(value.tools) : null,
		started_at: started,
		updated_at: updated,
		finished_at: typeof value.finished_at === "string" ? value.finished_at : null,
		duration_ms: typeof value.duration_ms === "number" ? value.duration_ms : null,
		output: typeof value.output === "string" ? value.output : null,
		report: coerceReport(value.report),
		progress: coerceProgress(value.progress),
		control: coerceControl(value.control),
		steering_messages: Array.isArray(value.steering_messages) ? value.steering_messages.map(coerceSteering).filter((x): x is LionSteeringMessage => Boolean(x)) : [],
		error: typeof value.error === "string" ? value.error : null,
	};
}

function coerceReport(value: unknown): LionReport | null {
	if (!isObject(value)) return null;
	const outcome = ["completed", "blocked", "failed", "partial"].includes(String(value.outcome))
		? (value.outcome as LionReport["outcome"])
		: "failed";
	return {
		outcome,
		summary: typeof value.summary === "string" ? value.summary : "",
		changed_files: normalizeStringList(value.changed_files),
		tests_run: normalizeStringList(value.tests_run),
		blockers: normalizeStringList(value.blockers),
		next_steps: normalizeStringList(value.next_steps),
		notes: typeof value.notes === "string" ? value.notes : undefined,
	};
}

function coerceProgress(value: unknown): LionProgressSnapshot | null {
	if (!isObject(value)) return null;
	return {
		event: isProgressEvent(value.event) ? value.event : "heartbeat",
		activity: typeof value.activity === "string" ? trimText(value.activity) : "running…",
		active_tools: normalizeStringList(value.active_tools),
		tool_uses: typeof value.tool_uses === "number" ? Math.max(0, Math.floor(value.tool_uses)) : 0,
		turn_count: typeof value.turn_count === "number" ? Math.max(0, Math.floor(value.turn_count)) : 0,
		token_total: typeof value.token_total === "number" ? Math.max(0, Math.floor(value.token_total)) : null,
		last_text: typeof value.last_text === "string" ? trimText(value.last_text) : null,
		last_event_at: typeof value.last_event_at === "string" ? value.last_event_at : now(),
	};
}

function coerceControl(value: unknown): LionControlState | null {
	if (!isObject(value)) return null;
	return {
		pid: typeof value.pid === "number" ? Math.floor(value.pid) : null,
		pgid: typeof value.pgid === "number" ? Math.floor(value.pgid) : null,
		process_identity: typeof value.process_identity === "string" ? value.process_identity : null,
		started_at: typeof value.started_at === "string" ? value.started_at : null,
		last_seen_at: typeof value.last_seen_at === "string" ? value.last_seen_at : null,
		cancel_requested_at: typeof value.cancel_requested_at === "string" ? value.cancel_requested_at : null,
		cancel_reason: typeof value.cancel_reason === "string" ? value.cancel_reason : null,
		cancel_signal: typeof value.cancel_signal === "string" ? value.cancel_signal : null,
		cancel_delivery_status: typeof value.cancel_delivery_status === "string" && CANCEL_DELIVERY_STATUS_SET.has(value.cancel_delivery_status) ? value.cancel_delivery_status as LionCancelDeliveryStatus : null,
		cancel_delivered_at: typeof value.cancel_delivered_at === "string" ? value.cancel_delivered_at : null,
		cancel_delivery_error: typeof value.cancel_delivery_error === "string" ? value.cancel_delivery_error : null,
		reconciled_at: typeof value.reconciled_at === "string" ? value.reconciled_at : null,
	};
}

function coerceSteering(value: unknown): LionSteeringMessage | null {
	if (!isObject(value) || typeof value.message !== "string") return null;
	const status = typeof value.status === "string" && STEERING_STATUS_SET.has(value.status) ? value.status as LionSteeringMessage["status"] : "rejected_terminal";
	return {
		id: typeof value.id === "string" ? value.id : "steer-unknown",
		message: value.message,
		status,
		created_at: typeof value.created_at === "string" ? value.created_at : now(),
		applied_at: typeof value.applied_at === "string" ? value.applied_at : null,
		delivery_attempted_at: typeof value.delivery_attempted_at === "string" ? value.delivery_attempted_at : null,
		delivered_at: typeof value.delivered_at === "string" ? value.delivered_at : null,
		rejected_at: typeof value.rejected_at === "string" ? value.rejected_at : null,
		reason: typeof value.reason === "string" ? value.reason : null,
	};
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}
