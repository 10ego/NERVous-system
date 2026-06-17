/**
 * SYNAPSE — the note log core (pure, no I/O).
 *
 * {@link NoteLog} holds notes in memory and implements append-only posting,
 * filtering, and the retention policy (TTL + max count) that keeps SYNAPSE
 * transient. Separated from the filesystem backend so it is unit-testable.
 */

import {
	type Note,
	NOTE_TYPES,
	type NoteType,
	SynapseError,
	type SynapseFile,
	type SynapseSummary,
} from "./schema.ts";

const now = () => Date.now();
const iso = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface RetentionPolicy {
	/** Notes older than this (ms) are pruned on save. 0 = no TTL pruning. */
	ttl_ms: number;
	/** Hard cap on total notes; oldest dropped beyond this. 0 = no cap. */
	max_notes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	ttl_ms: 24 * 60 * 60 * 1000, // 24h
	max_notes: 1000,
};

export interface PostInput {
	task_id?: string | null;
	agent_id?: string | null;
	type?: NoteType;
	message: string;
}

export interface ListFilter {
	task_id?: string | null; // null literal => general channel; omit => any
	agent_id?: string;
	type?: NoteType;
	limit?: number;
}

export class NoteLog {
	notes: Note[] = [];
	meta: {
		version: number;
		project?: string;
		created_at?: string;
		updated_at: string;
		retention: RetentionPolicy;
	};

	constructor(project?: string, retention: RetentionPolicy = DEFAULT_RETENTION) {
		const ts = iso();
		this.meta = { version: 1, project, created_at: ts, updated_at: ts, retention };
	}

	/* ----------------------------- (de)serialization ---------------------- */

	static fromJSON(data: unknown, retention?: RetentionPolicy): NoteLog {
		const log = new NoteLog(undefined, retention ?? DEFAULT_RETENTION);
		if (typeof data !== "object" || data === null) return log;
		const d = data as Record<string, unknown>;
		if (typeof d.meta === "object" && d.meta !== null) {
			const m = d.meta as Record<string, unknown>;
			log.meta = {
				...log.meta,
				...(m as object),
				// honor an explicit runtime retention override over the file's snapshot
				retention: retention ?? (m.retention as RetentionPolicy) ?? DEFAULT_RETENTION,
			} as NoteLog["meta"];
		}
		const notes = Array.isArray(d.notes) ? d.notes : [];
		for (const raw of notes) {
			const n = NoteLog.coerceNote(raw);
			if (n) log.notes.push(n);
		}
		return log;
	}

	toJSON(): SynapseFile {
		return {
			version: this.meta.version,
			project: this.meta.project,
			created_at: this.meta.created_at,
			updated_at: this.meta.updated_at,
			retention: this.meta.retention,
			notes: this.notes,
		};
	}

