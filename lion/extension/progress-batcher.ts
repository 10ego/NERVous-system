import type { LionStore } from "./backend.ts";
import type { LionProgressSnapshot, LionRun } from "./schema.ts";

interface PendingProgress {
	runId: string;
	incarnationId: string | null;
	progress: LionProgressSnapshot;
	waiters: Array<{ resolve(progress: LionProgressSnapshot | undefined): void; reject(error: unknown): void }>;
}

class NamespaceProgressBatcher {
	private readonly pending = new Map<string, PendingProgress>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;
	constructor(private readonly store: LionStore, private readonly delayMs: number, private readonly onIdle: () => void) {}

	enqueue(run: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionProgressSnapshot | undefined> {
		const incarnationId = run.incarnation_id ?? null;
		const key = JSON.stringify([run.id, incarnationId]);
		return new Promise((resolve, reject) => {
			const existing = this.pending.get(key);
			if (existing) { existing.progress = progress; existing.waiters.push({ resolve, reject }); }
			else this.pending.set(key, { runId: run.id, incarnationId, progress, waiters: [{ resolve, reject }] });
			this.schedule();
		});
	}

	private schedule(): void {
		if (this.flushing || this.timer || !this.pending.size) return;
		this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
		this.timer.unref?.();
	}
	private async flush(): Promise<void> {
		if (this.flushing || !this.pending.size) return;
		this.flushing = true;
		const batch = Array.from(this.pending.values());
		this.pending.clear();
		try {
			// Keep the namespace lock for the whole coalesced batch while preserving
			// independent outcomes for malformed/stale exact authorities.
			const outcomes = await this.store.flushProgressBatch(batch.map((entry) => ({
				ref: { id: entry.runId, incarnation_id: entry.incarnationId }, progress: entry.progress,
			})));
			batch.forEach((entry, index) => {
				const outcome = outcomes[index]!;
				if (outcome.ok) for (const waiter of entry.waiters) waiter.resolve(outcome.progress);
				else for (const waiter of entry.waiters) waiter.reject(outcome.error);
			});
		} finally {
			this.flushing = false; this.schedule();
			if (!this.pending.size && !this.timer) this.onIdle();
		}
	}
	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const error = new Error("LION progress batcher disposed before flush");
		for (const entry of this.pending.values()) for (const waiter of entry.waiters) waiter.reject(error);
		this.pending.clear();
	}
}

const batchers = new Map<string, NamespaceProgressBatcher>();
const DEFAULT_PROGRESS_BATCH_DELAY_MS = 20;
export function persistBatchedProgress(store: LionStore, run: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot, delayMs = DEFAULT_PROGRESS_BATCH_DELAY_MS): Promise<LionProgressSnapshot | undefined> {
	let batcher = batchers.get(store.namespaceId);
	if (!batcher) {
		const namespaceId = store.namespaceId;
		let created!: NamespaceProgressBatcher;
		created = new NamespaceProgressBatcher(store, delayMs, () => { if (batchers.get(namespaceId) === created) batchers.delete(namespaceId); });
		batcher = created; batchers.set(namespaceId, batcher);
	}
	return batcher.enqueue(run, progress);
}
export function clearProgressBatchersForTests(): void { for (const batcher of batchers.values()) batcher.dispose(); batchers.clear(); }
export function progressBatcherCountForTests(): number { return batchers.size; }
