/** CEREBEL — pure orchestration ledger. */

import {
	ASSIGNMENT_STATUSES,
	CerebelError,
	PRIORITIES,
	WAVE_STATUSES,
	type Assignment,
	type AssignmentStatus,
	type AxonTaskBrief,
	type CerebelFile,
	type CerebelSummary,
	type DecisionReport,
	type OrchestrationDecision,
	type Priority,
	type Wave,
	type WaveStatus,
} from "./schema.ts";

const VERSION = 1;
const STATUS_SET = new Set<string>(WAVE_STATUSES);
const ASSIGNMENT_STATUS_SET = new Set<string>(ASSIGNMENT_STATUSES);
const PRIORITY_SET = new Set<string>(PRIORITIES);
const TERMINAL_ASSIGNMENT_STATUS_SET = new Set<AssignmentStatus>(["completed", "partial", "blocked", "failed", "cancelled"]);

function now(): string {
	return new Date().toISOString();
}
function clone<T>(x: T): T {
	return JSON.parse(JSON.stringify(x)) as T;
}
function strings(xs: unknown): string[] {
	return Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [];
}

export function canTransition(from: WaveStatus, to: WaveStatus): boolean {
	if (from === to) return true;
	if (from === "planned") return to === "dispatched" || to === "cancelled";
	if (from === "dispatched") return to === "collecting" || to === "completed" || to === "blocked" || to === "needs_replan" || to === "cancelled";
	if (from === "collecting") return to === "completed" || to === "blocked" || to === "needs_replan" || to === "cancelled";
	if (from === "blocked") return to === "needs_replan" || to === "cancelled";
	if (from === "needs_replan") return to === "planned" || to === "cancelled";
	return false;
}

export interface PlanWaveInput {
	goal_id?: string | null;
	tasks?: AxonTaskBrief[];
	assignments?: Array<{ task_id?: string | null; agent_id?: string; objective: string; context?: string; priority?: Priority; ganglion_id?: string | null; ganglion_allocation_id?: string | null }>;
	context?: string;
	max_parallel?: number;
}

export interface DispatchInput {
	links?: Array<{ assignment_id: string; lion_run_id?: string; lion_run_incarnation_id?: string | null; ganglion_id?: string | null; ganglion_allocation_id?: string | null }>;
}

export interface RecordInput {
	assignment_id?: string;
	task_id?: string;
	lion_run_id?: string;
	lion_run_incarnation_id?: string | null;
	ganglion_id?: string | null;
	ganglion_allocation_id?: string | null;
	outcome: AssignmentStatus;
	summary?: string;
	changed_files?: string[];
	tests_run?: string[];
	blockers?: string[];
	next_steps?: string[];
}

export interface RecordIfOwnedResult {
	committed: boolean;
	wave: Wave;
	assignment: Assignment;
}

export class CerebelLedger {
	readonly project?: string;
	current_wave_id?: string;
	private wavesById: Map<string, Wave>;

	constructor(project?: string, waves: Wave[] = [], current_wave_id?: string) {
		this.project = project;
		this.wavesById = new Map(waves.map((w) => [w.id, clone(w)]));
		this.current_wave_id = current_wave_id;
	}

	planWave(input: PlanWaveInput): Wave {
		const assignments = materializeAssignments(this.nextWaveId(), input);
		if (!assignments.length) throw new CerebelError("invalid_arg", "plan_wave requires at least one task or assignment");
		const ts = now();
		const wave: Wave = {
			id: this.nextWaveId(),
			goal_id: input.goal_id ?? null,
			status: "planned",
			max_parallel: clampParallel(input.max_parallel),
			assignments,
			decision: null,
			created_at: ts,
			updated_at: ts,
			completed_at: null,
		};
		this.wavesById.set(wave.id, wave);
		this.current_wave_id = wave.id;
		return clone(wave);
	}