	/** Leniently coerce arbitrary JSON into a Note; returns null if unrecoverable. */
	private static coerceNote(raw: unknown): Note | null {
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.message !== "string") return null;
		const type = (NOTE_TYPES as readonly string[]).includes(r.type as string)
			? (r.type as NoteType)
			: "info";
		return {
			id: r.id,
			task_id: typeof r.task_id === "string" || r.task_id === null ? (r.task_id as string | null) : null,
			agent_id: typeof r.agent_id === "string" || r.agent_id === null ? (r.agent_id as string | null) : null,
			type,
			message: r.message,
			created_at: typeof r.created_at === "string" ? r.created_at : iso(),
		};
	}

	/* ----------------------------- queries -------------------------------- */

	get(id: string): Note | undefined {
		const n = this.notes.find((x) => x.id === id);
		return n ? clone(n) : undefined;
	}

	all(): Note[] {
		return this.notes.map(clone);
	}

	list(filter: ListFilter = {}): Note[] {
		let result = this.all();
		if (filter.task_id !== undefined) result = result.filter((n) => n.task_id === filter.task_id);
		if (filter.agent_id !== undefined) result = result.filter((n) => n.agent_id === filter.agent_id);
		if (filter.type !== undefined) result = result.filter((n) => n.type === filter.type);
		// newest first; ties (same ms) broken by numeric id so order is stable
		const numId = (id: string): number => parseInt(id.replace(/^note-/, ""), 10) || 0;
		result.sort((a, b) => {
			if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
			return numId(b.id) - numId(a.id);
		});
		if (filter.limit !== undefined && filter.limit > 0) result = result.slice(0, filter.limit);
		return result;
	}

	recent(limit = 50): Note[] {
		return this.list({ limit });
	}

	forTask(taskId: string, limit?: number): Note[] {
		return this.list({ task_id: taskId, limit });
	}

	summary(limit = 10): SynapseSummary {
		const by_type: Partial<Record<NoteType, number>> = {};
		const taskCounts = new Map<string | null, number>();
		let oldestMs: number | null = null;
		const nowMs = now();

		for (const n of this.notes) {
			by_type[n.type] = (by_type[n.type] ?? 0) + 1;
			taskCounts.set(n.task_id, (taskCounts.get(n.task_id) ?? 0) + 1);
			const age = nowMs - Date.parse(n.created_at);
			if (!Number.isNaN(age) && (oldestMs === null || age > oldestMs)) oldestMs = age;
		}

		const by_task = Array.from(taskCounts.entries())
			.map(([task_id, count]) => ({ task_id, count }))
			.sort((a, b) => b.count - a.count);

		return {
			total: this.notes.length,
			by_type,
			by_task,
			recent: this.recent(limit),
			oldest_age_ms: oldestMs,
			retention: this.meta.retention,
		};
	}

	/* ----------------------------- id generation -------------------------- */

	nextId(): string {
		let max = 0;
		for (const n of this.notes) {
			const m = n.id.match(/^note-(\d+)$/);
			if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
		}
		const next = max + 1;
		const width = Math.max(3, String(next).length);
		return `note-${String(next).padStart(width, "0")}`;
	}

	/* ----------------------------- mutations ------------------------------ */

	post(input: PostInput): Note {
		if (!input.message || !input.message.trim()) {
			throw new SynapseError("invalid_arg", "Note message cannot be empty.");
		}
		if (input.message.length > 1000) {
			throw new SynapseError("invalid_arg", `Note too long (${input.message.length} chars); keep SYNAPSE notes concise (<=1000).`);
		}
		const note: Note = {
			id: this.nextId(),
			task_id: input.task_id ?? null,
			agent_id: input.agent_id ?? null,
			type: input.type ?? "info",
			message: input.message.trim(),
			created_at: iso(),
		};
		this.notes.push(note);
		this.meta.updated_at = note.created_at;
		return clone(note);
	}

	/** Remove all notes older than TTL and trim to max_notes. Returns count removed. */
	prune(policy: RetentionPolicy = this.meta.retention): number {
		const before = this.notes.length;
		const nowMs = now();
		let kept = this.notes;
		if (policy.ttl_ms > 0) {
			kept = kept.filter((n) => {
				const age = nowMs - Date.parse(n.created_at);
				return Number.isNaN(age) || age <= policy.ttl_ms;
			});
		}
		if (policy.max_notes > 0 && kept.length > policy.max_notes) {
			// drop the oldest beyond the cap
			kept = kept
				.slice()
				.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
				.slice(-policy.max_notes);
		}
		const removed = before - kept.length;
		if (removed > 0) {
			this.notes = kept;
			this.meta.updated_at = iso();
		}
		return removed;
	}

	/**
	 * Clear notes. If `filter` is provided, only matching notes are removed;
	 * otherwise all notes are removed. Returns count removed.
	 */
	clear(filter?: { task_id?: string | null; agent_id?: string; type?: NoteType }): number {
		const before = this.notes.length;
		if (!filter) {
			this.notes = [];
		} else {
			this.notes = this.notes.filter(
				(n) =>
					!(
						(filter.task_id === undefined || n.task_id === filter.task_id) &&
						(filter.agent_id === undefined || n.agent_id === filter.agent_id) &&
						(filter.type === undefined || n.type === filter.type)
					),
			);
		}
		const removed = before - this.notes.length;
		if (removed > 0) this.meta.updated_at = iso();
		return removed;
	}
}
