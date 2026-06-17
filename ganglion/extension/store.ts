/** GANGLION — pure working-group ledger and capability allocator. */

import {
	ALLOCATION_STATUSES,
	GANGLION_STATUSES,
	GanglionError,
	MEMBER_STATUSES,
	PRIORITIES,
	type Allocation,
	type AllocationStatus,
	type Ganglion,
	type GanglionFile,
	type GanglionStatus,
	type GanglionSummary,
	type Member,
	type MemberStatus,
	type Priority,
	type WorkItemBrief,
} from "./schema.ts";

const VERSION = 1;
const G_STATUS = new Set<string>(GANGLION_STATUSES);
const M_STATUS = new Set<string>(MEMBER_STATUSES);
const A_STATUS = new Set<string>(ALLOCATION_STATUSES);
const P_SET = new Set<string>(PRIORITIES);
const P_SCORE: Record<Priority, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const now = () => new Date().toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const strings = (xs: unknown): string[] => Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string").map(normalizeCap) : [];
const normalizeCap = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-");

export function canTransition(from: GanglionStatus, to: GanglionStatus): boolean {
	if (from === to) return true;
	if (from === "forming") return to === "active" || to === "paused" || to === "cancelled";
	if (from === "active") return to === "paused" || to === "draining" || to === "completed" || to === "cancelled";
	if (from === "paused") return to === "active" || to === "cancelled";
	if (from === "draining") return to === "completed" || to === "cancelled";
	return false;
}

export interface CreateGanglionInput {
	name?: string;
	goal_id?: string | null;
	max_parallel?: number;
	members?: Array<{ id?: string; role?: string; capabilities?: string[]; model?: string; tools?: string[]; status?: MemberStatus }>;
	member_count?: number;
}
export interface AllocateInput { tasks: WorkItemBrief[]; context?: string }
export interface RecordInput { allocation_id?: string; task_id?: string; lion_run_id?: string; status: AllocationStatus; summary?: string }

export class GanglionLedger {
	readonly project?: string;
	current_ganglion_id?: string;
	private ganglionsById: Map<string, Ganglion>;

	constructor(project?: string, ganglions: Ganglion[] = [], current_ganglion_id?: string) {
		this.project = project;
		this.ganglionsById = new Map(ganglions.map((g) => [g.id, clone(g)]));
		this.current_ganglion_id = current_ganglion_id;
	}

	create(input: CreateGanglionInput = {}): Ganglion {
		const id = this.nextId();
		const ts = now();
		const members = materializeMembers(id, input.members, input.member_count, ts);
		const ganglion: Ganglion = {
			id,
			name: input.name?.trim() || id,
			goal_id: input.goal_id ?? null,
			status: "forming",
			max_parallel: clampParallel(input.max_parallel),
			members,
			allocations: [],
			created_at: ts,
			updated_at: ts,
			completed_at: null,
		};
		this.ganglionsById.set(id, ganglion);
		this.current_ganglion_id = id;
		return clone(ganglion);
	}

	addMember(ganglionId: string, input: { id?: string; role?: string; capabilities?: string[]; model?: string; tools?: string[] }): Ganglion {
		const g = this.require(ganglionId);
		const id = input.id?.trim() || `lion-${g.id.replace(/^ganglion-/, "")}-${String(g.members.length + 1).padStart(3, "0")}`;
		if (g.members.some((m) => m.id === id)) throw new GanglionError("exists", `member ${id} already exists`);
		g.members.push(newMember(id, input, now()));
		g.updated_at = now();
		return clone(g);
	}

	updateMember(ganglionId: string, memberId: string, patch: { role?: string; capabilities?: string[]; model?: string; tools?: string[]; status?: MemberStatus }): Ganglion {
		const g = this.require(ganglionId);
		const m = requireMember(g, memberId);
		if (patch.role !== undefined) m.role = patch.role;
		if (patch.capabilities !== undefined) m.capabilities = patch.capabilities.map(normalizeCap).filter(Boolean);
		if (patch.model !== undefined) m.model = patch.model;
		if (patch.tools !== undefined) m.tools = [...patch.tools];
		if (patch.status !== undefined) m.status = patch.status;
		m.updated_at = now();
		g.updated_at = m.updated_at;
		return clone(g);
	}

