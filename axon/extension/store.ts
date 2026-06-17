/**
 * AXON — the ledger core (pure, no I/O).
 *
 * {@link Ledger} holds tasks in memory and implements all ledger semantics:
 * creation, status transitions (state machine), dependency readiness, cycle
 * prevention, append-only progress notes / blockers / artifacts, review status,
 * deletion with referential cleanup, and board summaries.
 *
 * It is deliberately free of filesystem concerns so it can be unit-tested with
 * no I/O. {@link import("./backend.ts").FileBackend} handles durability and
 * {@link import("./backend.ts").AxonStore} ties load/mutate/save together.
 */

import {
	type Artifact,
	AxonError,
	type Blocker,
	type BoardSummary,
	PRIORITIES,
	type Priority,
	type ProgressNote,
	TASK_STATUSES,
	type Task,
	type TaskStatus,
} from "./schema.ts";
import { canTransition, nextStatuses } from "./task_status.ts";

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ID_RE = /^task-\d+$/;

export interface CreateTaskInput {
	id?: string;
	title: string;
	description?: string;
	parent_id?: string | null;
	dependencies?: string[];
	assigned_to?: string | null;
	priority?: Priority;
}

export interface UpdateTaskInput {
	title?: string;
	description?: string;
	parent_id?: string | null;
	dependencies?: string[];
	assigned_to?: string | null;
	priority?: Priority;
}

export interface ListFilter {
	status?: TaskStatus;
	assigned_to?: string;
	parent_id?: string;
	ready_only?: boolean;
	blocked_only?: boolean;
}

export class Ledger {
	tasks = new Map<string, Task>();
	meta: { version: number; project?: string; created_at?: string; updated_at: string };

	constructor(project?: string) {
		const ts = now();
		this.meta = { version: 1, project, created_at: ts, updated_at: ts };
	}

	/* ----------------------------- (de)serialization ---------------------- */

	static fromJSON(data: unknown): Ledger {
		const ledger = new Ledger();
		if (typeof data !== "object" || data === null) return ledger;
		const d = data as Record<string, unknown>;
		if (typeof d.meta === "object" && d.meta !== null) {
			ledger.meta = { ...ledger.meta, ...(d.meta as object) } as Ledger["meta"];
		}
		const tasks = (d.tasks ?? {}) as Record<string, unknown>;
		for (const [id, raw] of Object.entries(tasks)) {
			const t = Ledger.coerceTask(id, raw);
			if (t) ledger.tasks.set(id, t);
		}
		return ledger;
	}

	toJSON(): { meta: Ledger["meta"]; tasks: Record<string, Task> } {
		const tasks: Record<string, Task> = {};
		for (const [id, t] of this.tasks) tasks[id] = t;
		return { meta: { ...this.meta, updated_at: this.meta.updated_at }, tasks };
	}

	/** Leniently coerce arbitrary JSON into a Task; returns null if unrecoverable. */
	private static coerceTask(id: string, raw: unknown): Task | null {
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		const status = (TASK_STATUSES as readonly string[]).includes(r.status as string)
			? (r.status as TaskStatus)
			: "pending";
		const priority = (PRIORITIES as readonly string[]).includes(r.priority as string)
			? (r.priority as Priority)
			: "medium";
		const ts = now();
		const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
		const ts2 = (v: unknown): string => (typeof v === "string" ? v : ts);
		return {
			id,
			title: typeof r.title === "string" ? r.title : "(untitled)",
			description: typeof r.description === "string" ? r.description : "",
			parent_id: typeof r.parent_id === "string" || r.parent_id === null ? (r.parent_id as string | null) : null,
			dependencies: arr(r.dependencies).filter((x): x is string => typeof x === "string"),
			assigned_to: typeof r.assigned_to === "string" || r.assigned_to === null ? (r.assigned_to as string | null) : null,
			status,
			priority,
			progress_notes: arr(r.progress_notes).filter(
				(x): x is ProgressNote => typeof x === "object" && x !== null,
			),
			artifacts: arr(r.artifacts).filter((x): x is Artifact => typeof x === "object" && x !== null),
			blockers: arr(r.blockers).filter((x): x is Blocker => typeof x === "object" && x !== null),
			review_status:
				(["not_reviewed", "under_review", "approved", "changes_requested"] as const).includes(
					r.review_status as never,
				)
					? (r.review_status as never)
					: "not_reviewed",
			created_at: ts2(r.created_at),
			updated_at: ts2(r.updated_at),
		};
	}

