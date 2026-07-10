import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import {
	attachActiveRunProcess,
	beginActiveRun,
	cancelActiveRun,
	clearActiveRunsForTests,
	finishActiveRun,
	getActiveRunIds,
	markActiveRunControlClosed,
	replayPendingCancellation,
} from "../extension/active-runs.ts";

async function makeStore(label: string): Promise<LionStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lion-active-${label}-`));
	return new LionStore(new FileBackend({ runsPath: path.join(dir, "runs.json"), dir }));
}

afterEach(() => {
	vi.useRealTimers();
	clearActiveRunsForTests();
});

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
		const scopeA = { namespaceId: storeA.namespaceId, runId: runA.id, incarnationId: runA.incarnation_id };
		const scopeB = { namespaceId: storeB.namespaceId, runId: runB.id, incarnationId: runB.incarnation_id };
		const ownerA = beginActiveRun(scopeA, "json");
		const ownerB = beginActiveRun(scopeB, "json");
		attachActiveRunProcess(ownerA, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { cancelledA++; return true; } });
		attachActiveRunProcess(ownerB, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { cancelledB++; return true; } });

		assert.deepEqual(getActiveRunIds(storeA.namespaceId), ["run-001"]);
		assert.deepEqual(getActiveRunIds(storeB.namespaceId), ["run-001"]);
		assert.equal((await cancelActiveRun(scopeA)).delivered, true);
		assert.equal(cancelledA, 1);
		assert.equal(cancelledB, 0);
		finishActiveRun(ownerA);
		finishActiveRun(ownerB);
	});

	it("rejects reused run ids while an owner remains active in the same namespace", async () => {
		const store = await makeStore("reuse");
		const scope = { namespaceId: store.namespaceId, runId: "run-001" };
		const owner = beginActiveRun(scope, "json");
		assert.throws(() => beginActiveRun(scope, "json"), /owner already exists/);
		finishActiveRun(owner);
		const replacement = beginActiveRun(scope, "json");
		finishActiveRun(replacement);
	});

	it("binds delayed cancellation to the original owner capability", async () => {
		const store = await makeStore("replacement");
		const scope = { namespaceId: store.namespaceId, runId: "run-001" };
		const original = beginActiveRun(scope, "json");
		attachActiveRunProcess(original, { pid: 101, pgid: null, isAlive: () => true, cancel: () => true });
		finishActiveRun(original);
		let replacementSignals = 0;
		const replacement = beginActiveRun(scope, "json");
		attachActiveRunProcess(replacement, { pid: 202, pgid: null, isAlive: () => true, cancel: () => { replacementSignals++; return true; } });

		const stale = await cancelActiveRun(original, "SIGKILL");
		assert.deepEqual(stale, { delivered: false, reason: "owner_replaced", pid: 202, pgid: null });
		assert.equal(replacementSignals, 0);
		finishActiveRun(replacement);
	});

	it("retains cancellation authority after RPC control closes but before process exit", async () => {
		const store = await makeStore("control-closed");
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001" }, "rpc");
		let signals = 0;
		attachActiveRunProcess(owner, { pid: 304, pgid: null, isAlive: () => true, cancel: () => { signals++; return true; } });
		markActiveRunControlClosed(owner);
		assert.equal((await cancelActiveRun(owner)).delivered, true);
		assert.equal(signals, 1);
		finishActiveRun(owner);
	});

	it("does not report delivery when the owned process handle sends no signal", async () => {
		const store = await makeStore("not-signaled");
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001" }, "json");
		attachActiveRunProcess(owner, { pid: 303, pgid: null, isAlive: () => true, cancel: () => false });
		const result = await cancelActiveRun(owner);
		assert.equal(result.delivered, false);
		if (!result.delivered) {
			assert.equal(result.reason, "not_signaled");
			assert.equal(result.pid, 303);
			assert.equal(result.owner?.ownerId, owner.ownerId);
		}
		finishActiveRun(owner);
	});

	it("replays, coalesces, and escalates cancellation recorded before process attachment", async () => {
		const store = await makeStore("replay");
		const run = (await store.mutate((l) => l.create({ objective: "cancel me" }))).result;
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "json");
		await store.mutate((l) => l.requestCancel(run.id, "stop before attach"));
		const beforeAttach = await cancelActiveRun(owner);
		assert.equal(beforeAttach.delivered, false);
		if (!beforeAttach.delivered) await store.mutate((l) => l.markCancelDelivery(run.id, beforeAttach.reason));

		const signals: string[] = [];
		attachActiveRunProcess(owner, {
			pid: process.pid,
			pgid: null,
			isAlive: () => true,
			cancel: async (signal) => {
				signals.push(signal);
				return true;
			},
		});
		const [first, second] = await Promise.all([
			replayPendingCancellation(owner, store, 1),
			replayPendingCancellation(owner, store, 1),
		]);
		assert.equal(first?.delivered, true);
		assert.equal(second?.delivered, true);
		assert.equal(signals.filter((signal) => signal === "SIGTERM").length, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		const current = (await store.query((l) => l.get(run.id))).result!;
		assert.equal(current.control?.cancel_delivery_status, "delivered");
		finishActiveRun(owner);
	});
});