	removeMember(ganglionId: string, memberId: string): Ganglion {
		const g = this.require(ganglionId);
		const m = requireMember(g, memberId);
		if (m.current_allocation_id) throw new GanglionError("invalid_transition", `member ${memberId} has active allocation ${m.current_allocation_id}`);
		g.members = g.members.filter((x) => x.id !== memberId);
		g.updated_at = now();
		return clone(g);
	}

	setStatus(ganglionId: string, status: GanglionStatus): Ganglion {
		const g = this.require(ganglionId);
		if (!canTransition(g.status, status)) throw new GanglionError("invalid_transition", `cannot transition ${g.id} from ${g.status} to ${status}`);
		g.status = status;
		if (status === "completed") g.completed_at = now();
		g.updated_at = now();
		return clone(g);
	}

	allocate(ganglionId: string, input: AllocateInput): Ganglion {
		const g = this.require(ganglionId);
		if (!input.tasks?.length) throw new GanglionError("invalid_arg", "allocate requires tasks");
		if (g.status === "forming") g.status = "active";
		if (g.status !== "active") throw new GanglionError("invalid_transition", `cannot allocate while ${g.id} is ${g.status}`);
		const capacity = Math.max(0, g.max_parallel - g.members.filter((m) => m.status === "busy").length);
		const available = g.members.filter((m) => m.status === "available");
		const sorted = [...input.tasks].sort((a, b) => P_SCORE[priorityOf(b.priority)] - P_SCORE[priorityOf(a.priority)]);
		let slots = Math.min(capacity, available.length);
		for (const task of sorted) {
			if (slots <= 0) break;
			if (g.allocations.some((a) => a.task_id === task.id && !["completed", "failed", "blocked", "cancelled"].includes(a.status))) continue;
			const member = bestMember(available, task);
			if (!member) continue;
			available.splice(available.findIndex((m) => m.id === member.id), 1);
			const allocation = makeAllocation(g, task, member, input.context ?? "");
			g.allocations.push(allocation);
			member.status = "busy";
			member.current_task_id = task.id;
			member.current_allocation_id = allocation.id;
			member.updated_at = allocation.created_at;
			slots--;
		}
		g.updated_at = now();
		return clone(g);
	}

	record(ganglionId: string, input: RecordInput): Ganglion {
		const g = this.require(ganglionId);
		if (!A_STATUS.has(input.status)) throw new GanglionError("invalid_arg", `invalid allocation status ${input.status}`);
		const a = input.allocation_id ? requireAllocation(g, input.allocation_id) : findAllocation(g, input.task_id);
		if (!a) throw new GanglionError("not_found", "allocation not found");
		a.status = input.status;
		if (input.lion_run_id) a.lion_run_id = input.lion_run_id;
		a.outcome_summary = input.summary ?? null;
		a.updated_at = now();
		const m = requireMember(g, a.member_id);
		if (["completed", "blocked", "failed", "cancelled"].includes(a.status)) releaseMember(m, input.lion_run_id);
		else m.status = "busy";
		g.updated_at = now();
		return clone(g);
	}

	release(ganglionId: string, memberOrAllocationId: string): Ganglion {
		const g = this.require(ganglionId);
		const a = g.allocations.find((x) => x.id === memberOrAllocationId);
		const memberId = a?.member_id ?? memberOrAllocationId;
		const m = requireMember(g, memberId);
		releaseMember(m, a?.lion_run_id ?? undefined);
		if (a && !["completed", "blocked", "failed", "cancelled"].includes(a.status)) {
			a.status = "cancelled";
			a.updated_at = now();
		}
		g.updated_at = now();
		return clone(g);
	}