	/* ----------------------------- queries -------------------------------- */

	get(id: string): Task | undefined {
		const t = this.tasks.get(id);
		return t ? clone(t) : undefined;
	}

	has(id: string): boolean {
		return this.tasks.has(id);
	}

	all(): Task[] {
		return Array.from(this.tasks.values()).map(clone);
	}

	list(filter: ListFilter = {}): Task[] {
		let result = this.all();
		if (filter.status) result = result.filter((t) => t.status === filter.status);
		if (filter.assigned_to) result = result.filter((t) => t.assigned_to === filter.assigned_to);
		if (filter.parent_id !== undefined) result = result.filter((t) => t.parent_id === filter.parent_id);
		if (filter.ready_only) result = result.filter((t) => t.status === "ready");
		if (filter.blocked_only) result = result.filter((t) => t.status === "blocked");
		return result;
	}

	readyTasks(): Task[] {
		return this.list({ status: "ready" });
	}

	blockedTasks(): Task[] {
		return this.list({ status: "blocked" });
	}

	children(parentId: string): Task[] {
		return this.list({ parent_id: parentId });
	}

	/** A task is ready to be picked up when it is pending and all deps are completed. */
	isReady(t: Task): boolean {
		if (t.status !== "pending") return false;
		return this.depsSatisfied(t);
	}

	depsSatisfied(t: Task): boolean {
		if (t.dependencies.length === 0) return true;
		return t.dependencies.every((depId) => {
			const dep = this.tasks.get(depId);
			return dep !== undefined && dep.status === "completed";
		});
	}

	summary(): BoardSummary {
		const by_status: Partial<Record<TaskStatus, number>> = {};
		const by_priority: Partial<Record<Priority, number>> = {};
		let terminal = 0;
		const ready: string[] = [];
		const in_progress: string[] = [];
		const blocked: string[] = [];
		const needs_amygdala: string[] = [];
		const needs_review: string[] = [];

		for (const t of this.tasks.values()) {
			by_status[t.status] = (by_status[t.status] ?? 0) + 1;
			by_priority[t.priority] = (by_priority[t.priority] ?? 0) + 1;
			if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") terminal++;
			if (t.status === "ready") ready.push(t.id);
			else if (t.status === "in_progress") in_progress.push(t.id);
			else if (t.status === "blocked") blocked.push(t.id);
			else if (t.status === "needs_amygdala") needs_amygdala.push(t.id);
			else if (t.status === "needs_review") needs_review.push(t.id);
		}

		return {
			total: this.tasks.size,
			by_status,
			by_priority,
			ready,
			in_progress,
			blocked,
			needs_amygdala,
			needs_review,
			terminal,
		};
	}

	/* ----------------------------- id generation -------------------------- */

	/** Next id of the form task-001, based on the highest existing number. */
	nextId(): string {
		let max = 0;
		for (const id of this.tasks.keys()) {
			const m = id.match(/^task-(\d+)$/);
			if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
		}
		const next = max + 1;
		const width = Math.max(3, String(next).length);
		return `task-${String(next).padStart(width, "0")}`;
	}

	/* ----------------------------- mutations ------------------------------ */

