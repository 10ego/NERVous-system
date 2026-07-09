import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import {
	attachActiveRunProcess,
	beginActiveRun,
	cancelActiveRun,
	clearActiveRunsForTests,
	finishActiveRun,
	getActiveRunIds,
	replayPendingCancellation,
} from "../extension/active-runs.ts";

async function makeStore(label: string): Promise<LionStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lion-active-${label}-`));
	return new LionStore(new FileBackend({ runsPath: path.join(dir, "runs.json"), dir }));
}

afterEach(() => clearActiveRunsForTests());

describe("namespace-scoped active LION ownership", () => {
	it("isolates identical run ids across durable namespaces", async () => {
		const storeA = await makeStore("a");
		const storeB = await makeStore("b");
		const runA = (await storeA.mutate((l) => l.create({ objective: "A" }))).result;
		const runB = (await storeB.mutate((l) => l.create({ objective: "B" }))).result;
		assert.equal(runA.id, "run-001");
		assert.equal(runB.id, "run-001");
		assert.notEqual(storeA.namespaceId, storeB.namespaceId);

		let cancelledA = 0;
		let cancelledB = 0;
		const scopeA = { namespaceId: storeA.namespaceId, runId: runA.id };
		const scopeB = { namespaceId: storeB.namespaceId, runId: runB.id };
		const ownerA = beginActiveRun(scopeA, "json");
		const ownerB = beginActiveRun(scopeB, "json");
		attachActiveRunProcess(ownerA, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { cancelledA++; } });
		attachActiveRunProcess(ownerB, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { cancelledB++; } });

		assert.deepEqual(getActiveRunIds(storeA.namespaceId), ["run-001"]);
		assert.deepEqual(getActiveRunIds(storeB.namespaceId), ["run-001"]);
		assert.equal((await cancelActiveRun(scopeA)).delivered, true);
		assert.equal(cancelledA, 1);
		assert.equal(cancelledB, 0);
		finishActiveRun(ownerA);
		finishActiveRun(ownerB);
	});

	it("replays and coalesces cancellation recorded before process attachment", async () => {
		const store = await makeStore("replay");
		const run = (await store.mutate((l) => l.create({ objective: "cancel me" }))).result;
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id }, "json");
		await store.mutate((l) => l.requestCancel(run.id, "stop before attach"));
		const beforeAttach = await cancelActiveRun(owner);
		assert.equal(beforeAttach.delivered, false);
		if (!beforeAttach.delivered) await store.mutate((l) => l.markCancelDelivery(run.id, beforeAttach.reason));

		let deliveries = 0;
		attachActiveRunProcess(owner, {
			pid: process.pid,
			pgid: null,
			isAlive: () => true,
			cancel: async () => {
				deliveries++;
				await new Promise((resolve) => setTimeout(resolve, 5));
			},
		});
		const [first, second] = await Promise.all([
			replayPendingCancellation(owner, store),
			replayPendingCancellation(owner, store),
		]);
		assert.equal(first?.delivered, true);
		assert.equal(second?.delivered, true);
		assert.equal(deliveries, 1);
		const current = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(current.control?.cancel_delivery_status, "delivered");
		finishActiveRun(owner);
	});
});