	dispatch(waveId: string, input: DispatchInput = {}): Wave {
		const w = this.require(waveId);
		if (!["planned", "needs_replan", "dispatched", "collecting"].includes(w.status)) throw new CerebelError("invalid_transition", `cannot dispatch ${w.id} from ${w.status}`);
		const links = input.links ?? [];
		for (const link of links) {
			const a = requireAssignment(w, link.assignment_id);
			if (TERMINAL_ASSIGNMENT_STATUS_SET.has(a.status)) throw new CerebelError("invalid_transition", `cannot dispatch terminal assignment ${a.id} from ${a.status}`);
			if (!["planned", "dispatched"].includes(a.status)) throw new CerebelError("invalid_transition", `cannot dispatch assignment ${a.id} from ${a.status}`);
			if (link.lion_run_incarnation_id && !link.lion_run_id) throw new CerebelError("invalid_arg", `LION incarnation for ${a.id} requires lion_run_id`);
			if (link.lion_run_id && !a.lion_run_id && !link.lion_run_incarnation_id) throw new CerebelError("invalid_arg", `new LION link for ${a.id} requires lion_run_incarnation_id`);
			if (link.lion_run_id && a.lion_run_id && a.lion_run_id !== link.lion_run_id) throw new CerebelError("invalid_transition", `cannot replace LION link for ${a.id} from ${a.lion_run_id} to ${link.lion_run_id}`);
			if (link.lion_run_id && a.lion_run_id === link.lion_run_id && link.lion_run_incarnation_id !== undefined && a.lion_run_incarnation_id && a.lion_run_incarnation_id !== link.lion_run_incarnation_id) {
				throw new CerebelError("invalid_transition", `cannot replace LION incarnation link for ${a.id}`);
			}
			a.status = "dispatched";
			if (link.lion_run_id) {
				a.lion_run_id = link.lion_run_id;
				a.lion_run_incarnation_id = link.lion_run_incarnation_id ?? a.lion_run_incarnation_id ?? null;
			}
			if (link.ganglion_id) a.ganglion_id = link.ganglion_id;
			if (link.ganglion_allocation_id) a.ganglion_allocation_id = link.ganglion_allocation_id;
			a.updated_at = now();
		}
		if (!links.length) {
			for (const a of w.assignments.filter((a) => a.status === "planned").slice(0, w.max_parallel)) {
				a.status = "dispatched";
				a.updated_at = now();
			}
		}
		if (w.status === "planned" || w.status === "needs_replan") this.transition(w, "dispatched");
		w.decision = this.computeDecision(w);
		w.updated_at = now();
		return clone(w);
	}

	record(waveId: string, input: RecordInput): Wave {
		const w = this.require(waveId);
		if (!ASSIGNMENT_STATUS_SET.has(input.outcome)) throw new CerebelError("invalid_arg", `invalid outcome ${input.outcome}`);
		const a = input.assignment_id ? requireAssignment(w, input.assignment_id) : findAssignment(w, input.task_id, input.lion_run_id);
		if (!a) throw new CerebelError("not_found", "assignment not found for record");
		if (["cancelled"].includes(a.status)) throw new CerebelError("invalid_transition", `cannot record cancelled assignment ${a.id}`);
		a.status = input.outcome;
		if (input.lion_run_incarnation_id && !input.lion_run_id && !a.lion_run_id) throw new CerebelError("invalid_arg", `LION incarnation for ${a.id} requires lion_run_id`);
		if (input.lion_run_id && input.lion_run_id !== a.lion_run_id && !input.lion_run_incarnation_id) {
			throw new CerebelError("invalid_arg", `new LION result link for ${a.id} requires lion_run_incarnation_id`);
		}
		if (input.lion_run_id) {
			a.lion_run_id = input.lion_run_id;
			a.lion_run_incarnation_id = input.lion_run_incarnation_id ?? a.lion_run_incarnation_id ?? null;
		}
		if (input.ganglion_id) a.ganglion_id = input.ganglion_id;
		if (input.ganglion_allocation_id) a.ganglion_allocation_id = input.ganglion_allocation_id;
		a.outcome_summary = input.summary ?? null;
		a.changed_files = input.changed_files ?? [];
		a.tests_run = input.tests_run ?? [];
		a.blockers = input.blockers ?? [];
		a.next_steps = input.next_steps ?? [];
		a.updated_at = now();

