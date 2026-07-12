import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import { clearProgressBatchersForTests, persistBatchedProgress, progressBatcherCountForTests } from "../extension/progress-batcher.ts";
import type { LionProgressSnapshot } from "../extension/schema.ts";

async function makeStore(): Promise<LionStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-progress-batch-"));
	return new LionStore(new FileBackend({ runsPath: path.join(dir, "runs.json"), dir }));
}

function progress(activity: string): LionProgressSnapshot {
	return { event: "message", activity, active_tools: [], tool_uses: 0, turn_count: 1, token_total: null, last_text: null, last_event_at: new Date().toISOString() };
}

afterEach(() => clearProgressBatchersForTests());

describe("namespace progress batching", () => {
	it("persists concurrent exact-worker snapshots without canonical ledger I/O", async () => {
		const store = await makeStore();
		const runs = (await store.mutate((ledger) => [ledger.create({ objective: "A" }), ledger.create({ objective: "B" }), ledger.create({ objective: "C" })])).result;
		store.resetIoCounters();
		await Promise.all(runs.map((run, index) => persistBatchedProgress(store, run, progress(`step-${index}`), 5)));
		const counters = store.ioCounters();
		assert.deepEqual({ reads: counters.canonical_reads, parses: counters.canonical_parses, backups: counters.canonical_backups, serializations: counters.canonical_serializations, writes: counters.canonical_writes }, { reads: 0, parses: 0, backups: 0, serializations: 0, writes: 0 });
		assert.equal(counters.sidecar_lock_acquisitions, 1);
		assert.equal(counters.sidecar_capacity_scans, 0);
		assert.equal(counters.sidecar_writes, 3);
		const current = (await store.query((ledger) => runs.map((run) => ledger.get(run.id)))).result;
		assert.deepEqual(current.map((run) => run?.progress?.activity), ["step-0", "step-1", "step-2"]);
		assert.equal(progressBatcherCountForTests(), 0);
	});

	it("skips a terminal entry without aborting unrelated running progress", async () => {
		const store = await makeStore();
		const [terminal, running] = (await store.mutate((ledger) => [ledger.create({ objective: "terminal" }), ledger.create({ objective: "running" })])).result;
		const terminalWrite = persistBatchedProgress(store, terminal!, progress("too late"), 5);
		const runningWrite = persistBatchedProgress(store, running!, progress("still working"), 5);
		await store.mutate((ledger) => ledger.finish(terminal!.id, { output: "done", report: null, status: "completed" }));
		const [terminalResult, runningResult] = await Promise.all([terminalWrite, runningWrite]);
		assert.equal(terminalResult, undefined);
		assert.equal(runningResult?.activity, "still working");
		const current = (await store.query((ledger) => [ledger.get(terminal!.id), ledger.get(running!.id)])).result;
		assert.equal(current[0]?.progress, null);
		assert.equal(current[1]?.progress?.activity, "still working");
	});

	it("drops a stale-incarnation batch item without mutating its replacement", async () => {
		const store = await makeStore();
		const run = (await store.mutate((ledger) => ledger.create({ objective: "replacement" }))).result;
		const updated = await persistBatchedProgress(store, { id: run.id, incarnation_id: "inc-stale" }, progress("stale"), 5);
		assert.equal(updated, undefined);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress, null);
	});
});
