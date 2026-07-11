import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import { clearProgressBatchersForTests, persistBatchedProgress } from "../extension/progress-batcher.ts";
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
	it("persists concurrent worker snapshots in one ledger mutation", async () => {
		const store = await makeStore();
		const runs = (await store.mutate((ledger) => [ledger.create({ objective: "A" }), ledger.create({ objective: "B" }), ledger.create({ objective: "C" })])).result;
		const originalMutate = store.mutate.bind(store);
		let mutations = 0;
		(store as any).mutate = async (fn: never) => { mutations++; return originalMutate(fn); };
		await Promise.all(runs.map((run, index) => persistBatchedProgress(store, run, progress(`step-${index}`), 5)));
		assert.equal(mutations, 1);
		const current = (await store.query((ledger) => runs.map((run) => ledger.get(run.id)))).result;
		assert.deepEqual(current.map((run) => run?.progress?.activity), ["step-0", "step-1", "step-2"]);
	});

	it("drops a stale-incarnation batch item without mutating its replacement", async () => {
		const store = await makeStore();
		const run = (await store.mutate((ledger) => ledger.create({ objective: "replacement" }))).result;
		const updated = await persistBatchedProgress(store, { id: run.id, incarnation_id: "inc-stale" }, progress("stale"), 5);
		assert.equal(updated, undefined);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress, null);
	});
});