		const nextStatus = statusFromAssignments(w);
		this.transitionLenient(w, nextStatus);
		w.decision = this.computeDecision(w);
		w.updated_at = now();
		if (w.status === "completed") w.completed_at = w.updated_at;
		return clone(w);
	}

	/** Atomically records an outcome only while the assignment remains linked to the expected LION incarnation. */
	recordIfOwned(waveId: string, expectedLionRunId: string, expectedLionIncarnationId: string | null, input: RecordInput & { assignment_id: string }): RecordIfOwnedResult {
		if (!input.assignment_id) throw new CerebelError("invalid_arg", "guarded record requires assignment_id");
		if (input.lion_run_id && input.lion_run_id !== expectedLionRunId) {
			throw new CerebelError("invalid_arg", `guarded record for ${expectedLionRunId} cannot write LION link ${input.lion_run_id}`);
		}
		if (input.lion_run_incarnation_id !== undefined && input.lion_run_incarnation_id !== expectedLionIncarnationId) {
			throw new CerebelError("invalid_arg", `guarded record for ${expectedLionRunId} cannot write a different LION incarnation`);
		}
		const wave = this.require(waveId);
		const current = requireAssignment(wave, input.assignment_id);
		if (TERMINAL_ASSIGNMENT_STATUS_SET.has(current.status)
			|| current.lion_run_id !== expectedLionRunId
			|| (current.lion_run_incarnation_id ?? null) !== expectedLionIncarnationId) {
			return { committed: false, wave: clone(wave), assignment: clone(current) };
		}
		const recorded = this.record(waveId, { ...input, lion_run_incarnation_id: expectedLionIncarnationId });
		return { committed: true, wave: recorded, assignment: recorded.assignments.find((a) => a.id === current.id) ?? clone(current) };
	}

	decide(waveId: string): DecisionReport {
		const w = this.require(waveId);
		const d = this.computeDecision(w);
		w.decision = d;
		w.updated_at = now();
		return clone(d);
	}

	complete(waveId: string): Wave {
		const w = this.require(waveId);
		if (w.assignments.some((a) => !["completed", "partial"].includes(a.status))) {
			throw new CerebelError("invalid_transition", `${w.id} still has non-complete assignments`);
		}
		this.transitionLenient(w, "completed");
		w.decision = this.computeDecision(w);
		w.completed_at = now();
		w.updated_at = w.completed_at;
		return clone(w);
	}

	cancel(waveId: string): Wave {
		const w = this.require(waveId);
		this.transitionLenient(w, "cancelled");
		for (const a of w.assignments) if (!["completed", "partial", "blocked", "failed"].includes(a.status)) a.status = "cancelled";
		w.decision = { decision: "cancelled", reason: "wave cancelled", ready_assignment_ids: [], blocked_assignment_ids: [], failed_assignment_ids: [], completed_assignment_ids: [], created_at: now() };
		w.updated_at = now();
		return clone(w);
	}

	releaseReservations(waveId: string, assignmentIds: string[], reason = "released unlinked run_wave reservation"): Assignment[] {
		const w = this.require(waveId);
		const ids = new Set(assignmentIds);
		const released: Assignment[] = [];
		const ts = now();
		for (const a of w.assignments) {
			if (!ids.has(a.id) || a.status !== "dispatched" || a.lion_run_id) continue;
			a.status = "planned";
			a.outcome_summary = reason;
			a.updated_at = ts;
			released.push(clone(a));
		}
		if (released.length) {
			w.decision = this.computeDecision(w);
			w.updated_at = ts;
			if (w.status === "dispatched" || w.status === "collecting") this.transitionLenient(w, statusFromAssignments(w));
		}
		return released;
	}

