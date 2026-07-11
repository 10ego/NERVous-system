import type { LionStore } from "./backend.ts";
import type { LionProgressSnapshot, LionRun } from "./schema.ts";

interface PendingProgress {
	runId: string;
	incarnationId: string | null;
	progress: LionProgressSnapshot;
	waiters: Array<{ resolve(run: LionRun | undefined): void; reject(error: unknown): void }>;
}

class NamespaceProgressBatcher {
	private readonly pending = new Map<string, PendingProgress>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;

	constructor(private readonly store: LionStore, private readonly delayMs: number) {}

	enqueue(run: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionRun | undefined> {
		const incarnationId = run.incarnation_id ?? null;
		const key = JSON.stringify([run.id, incarnationId]);
		return new Promise((resolve, reject) => {
			const existing = this.pending.get(key);
			if (existing) {
				existing.progress = progress;
				existing.waiters.push({ resolve, reject });
			} else {
				this.pending.set(key, { runId: run.id, incarnationId, progress, waiters: [{ resolve, reject }] });
			}
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
			const { result } = await this.store.mutate((ledger) => batch.map((entry) => ledger.updateProgressIfCurrent(entry.runId, entry.incarnationId, entry.progress)));
			batch.forEach((entry, index) => {
				const outcome = result[index];
				const run = outcome?.committed ? outcome.run : undefined;
				for (const waiter of entry.waiters) waiter.resolve(run);
			});
		} catch (error) {
			for (const entry of batch) for (const waiter of entry.waiters) waiter.reject(error);
		} finally {
			this.flushing = false;
			this.schedule();
		}
	}
}

const batchers = new Map<string, NamespaceProgressBatcher>();
const DEFAULT_PROGRESS_BATCH_DELAY_MS = 20;

export function persistBatchedProgress(
	store: LionStore,
	run: Pick<LionRun, "id" | "incarnation_id">,
	progress: LionProgressSnapshot,
	delayMs = DEFAULT_PROGRESS_BATCH_DELAY_MS,
): Promise<LionRun | undefined> {
	let batcher = batchers.get(store.namespaceId);
	if (!batcher) {
		batcher = new NamespaceProgressBatcher(store, delayMs);
		batchers.set(store.namespaceId, batcher);
	}
	return batcher.enqueue(run, progress);
}

export function clearProgressBatchersForTests(): void {
	batchers.clear();
}