	create(input: CreateTaskInput): Task {
		if (!input.title || !input.title.trim()) {
			throw new AxonError("invalid_arg", "Task title is required.");
		}
		const deps = input.dependencies ?? [];
		const parentId = input.parent_id ?? null;
		const id = input.id ?? this.nextId();

		if (input.id) {
			if (!ID_RE.test(input.id)) throw new AxonError("invalid_arg", `Invalid id format: "${input.id}".`);
			if (this.tasks.has(id)) throw new AxonError("exists", `Task ${id} already exists.`);
		} else if (this.tasks.has(id)) {
			// extremely unlikely with nextId, but guard concurrent inserts
			throw new AxonError("exists", `Task ${id} already exists.`);
		}
		if (parentId !== null && !this.tasks.has(parentId)) {
			throw new AxonError("not_found", `Parent task ${parentId} does not exist.`);
		}
		this.validateDependencies(id, parentId, deps);

		const ts = now();
		const task: Task = {
			id,
			title: input.title.trim(),
			description: input.description ?? "",
			parent_id: parentId,
			dependencies: deps,
			assigned_to: input.assigned_to ?? null,
			status: "pending",
			priority: input.priority ?? "medium",
			progress_notes: [],
			artifacts: [],
			blockers: [],
			review_status: "not_reviewed",
			created_at: ts,
			updated_at: ts,
		};
		this.tasks.set(id, task);

		// Auto-promote pending → ready when deps are already satisfied.
		if (this.depsSatisfied(task)) this.setStatusInternal(task, "ready");
		this.meta.updated_at = now();
		return clone(task);
	}