	recoverOrphanedReservations(waveId: string, options: { stale_after_ms?: number; now_ms?: number } = {}): Assignment[] {
		const w = this.require(waveId);
		const nowMs = options.now_ms ?? Date.now();
		const staleAfterMs = options.stale_after_ms ?? 30_000;
		const recovered: Assignment[] = [];
		for (const a of w.assignments) {
			if (a.status !== "dispatched" || a.lion_run_id) continue;
			const updatedMs = Date.parse(a.updated_at);
			if (Number.isFinite(updatedMs) && nowMs - updatedMs < staleAfterMs) continue;
			a.status = "planned";
			a.outcome_summary = "recovered stale run_wave reservation without LION run id";
			a.updated_at = new Date(nowMs).toISOString();
			recovered.push(clone(a));
		}
		if (recovered.length) {
			w.decision = this.computeDecision(w);
			w.updated_at = new Date(nowMs).toISOString();
			if (w.status === "dispatched" || w.status === "collecting") this.transitionLenient(w, statusFromAssignments(w));
		}
		return recovered;
	}

	get(id: string): Wave | undefined {
		const w = this.wavesById.get(id);
		return w ? clone(w) : undefined;
	}
	current(): Wave | undefined {
		return this.current_wave_id ? this.get(this.current_wave_id) : this.all().find((w) => !["completed", "cancelled"].includes(w.status));
	}
	all(): Wave[] {
		return Array.from(this.wavesById.values()).map(clone).sort((a, b) => b.created_at.localeCompare(a.created_at));
	}
	list(filter: { status?: WaveStatus; limit?: number } = {}): Wave[] {
		let waves = this.all();
		if (filter.status) waves = waves.filter((w) => w.status === filter.status);
		const limit = filter.limit ?? 20;
		return limit > 0 ? waves.slice(0, limit) : waves;
	}
	summary(limit = 10): CerebelSummary {
		const waves = this.all();
		const by_status: Partial<Record<WaveStatus, number>> = {};
		for (const w of waves) by_status[w.status] = (by_status[w.status] ?? 0) + 1;
		return {
			total: waves.length,
			by_status,
			current_wave_id: this.current_wave_id,
			active: waves.filter((w) => !["completed", "cancelled"].includes(w.status)).map((w) => ({ id: w.id, status: w.status, assignments: w.assignments.length })),
			recent: limit > 0 ? waves.slice(0, limit) : waves,
		};
	}

	toJSON(): CerebelFile {
		const waves: Record<string, Wave> = {};
		for (const w of this.wavesById.values()) waves[w.id] = clone(w);
		return { version: VERSION, project: this.project, updated_at: now(), current_wave_id: this.current_wave_id, waves };
	}
	static fromJSON(raw: unknown): CerebelLedger {
		const obj = isObject(raw) ? raw : {};
		const wavesObj = isObject(obj.waves) ? obj.waves : {};
		const waves: Wave[] = [];
		for (const [id, value] of Object.entries(wavesObj)) {
			const w = coerceWave(id, value);
			if (w) waves.push(w);
		}
		return new CerebelLedger(typeof obj.project === "string" ? obj.project : undefined, waves, typeof obj.current_wave_id === "string" ? obj.current_wave_id : undefined);
	}