	delete(id: string): Ganglion {
		const g = this.require(id);
		this.ganglionsById.delete(id);
		if (this.current_ganglion_id === id) this.current_ganglion_id = undefined;
		return clone(g);
	}
	get(id: string): Ganglion | undefined { const g = this.ganglionsById.get(id); return g ? clone(g) : undefined; }
	current(): Ganglion | undefined { return this.current_ganglion_id ? this.get(this.current_ganglion_id) : this.all().find((g) => !["completed", "cancelled"].includes(g.status)); }
	all(): Ganglion[] { return Array.from(this.ganglionsById.values()).map(clone).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
	list(filter: { status?: GanglionStatus; limit?: number } = {}): Ganglion[] {
		let gs = this.all();
		if (filter.status) gs = gs.filter((g) => g.status === filter.status);
		const limit = filter.limit ?? 20;
		return limit > 0 ? gs.slice(0, limit) : gs;
	}
	summary(limit = 10): GanglionSummary {
		const all = this.all();
		const by_status: Partial<Record<GanglionStatus, number>> = {};
		for (const g of all) by_status[g.status] = (by_status[g.status] ?? 0) + 1;
		return {
			total: all.length,
			by_status,
			current_ganglion_id: this.current_ganglion_id,
			active: all.filter((g) => !["completed", "cancelled"].includes(g.status)).map((g) => ({ id: g.id, name: g.name, status: g.status, members: g.members.length, busy: g.members.filter((m) => m.status === "busy").length })),
			recent: limit > 0 ? all.slice(0, limit) : all,
		};
	}
	toJSON(): GanglionFile {
		const ganglions: Record<string, Ganglion> = {};
		for (const g of this.ganglionsById.values()) ganglions[g.id] = clone(g);
		return { version: VERSION, project: this.project, updated_at: now(), current_ganglion_id: this.current_ganglion_id, ganglions };
	}
	static fromJSON(raw: unknown): GanglionLedger {
		const obj = isObject(raw) ? raw : {};
		const ganglionsObj = isObject(obj.ganglions) ? obj.ganglions : {};
		const ganglions: Ganglion[] = [];
		for (const [id, value] of Object.entries(ganglionsObj)) {
			const g = coerceGanglion(id, value);
			if (g) ganglions.push(g);
		}
		return new GanglionLedger(typeof obj.project === "string" ? obj.project : undefined, ganglions, typeof obj.current_ganglion_id === "string" ? obj.current_ganglion_id : undefined);
	}
	private require(id: string): Ganglion { const g = this.ganglionsById.get(id); if (!g) throw new GanglionError("not_found", `ganglion ${id} not found`); return g; }
	private nextId(): string { let max = 0; for (const id of this.ganglionsById.keys()) { const m = /^ganglion-(\d+)$/.exec(id); if (m) max = Math.max(max, Number(m[1])); } return `ganglion-${String(max + 1).padStart(3, "0")}`; }
}

function materializeMembers(ganglionId: string, members: CreateGanglionInput["members"], count: unknown, ts: string): Member[] {
	if (members?.length) return members.map((m, i) => newMember(m.id?.trim() || `lion-${ganglionId.replace(/^ganglion-/, "")}-${String(i + 1).padStart(3, "0")}`, m, ts));
	const n = typeof count === "number" && Number.isFinite(count) ? Math.max(1, Math.min(20, Math.floor(count))) : 3;
	return Array.from({ length: n }, (_, i) => newMember(`lion-${ganglionId.replace(/^ganglion-/, "")}-${String(i + 1).padStart(3, "0")}`, { role: "generalist", capabilities: ["general"] }, ts));
}
function newMember(id: string, input: { role?: string; capabilities?: string[]; model?: string; tools?: string[]; status?: MemberStatus }, ts: string): Member {
	return { id: id.toLowerCase(), role: input.role ?? "generalist", capabilities: (input.capabilities?.length ? input.capabilities : ["general"]).map(normalizeCap).filter(Boolean), model: input.model ?? null, tools: input.tools ? [...input.tools] : null, status: input.status ?? "available", current_task_id: null, current_allocation_id: null, last_run_id: null, created_at: ts, updated_at: ts };
}
function bestMember(members: Member[], task: WorkItemBrief): Member | undefined {
	const req = (task.required_capabilities ?? []).map(normalizeCap).filter(Boolean);
	const scored = members.map((m) => ({ m, score: req.length ? req.filter((r) => m.capabilities.includes(r)).length : 1 }));
	const viable = req.length ? scored.filter((x) => x.score > 0) : scored;
	return viable.sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id))[0]?.m;
}
function makeAllocation(g: Ganglion, task: WorkItemBrief, m: Member, context: string): Allocation {
	const ts = now();
	const id = `alloc-${String(g.allocations.length + 1).padStart(3, "0")}`;
	const required = (task.required_capabilities ?? []).map(normalizeCap).filter(Boolean);
	return { id, task_id: task.id, member_id: m.id, objective: `${task.title}${task.description ? `\n\n${task.description}` : ""}`, context, priority: priorityOf(task.priority), required_capabilities: required, status: "assigned", lion_run_id: null, outcome_summary: null, reason: allocationReason(m, required), created_at: ts, updated_at: ts };
}
function allocationReason(m: Member, required: string[]): string { return required.length ? `matched ${required.filter((r) => m.capabilities.includes(r)).join(", ") || "available member"}` : "no specific capability required"; }
function releaseMember(m: Member, runId?: string): void { m.status = "available"; m.current_task_id = null; m.current_allocation_id = null; if (runId) m.last_run_id = runId; m.updated_at = now(); }
function requireMember(g: Ganglion, id: string): Member { const m = g.members.find((x) => x.id === id); if (!m) throw new GanglionError("not_found", `member ${id} not found`); return m; }
function requireAllocation(g: Ganglion, id: string): Allocation { const a = g.allocations.find((x) => x.id === id); if (!a) throw new GanglionError("not_found", `allocation ${id} not found`); return a; }
function findAllocation(g: Ganglion, taskId?: string): Allocation | undefined { return taskId ? g.allocations.find((a) => a.task_id === taskId && !["completed", "blocked", "failed", "cancelled"].includes(a.status)) : undefined; }
function clampParallel(n: unknown): number { return typeof n === "number" && Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 3; }
function priorityOf(p: unknown): Priority { return typeof p === "string" && P_SET.has(p) ? (p as Priority) : "medium"; }
function coerceGanglion(id: string, value: unknown): Ganglion | null {
	if (!isObject(value)) return null;
	const created = typeof value.created_at === "string" ? value.created_at : now();
	return { id: typeof value.id === "string" ? value.id : id, name: typeof value.name === "string" ? value.name : id, goal_id: typeof value.goal_id === "string" ? value.goal_id : null, status: typeof value.status === "string" && G_STATUS.has(value.status) ? (value.status as GanglionStatus) : "forming", max_parallel: clampParallel(value.max_parallel), members: Array.isArray(value.members) ? value.members.map(coerceMember).filter((x): x is Member => !!x) : [], allocations: Array.isArray(value.allocations) ? value.allocations.map(coerceAllocation).filter((x): x is Allocation => !!x) : [], created_at: created, updated_at: typeof value.updated_at === "string" ? value.updated_at : created, completed_at: typeof value.completed_at === "string" ? value.completed_at : null };
}
function coerceMember(value: unknown): Member | null {
	if (!isObject(value)) return null; const created = typeof value.created_at === "string" ? value.created_at : now();
	return { id: typeof value.id === "string" ? value.id : "lion-unknown", role: typeof value.role === "string" ? value.role : "generalist", capabilities: strings(value.capabilities), model: typeof value.model === "string" ? value.model : null, tools: Array.isArray(value.tools) ? strings(value.tools) : null, status: typeof value.status === "string" && M_STATUS.has(value.status) ? (value.status as MemberStatus) : "offline", current_task_id: typeof value.current_task_id === "string" ? value.current_task_id : null, current_allocation_id: typeof value.current_allocation_id === "string" ? value.current_allocation_id : null, last_run_id: typeof value.last_run_id === "string" ? value.last_run_id : null, created_at: created, updated_at: typeof value.updated_at === "string" ? value.updated_at : created };
}
function coerceAllocation(value: unknown): Allocation | null {
	if (!isObject(value)) return null; const created = typeof value.created_at === "string" ? value.created_at : now();
	return { id: typeof value.id === "string" ? value.id : "alloc-unknown", task_id: typeof value.task_id === "string" ? value.task_id : "", member_id: typeof value.member_id === "string" ? value.member_id : "lion-unknown", objective: typeof value.objective === "string" ? value.objective : "", context: typeof value.context === "string" ? value.context : "", priority: priorityOf(value.priority), required_capabilities: strings(value.required_capabilities), status: typeof value.status === "string" && A_STATUS.has(value.status) ? (value.status as AllocationStatus) : "failed", lion_run_id: typeof value.lion_run_id === "string" ? value.lion_run_id : null, outcome_summary: typeof value.outcome_summary === "string" ? value.outcome_summary : null, reason: typeof value.reason === "string" ? value.reason : "", created_at: created, updated_at: typeof value.updated_at === "string" ? value.updated_at : created };
}
function isObject(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null; }
