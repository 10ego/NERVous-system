/**
 * LION — pure run ledger.
 *
 * No filesystem or pi subprocess logic here. This module handles ids, run
 * lifecycle, summaries, and JSON coercion so it is easy to test and reuse by
 * CEREBEL later.
 */

import {
	LION_PROGRESS_EVENTS,
	LION_RUN_STATUSES,
	LionError,
	type LionFile,
	type LionModelRole,
	type LionProgressEvent,
	type LionProgressSnapshot,
	type LionReport,
	type LionRun,
	type LionRunStatus,
	type LionSummary,
} from "./schema.ts";

const VERSION = 1;

const STATUS_SET = new Set<string>(LION_RUN_STATUSES);
const PROGRESS_EVENT_SET = new Set<string>(LION_PROGRESS_EVENTS);
const MAX_PROGRESS_TEXT = 1000;

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
			agent_id: (input.agent_id?.trim() || `lion-${id.replace(/^run-/, "")}`).toLowerCase(),
			status: input.start === false ? "queued" : "running",
			task_id: input.task_id ?? null,
			objective: objective || `Work AXON task ${input.task_id}`,
			context: input.context ?? "",
			model: input.model ?? null,
			model_role: input.model_role ?? null,
			tools: input.tools ? [...input.tools] : null,
			started_at: ts,
			updated_at: ts,
			finished_at: null,
			duration_ms: null,
			output: null,
			report: null,
			progress: null,
			error: null,
		};
		this.runsById.set(id, run);
		return clone(run);
	}

	start(id: string): LionRun {
		const r = this.require(id);
		this.transition(r, "running");
		r.updated_at = now();
		return clone(r);
	}

	finish(id: string, input: FinishRunInput): LionRun {
		const r = this.require(id);
		const status = input.status ?? statusFromReport(input.report, input.error);
		this.transition(r, status);
		const ts = now();
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

	delete(id: string): LionRun {
		const r = this.require(id);
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

	private transition(r: LionRun, to: LionRunStatus): void {
		if (!canTransition(r.status, to)) {
			throw new LionError("invalid_transition", `cannot transition ${r.id} from ${r.status} to ${to}`);
		}
		r.status = to;
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

function isProgressEvent(value: unknown): value is LionProgressEvent {
	return typeof value === "string" && PROGRESS_EVENT_SET.has(value);
}

function trimText(value: string): string {
	return value.length > MAX_PROGRESS_TEXT ? value.slice(-MAX_PROGRESS_TEXT) : value;
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
		agent_id: typeof value.agent_id === "string" ? value.agent_id : "lion-unknown",
		status,
		task_id: typeof value.task_id === "string" ? value.task_id : null,
		objective: typeof value.objective === "string" ? value.objective : "",
		context: typeof value.context === "string" ? value.context : "",
		model: typeof value.model === "string" ? value.model : null,
		model_role: isModelRole(value.model_role) ? value.model_role : null,
		tools: Array.isArray(value.tools) ? normalizeStringList(value.tools) : null,
		started_at: started,
		updated_at: updated,
		finished_at: typeof value.finished_at === "string" ? value.finished_at : null,
		duration_ms: typeof value.duration_ms === "number" ? value.duration_ms : null,
		output: typeof value.output === "string" ? value.output : null,
		report: coerceReport(value.report),
		progress: coerceProgress(value.progress),
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

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}