	private require(id: string): Wave {
		const w = this.wavesById.get(id);
		if (!w) throw new CerebelError("not_found", `wave ${id} not found`);
		return w;
	}
	private transition(w: Wave, to: WaveStatus): void {
		if (!canTransition(w.status, to)) throw new CerebelError("invalid_transition", `cannot transition ${w.id} from ${w.status} to ${to}`);
		w.status = to;
	}
	private transitionLenient(w: Wave, to: WaveStatus): void {
		if (w.status === to) return;
		if (canTransition(w.status, to)) w.status = to;
		else if (!["completed", "cancelled"].includes(w.status)) w.status = to;
		else throw new CerebelError("invalid_transition", `cannot transition ${w.id} from ${w.status} to ${to}`);
	}
	private nextWaveId(): string {
		let max = 0;
		for (const id of this.wavesById.keys()) {
			const m = /^wave-(\d+)$/.exec(id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return `wave-${String(max + 1).padStart(3, "0")}`;
	}
	private computeDecision(w: Wave): DecisionReport {
		return computeDecision(w);
	}
}

function materializeAssignments(waveId: string, input: PlanWaveInput): Assignment[] {
	const ts = now();
	const shared = input.context?.trim() ?? "";
	const out: Assignment[] = [];
	let i = 1;
	for (const t of input.tasks ?? []) {
		out.push({
			id: `assign-${String(i++).padStart(3, "0")}`,
			task_id: t.id,
			agent_id: (t.assigned_to?.trim() || `lion-${waveId.replace(/^wave-/, "")}-${String(i - 1).padStart(3, "0")}`).toLowerCase(),
			objective: `${t.title}${t.description ? `\n\n${t.description}` : ""}`,
			context: shared,
			priority: normalizePriority(t.priority),
			status: "planned",
			ganglion_id: null,
			ganglion_allocation_id: null,
			lion_run_id: null,
			lion_run_incarnation_id: null,
			outcome_summary: null,
			changed_files: [], tests_run: [], blockers: [], next_steps: [],
			created_at: ts, updated_at: ts,
		});
	}
	for (const a of input.assignments ?? []) {
		out.push({
			id: `assign-${String(i++).padStart(3, "0")}`,
			task_id: a.task_id ?? null,
			agent_id: (a.agent_id?.trim() || `lion-${waveId.replace(/^wave-/, "")}-${String(i - 1).padStart(3, "0")}`).toLowerCase(),
			objective: a.objective,
			context: [shared, a.context ?? ""].filter(Boolean).join("\n\n"),
			priority: normalizePriority(a.priority),
			status: "planned",
			ganglion_id: a.ganglion_id ?? null,
			ganglion_allocation_id: a.ganglion_allocation_id ?? null,
			lion_run_id: null,
			lion_run_incarnation_id: null,
			outcome_summary: null,
			changed_files: [], tests_run: [], blockers: [], next_steps: [],
			created_at: ts, updated_at: ts,
		});
	}
	return out;
}

function requireAssignment(w: Wave, id: string): Assignment {
	const a = w.assignments.find((x) => x.id === id);
	if (!a) throw new CerebelError("not_found", `assignment ${id} not found in ${w.id}`);
	return a;
}
function findAssignment(w: Wave, task_id?: string, lion_run_id?: string): Assignment | undefined {
	return w.assignments.find((a) => (task_id && a.task_id === task_id) || (lion_run_id && a.lion_run_id === lion_run_id));
}
function statusFromAssignments(w: Wave): WaveStatus {
	const statuses = w.assignments.map((a) => a.status);
	if (statuses.every((s) => s === "completed" || s === "partial")) return "completed";
	if (statuses.some((s) => s === "failed")) return "needs_replan";
	if (statuses.some((s) => s === "blocked")) return "blocked";
	if (statuses.some((s) => s === "cancelled")) return "cancelled";
	if (statuses.some((s) => s === "dispatched")) return "collecting";
	return w.status;
}
function computeDecision(w: Wave): DecisionReport {
	const planned = w.assignments.filter((a) => a.status === "planned");
	const running = w.assignments.filter((a) => a.status === "dispatched");
	const blocked = w.assignments.filter((a) => a.status === "blocked");
	const failed = w.assignments.filter((a) => a.status === "failed");
	const completed = w.assignments.filter((a) => a.status === "completed" || a.status === "partial");
	let decision: OrchestrationDecision;
	let reason: string;
	if (w.status === "cancelled") [decision, reason] = ["cancelled", "wave is cancelled"];
	else if (failed.length) [decision, reason] = ["replan", `${failed.length} assignment(s) failed`];
	else if (blocked.length) [decision, reason] = ["escalate_to_amygdala", `${blocked.length} assignment(s) blocked`];
	else if (planned.length && running.length < w.max_parallel) [decision, reason] = ["dispatch", `${Math.min(planned.length, w.max_parallel - running.length)} assignment(s) ready to dispatch`];
	else if (running.length) [decision, reason] = ["wait", `${running.length} assignment(s) still running`];
	else if (completed.length === w.assignments.length && w.assignments.length > 0) [decision, reason] = ["complete", "all assignments completed or partial"];
	else [decision, reason] = ["continue", "no terminal issue detected"];
	return {
		decision,
		reason,
		ready_assignment_ids: planned.slice(0, Math.max(0, w.max_parallel - running.length)).map((a) => a.id),
		blocked_assignment_ids: blocked.map((a) => a.id),
		failed_assignment_ids: failed.map((a) => a.id),
		completed_assignment_ids: completed.map((a) => a.id),
		created_at: now(),
	};
}
function clampParallel(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : 3;
}
function normalizePriority(p: unknown): Priority {
	return typeof p === "string" && PRIORITY_SET.has(p) ? (p as Priority) : "medium";
}
function coerceWave(id: string, value: unknown): Wave | null {
	if (!isObject(value)) return null;
	const created = typeof value.created_at === "string" ? value.created_at : now();
	return {
		id: typeof value.id === "string" ? value.id : id,
		goal_id: typeof value.goal_id === "string" ? value.goal_id : null,
		status: typeof value.status === "string" && STATUS_SET.has(value.status) ? (value.status as WaveStatus) : "needs_replan",
		max_parallel: clampParallel(value.max_parallel),
		assignments: Array.isArray(value.assignments) ? value.assignments.map(coerceAssignment).filter((x): x is Assignment => !!x) : [],
		decision: isObject(value.decision) ? (value.decision as unknown as DecisionReport) : null,
		created_at: created,
		updated_at: typeof value.updated_at === "string" ? value.updated_at : created,
		completed_at: typeof value.completed_at === "string" ? value.completed_at : null,
	};
}
function coerceAssignment(value: unknown): Assignment | null {
	if (!isObject(value)) return null;
	const created = typeof value.created_at === "string" ? value.created_at : now();
	return {
		id: typeof value.id === "string" ? value.id : "assign-unknown",
		task_id: typeof value.task_id === "string" ? value.task_id : null,
		agent_id: typeof value.agent_id === "string" ? value.agent_id : "lion-unknown",
		objective: typeof value.objective === "string" ? value.objective : "",
		context: typeof value.context === "string" ? value.context : "",
		priority: normalizePriority(value.priority),
		status: typeof value.status === "string" && ASSIGNMENT_STATUS_SET.has(value.status) ? (value.status as AssignmentStatus) : "failed",
		ganglion_id: typeof value.ganglion_id === "string" ? value.ganglion_id : null,
		ganglion_allocation_id: typeof value.ganglion_allocation_id === "string" ? value.ganglion_allocation_id : null,
		lion_run_id: typeof value.lion_run_id === "string" ? value.lion_run_id : null,
		lion_run_incarnation_id: typeof value.lion_run_incarnation_id === "string" ? value.lion_run_incarnation_id : null,
		outcome_summary: typeof value.outcome_summary === "string" ? value.outcome_summary : null,
		changed_files: strings(value.changed_files),
		tests_run: strings(value.tests_run),
		blockers: strings(value.blockers),
		next_steps: strings(value.next_steps),
		created_at: created,
		updated_at: typeof value.updated_at === "string" ? value.updated_at : created,
	};
}
function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null;
}