	update(id: string, patch: UpdateTaskInput): Task {
		const t = this.require(id);
		const parentId = patch.parent_id !== undefined ? patch.parent_id : t.parent_id;
		const deps = patch.dependencies !== undefined ? patch.dependencies : t.dependencies;
		if (parentId !== null && !this.tasks.has(parentId)) {
			throw new AxonError("not_found", `Parent task ${parentId} does not exist.`);
		}
		this.validateDependencies(id, parentId, deps);

		if (patch.title !== undefined) {
			if (!patch.title.trim()) throw new AxonError("invalid_arg", "title cannot be empty.");
			t.title = patch.title.trim();
		}
		if (patch.description !== undefined) t.description = patch.description;
		if (patch.parent_id !== undefined) t.parent_id = patch.parent_id;
		if (patch.dependencies !== undefined) t.dependencies = patch.dependencies;
		if (patch.assigned_to !== undefined) t.assigned_to = patch.assigned_to;
		if (patch.priority !== undefined) t.priority = patch.priority;

		// If the task is pending and a dependency change made it ready, promote.
		if (t.status === "pending" && this.depsSatisfied(t)) this.setStatusInternal(t, "ready");
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	setStatus(id: string, status: TaskStatus, note?: string): Task {
		const t = this.require(id);
		if (t.status === status) {
			if (note) this.addNoteInternal(t, note);
			return clone(t);
		}
		if (!canTransition(t.status, status)) {
			throw new AxonError(
				"invalid_transition",
				`Cannot transition ${id} from "${t.status}" to "${status}". Allowed: ${nextStatuses(t.status).join(", ") || "(none, terminal)"}.`,
			);
		}
		if (status === "ready" && !this.depsSatisfied(t)) {
			throw new AxonError("deps_not_satisfied", `Cannot mark ${id} ready: dependencies not satisfied.`);
		}
		this.setStatusInternal(t, status);
		if (note) this.addNoteInternal(t, note);

		// Completing a task may unblock dependents; recompute.
		if (status === "completed") this.recompute();
		// Entering review tracks review_status.
		if (status === "needs_review" && t.review_status === "not_reviewed") {
			t.review_status = "under_review";
		}
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	assign(id: string, assignedTo: string | null): Task {
		return this.update(id, { assigned_to: assignedTo });
	}

	addNote(id: string, text: string, author?: string): Task {
		const t = this.require(id);
		if (!text.trim()) throw new AxonError("invalid_arg", "note text cannot be empty.");
		this.addNoteInternal(t, text, author);
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	addBlocker(id: string, text: string): Task {
		const t = this.require(id);
		if (!text.trim()) throw new AxonError("invalid_arg", "blocker text cannot be empty.");
		t.blockers.push({ text: text.trim(), ts: now(), resolved: false });
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	resolveBlocker(id: string, index: number): Task {
		const t = this.require(id);
		const b = t.blockers[index];
		if (!b) throw new AxonError("invalid_arg", `No blocker at index ${index} on ${id}.`);
		b.resolved = true;
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	addArtifact(id: string, artifact: { path: string; kind?: string }): Task {
		const t = this.require(id);
		if (!artifact.path.trim()) throw new AxonError("invalid_arg", "artifact path cannot be empty.");
		const a: Artifact = { path: artifact.path.trim(), ts: now() };
		if (artifact.kind) a.kind = artifact.kind;
		t.artifacts.push(a);
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	setReview(id: string, review: Task["review_status"]): Task {
		const t = this.require(id);
		t.review_status = review;
		t.updated_at = now();
		this.meta.updated_at = t.updated_at;
		return clone(t);
	}

	delete(id: string): boolean {
		const existed = this.tasks.delete(id);
		if (!existed) return false;
		// Referential cleanup: remove this id from others' dependencies.
		let changed = false;
		for (const t of this.tasks.values()) {
			const before = t.dependencies.length;
			t.dependencies = t.dependencies.filter((d) => d !== id);
			if (t.dependencies.length !== before) {
				changed = true;
				t.updated_at = now();
			}
			if (t.parent_id === id) t.parent_id = null;
		}
		if (changed) this.recompute();
		this.meta.updated_at = now();
		return true;
	}

	/**
	 * Walk all pending tasks and promote any whose dependencies are now completed
	 * to `ready`. Returns the ids that were promoted.
	 */
	recompute(): string[] {
		const promoted: string[] = [];
		for (const t of this.tasks.values()) {
			if (t.status === "pending" && this.depsSatisfied(t)) {
				this.setStatusInternal(t, "ready");
				promoted.push(t.id);
			}
		}
		if (promoted.length) this.meta.updated_at = now();
		return promoted;
	}

	/* ----------------------------- internals ------------------------------ */

	private require(id: string): Task {
		const t = this.tasks.get(id);
		if (!t) throw new AxonError("not_found", `Task ${id} does not exist.`);
		return t;
	}

	private setStatusInternal(t: Task, status: TaskStatus): void {
		t.status = status;
	}

	private addNoteInternal(t: Task, text: string, author?: string): void {
		const note: ProgressNote = { ts: now(), text: text.trim() };
		if (author) note.author = author;
		t.progress_notes.push(note);
	}

	/**
	 * Validate dependencies for a task: no self-deps, no cycles (via deps or via
	 * the parent chain), and reject parent===self. Forward references (a dep id
	 * that does not exist yet) are allowed — they just won't satisfy readiness.
	 */
	private validateDependencies(selfId: string, parentId: string | null, deps: string[]): void {
		if (parentId === selfId) {
			throw new AxonError("self_dep", `Task ${selfId} cannot be its own parent.`);
		}
		if (deps.includes(selfId)) {
			throw new AxonError("self_dep", `Task ${selfId} cannot depend on itself.`);
		}
		// Parent chain cycle check.
		if (parentId !== null) {
			const seen = new Set<string>([selfId]);
			let cur: string | null = parentId;
			let hops = 0;
			while (cur !== null && hops < 10000) {
				if (cur === selfId || seen.has(cur)) {
					throw new AxonError("cycle", `Parent chain would create a cycle for ${selfId}.`);
				}
				seen.add(cur);
				cur = this.tasks.get(cur)?.parent_id ?? null;
				hops++;
			}
		}
		// Dependency cycle check (DFS over existing tasks' deps).
		if (this.wouldCreateCycle(selfId, deps)) {
			throw new AxonError("cycle", `Dependencies for ${selfId} would create a cycle.`);
		}
	}

	/**
	 * Returns true if, after setting selfId's deps to `deps`, a dependency cycle
	 * exists among tasks reachable from selfId. Forward references (unknown deps)
	 * are treated as leaves and cannot close a cycle.
	 */
	private wouldCreateCycle(selfId: string, deps: string[]): boolean {
		const visiting = new Set<string>();
		const visited = new Set<string>();

		const dfs = (id: string): boolean => {
			if (id === selfId) return true;
			if (visited.has(id)) return false;
			if (visiting.has(id)) return true; // cycle within reachable subgraph
			visiting.add(id);
			const node = this.tasks.get(id);
			const nodeDeps = node ? node.dependencies : [];
			for (const d of nodeDeps) {
				if (dfs(d)) return true;
			}
			visiting.delete(id);
			visited.add(id);
			return false;
		};

		for (const d of deps) {
			if (dfs(d)) return true;
		}
		return false;
	}
}
