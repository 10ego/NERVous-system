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
	getActiveRunRefs,
	isActiveRunAttached,
	markActiveRunControlClosed,
	replayPendingCancellation,
	requestRunCancellation,
	requestRunCancellations,
	waitForRunSettlements,
} from "../extension/active-runs.ts";
import { LionLedger } from "../extension/store.ts";

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

	it("fences attachment and reconciliation references by exact incarnation", async () => {
		const store = await makeStore("exact-active-ref");
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: "inc-old" }, "rpc");
		attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => true });
		assert.equal(isActiveRunAttached({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: "inc-old" }, "rpc"), true);
		assert.equal(isActiveRunAttached({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: "inc-new" }, "rpc"), false);
		assert.deepEqual(getActiveRunRefs(store.namespaceId), [{ id: "run-001", incarnation_id: "inc-old" }]);
		finishActiveRun(owner);
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

	it("treats an explicit null legacy incarnation as exact rather than a wildcard", async () => {
		const store = await makeStore("legacy-null");
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: "replacement-incarnation" }, "json");
		let signals = 0;
		attachActiveRunProcess(owner, { pid: 305, pgid: null, isAlive: () => true, cancel: () => { signals++; return true; } });
		const result = await cancelActiveRun({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: null });
		assert.equal(result.delivered, false);
		if (!result.delivered) assert.equal(result.reason, "owner_replaced");
		assert.equal(signals, 0);
		finishActiveRun(owner);
	});

	it("bounds cancellation delivery concurrency while preserving result order", async () => {
		const store = await makeStore("bounded-delivery");
		const runs = (await store.mutate((ledger) => Array.from({ length: 20 }, (_, index) => ledger.create({ objective: `run-${index}` })))).result;
		let active = 0;
		let maxActive = 0;
		const owners = runs.map((run, index) => {
			const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "json");
			attachActiveRunProcess(owner, {
				pid: process.pid,
				pgid: null,
				isAlive: () => true,
				cancel: async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					try {
						await new Promise((resolve) => setTimeout(resolve, 10));
						if (index === 0) throw new Error("individual delivery failed");
						return true;
					} finally {
						active--;
					}
				},
			});
			return owner;
		});
		const results = await requestRunCancellations(store, runs.map((run) => ({ runId: run.id, expectedIncarnationId: run.incarnation_id, expectIncarnation: true })));
		assert.equal(maxActive, 8);
		assert.deepEqual(results.map((result) => result.run?.id), runs.map((run) => run.id));
		assert.equal(results[0]?.delivery?.delivered, false);
		assert.equal(results[0]?.delivery?.delivered === false && results[0].delivery.reason, "delivery_failed");
		assert.match(results[0]?.run?.control?.cancel_delivery_error ?? "", /individual delivery failed/);
		assert.equal(results.slice(1).every((result) => result.delivery?.delivered), true);
		for (const owner of owners) finishActiveRun(owner);
	});

	it("admits and persists a cancellation batch with two ledger mutations", async () => {
		const store = await makeStore("batch-admission");
		const runs = await Promise.all(["A", "B", "C"].map(async (objective) => (await store.mutate((ledger) => ledger.create({ objective }))).result));
		let mutations = 0;
		const counted = {
			namespaceId: store.namespaceId,
			query: store.query.bind(store),
			mutateMaybe: store.mutateMaybe.bind(store),
			mutate: async <T>(fn: (ledger: LionLedger) => T) => { mutations++; return store.mutate(fn); },
		};
		const results = await requestRunCancellations(counted, runs.map((run) => ({
			runId: run.id,
			reason: "batch stop",
			expectedIncarnationId: run.incarnation_id,
			expectIncarnation: true,
		})));
		assert.equal(mutations, 2, "one admission write plus one delivery-outcome write");
		assert.equal(results.length, 3);
		assert.equal(results.every((result) => !result.settled && result.delivery?.delivered === false && result.delivery.reason === "not_attached"), true);
	});

	it("treats missing and replacement cancellation targets as settled supersession", async () => {
		const store = await makeStore("missing-target");
		const missing = await requestRunCancellation(store, "run-001", "stale wave", { expectedIncarnationId: "old-incarnation" });
		assert.equal(missing.settled, true);
		assert.equal(missing.superseded, true);
		assert.equal(missing.run, undefined);

		const replacement = (await store.mutate((l) => l.create({ objective: "replacement" }))).result;
		const mismatched = await requestRunCancellation(store, replacement.id, "stale wave", { expectedIncarnationId: "old-incarnation" });
		assert.equal(mismatched.settled, true);
		assert.equal(mismatched.superseded, true);
		assert.equal(mismatched.run?.incarnation_id, replacement.incarnation_id);
		assert.equal(mismatched.run?.control?.cancel_requested_at, undefined);
	});

	it("does not settle a missing ledger run while its exact owner remains live", async () => {
		const store = await makeStore("missing-live-owner");
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001", incarnationId: "inc-live" }, "rpc");
		attachActiveRunProcess(owner, { pid: 999, pgid: null, isAlive: () => true, cancel: () => true });
		const missing = await requestRunCancellation(store, "run-001", "stale ledger", { expectedIncarnationId: "inc-live" });
		assert.equal(missing.settled, false);
		assert.equal(missing.superseded, false);
		const waited = await waitForRunSettlements(store, [{ id: "run-001", incarnation_id: "inc-live" }], 0);
		assert.equal(waited[0]?.settled, false);
		finishActiveRun(owner);
		const afterExit = await requestRunCancellation(store, "run-001", "retry", { expectedIncarnationId: "inc-live" });
		assert.equal(afterExit.settled, true);
		assert.equal(afterExit.superseded, true);
	});

	it("treats same-incarnation terminalization during delivery as settled", async () => {
		const store = await makeStore("terminal-during-delivery");
		const run = (await store.mutate((l) => l.create({ objective: "terminal during delivery" }))).result;
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "rpc");
		attachActiveRunProcess(owner, {
			pid: 307,
			pgid: null,
			isAlive: () => true,
			cancel: async () => { await store.mutate((l) => l.finish(run.id, { output: "", report: null, status: "aborted" })); return true; },
		});
		const result = await requestRunCancellation(store, run.id, "cancel", { expectedIncarnationId: run.incarnation_id });
		assert.equal(result.superseded, false);
		assert.equal(result.settled, true);
		assert.equal(result.run?.status, "aborted");
		finishActiveRun(owner);
	});

	it("treats replacement during cancellation delivery persistence as settled supersession", async () => {
		const store = await makeStore("replacement-during-delivery");
		const original = (await store.mutate((l) => l.create({ objective: "original" }))).result;
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: original.id, incarnationId: original.incarnation_id }, "json");
		attachActiveRunProcess(owner, {
			pid: 306,
			pgid: null,
			isAlive: () => true,
			cancel: async () => {
				await store.mutate((l) => { l.finish(original.id, { output: "", report: null, status: "aborted" }); l.delete(original.id); l.create({ objective: "replacement" }); });
				return true;
			},
		});
		const result = await requestRunCancellation(store, original.id, "cancel", { expectedIncarnationId: original.incarnation_id });
		assert.equal(result.superseded, true);
		assert.equal(result.settled, true);
		assert.notEqual(result.run?.incarnation_id, original.incarnation_id);
		assert.equal(result.run?.control?.cancel_requested_at, undefined);
		finishActiveRun(owner);
	});

	it("batches settlement checks for multiple runs into one ledger read per tick", async () => {
		vi.useFakeTimers();
		const ledger = new LionLedger();
		const first = ledger.create({ objective: "first" });
		const second = ledger.create({ objective: "second" });
		let reads = 0;
		const store = {
			namespaceId: "batch-test",
			async query<T>(fn: (current: LionLedger) => T) { return { result: fn(ledger) }; },
			async mutate<T>(fn: (current: LionLedger) => T) { return { result: fn(ledger) }; },
			async mutateMaybe<T>(fn: (current: LionLedger) => { result: T; changed: boolean }) { reads++; const outcome = fn(ledger); return { ...outcome }; },
		};
		const waiting = waitForRunSettlements(store, [first, second], 30, 10);
		await vi.advanceTimersByTimeAsync(30);
		const results = await waiting;
		assert.equal(results.length, 2);
		assert.equal(results.every((result) => !result.settled), true);
		assert.equal(reads, 3);
	});

	it("never lets adaptive polling sleep past the settlement timeout", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const ledger = new LionLedger();
		const run = ledger.create({ objective: "short timeout" });
		const store = {
			namespaceId: "short-timeout",
			async query<T>(fn: (current: LionLedger) => T) { return { result: fn(ledger) }; },
			async mutate<T>(fn: (current: LionLedger) => T) { return { result: fn(ledger) }; },
			async mutateMaybe<T>(fn: (current: LionLedger) => { result: T; changed: boolean }) { return fn(ledger); },
		};
		const waiting = waitForRunSettlements(store, [run], 1);
		await vi.advanceTimersByTimeAsync(1);
		const result = await waiting;
		assert.equal(result[0]?.settled, false);
		assert.equal(Date.now(), Date.parse("2026-01-01T00:00:00.001Z"));
	});

	it("reconciles a stale ownerless run before cancellation refreshes its grace", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const store = await makeStore("reconcile-before-cancel");
		const run = (await store.mutate((l) => l.create({ objective: "lost owner" }))).result;
		vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
		const result = await requestRunCancellation(store, run.id, "cancel lost owner", { expectedIncarnationId: run.incarnation_id });
		assert.equal(result.settled, true);
		assert.equal(result.run?.status, "failed");
		assert.match(result.run?.error ?? "", /owner was lost/i);
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
