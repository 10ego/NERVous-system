import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { CerebelStore, FileBackend } from "../extension/backend.ts";
import { reconcileCleanupPendingSettlements } from "../extension/cleanup-reconciler.ts";
import { CerebelLedger } from "../extension/store.ts";
import { LionLedger } from "../../lion/extension/store.ts";
import { GanglionLedger } from "../../ganglion/extension/store.ts";

function memoryStore<T>(ledger: T) {
	return {
		async query<R>(fn: (value: T) => R) { return { result: fn(ledger) }; },
		async mutate<R>(fn: (value: T) => R) { return { result: fn(ledger) }; },
	};
}

async function cerebelStores() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-cleanup-reconcile-"));
	const location = { cerebelPath: path.join(dir, "cerebel.json"), dir };
	return { dir, first: new CerebelStore(new FileBackend(location)), fresh: () => new CerebelStore(new FileBackend(location)) };
}

function setupGanglion() {
	const ledger = new GanglionLedger();
	const ganglion = ledger.create({ member_count: 1 });
	ledger.allocate(ganglion.id, { tasks: [{ id: "task-001", title: "cleanup task" }] });
	return { ledger, ganglionId: ganglion.id, allocationId: "alloc-001" };
}

const report = { outcome: "completed" as const, summary: "reconciled done", changed_files: [], tests_run: ["npm test"], blockers: [], next_steps: [] };

describe("cleanup-pending settlement reconciliation", () => {
	it("settles CEREBEL and an immutable GANGLION allocation once after registry loss", async () => {
		const stores = await cerebelStores();
		const lionLedger = new LionLedger();
		const run = lionLedger.create({ objective: "late cleanup", runner_mode: "rpc" });
		const ganglion = setupGanglion();
		const wave = (await stores.first.mutate((ledger) => ledger.planWave({
			assignments: [{ task_id: "task-001", objective: "cleanup task", ganglion_id: ganglion.ganglionId, ganglion_allocation_id: ganglion.allocationId }],
		}))).result;
		await stores.first.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: run.id, lion_run_incarnation_id: run.incarnation_id! }] }));
		await stores.first.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", run.id, run.incarnation_id!));
		assert.equal(ganglion.ledger.linkRunIfUnlinked(ganglion.ganglionId, ganglion.allocationId, run.id, run.incarnation_id!).committed, true);
		lionLedger.updateControl(run.id, {
			pid: 8181,
			pgid: 8181,
			process_identity: "boot-a:settled-child",
			cleanup_pending: {
				observed_at: run.started_at,
				incarnation_id: run.incarnation_id ?? null,
				pid: 8181,
				pgid: 8181,
				process_identity: "boot-a:settled-child",
			},
		});

		// Simulate process-local registry loss, then a separately reconciled exact LION terminal state.
		lionLedger.finish(run.id, { output: "done", report });
		const freshStore = stores.fresh();
		let ganglionMutations = 0;
		const ganglionStore = {
			...memoryStore(ganglion.ledger),
			async mutate<R>(fn: (value: GanglionLedger) => R) { ganglionMutations++; return { result: fn(ganglion.ledger) }; },
		};
		const first = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: freshStore,
			lionStore: memoryStore(lionLedger),
			ganglionStore,
		});
		assert.equal(first[0]?.settled, true);
		const settledWave = (await freshStore.query((ledger) => ledger.get(wave.id))).result!;
		assert.equal(settledWave.assignments[0]?.status, "completed");
		assert.equal(settledWave.assignments[0]?.cleanup_pending_settlement, null);
		const settledGanglion = ganglion.ledger.get(ganglion.ganglionId)!;
		assert.equal(settledGanglion.allocations[0]?.status, "completed");
		assert.equal(settledGanglion.allocations[0]?.lion_run_id, run.id);
		assert.equal(settledGanglion.allocations[0]?.lion_run_incarnation_id, run.incarnation_id);
		assert.equal(settledGanglion.members[0]?.status, "available");
		assert.equal(ganglionMutations, 2);

		const repeated = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: stores.fresh(),
			lionStore: memoryStore(lionLedger),
			ganglionStore,
		});
		assert.deepEqual(repeated, []);
		assert.equal(ganglionMutations, 2);
	});

	it("proves marked child exit without signaling and settles after fresh-process registry loss", async () => {
		const stores = await cerebelStores();
		const lionLedger = new LionLedger();
		const run = lionLedger.create({ objective: "lost supervisor", runner_mode: "rpc" });
		lionLedger.updateControl(run.id, {
			pid: 9191,
			process_identity: "boot-a:lost-child",
			last_seen_at: run.started_at,
			cleanup_pending: {
				observed_at: run.started_at,
				incarnation_id: run.incarnation_id ?? null,
				pid: 9191,
				pgid: null,
				process_identity: "boot-a:lost-child",
			},
		});
		const wave = (await stores.first.mutate((ledger) => ledger.planWave({ assignments: [{ objective: "lost supervisor" }] }))).result;
		await stores.first.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: run.id, lion_run_incarnation_id: run.incarnation_id! }] }));
		await stores.first.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", run.id, run.incarnation_id!));
		let signals = 0;
		const result = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: stores.fresh(),
			lionStore: memoryStore(lionLedger),
			isLionPidAlive: () => false,
			getLionProcessIdentity: () => { signals++; return null; },
			lionReconcileNowMs: Date.parse(run.started_at) + 60_000,
			lionReconcileStaleAfterMs: 1,
			activeLionRunRefs: [],
		});
		assert.equal(signals, 0, "dead-PID observation must not become signaling or reattachment authority");
		assert.equal(lionLedger.get(run.id)?.status, "failed");
		assert.equal(result[0]?.settled, true);
		const waveAfter = (await stores.fresh().query((ledger) => ledger.get(wave.id))).result!;
		assert.equal(waveAfter.assignments[0]?.status, "failed");
		assert.equal(waveAfter.assignments[0]?.cleanup_pending_settlement, null);
	});

	it("retains capacity after a crash-between-writes left no exact LION cleanup evidence", async () => {
		const stores = await cerebelStores();
		const lionLedger = new LionLedger();
		const run = lionLedger.create({ objective: "crash between stores", runner_mode: "rpc" });
		lionLedger.updateControl(run.id, { last_seen_at: run.started_at });
		const ganglion = setupGanglion();
		const wave = (await stores.first.mutate((ledger) => ledger.planWave({
			assignments: [{ task_id: "task-001", objective: "cleanup task", ganglion_id: ganglion.ganglionId, ganglion_allocation_id: ganglion.allocationId }],
		}))).result;
		await stores.first.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: run.id, lion_run_incarnation_id: run.incarnation_id! }] }));
		// Reproduce the old write order: the CEREBEL obligation committed, then
		// the process crashed before the exact LION observation could commit.
		await stores.first.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", run.id, run.incarnation_id!));
		let ganglionMutations = 0;
		const result = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: stores.fresh(),
			lionStore: memoryStore(lionLedger),
			ganglionStore: {
				...memoryStore(ganglion.ledger),
				async mutate<R>(fn: (value: GanglionLedger) => R) { ganglionMutations++; return { result: fn(ganglion.ledger) }; },
			},
			isLionPidAlive: () => true,
			lionReconcileNowMs: Date.parse(run.started_at) + 60_000,
			lionReconcileStaleAfterMs: 1,
			activeLionRunRefs: [],
		});
		assert.equal(lionLedger.get(run.id)?.status, "failed", "generic owner-loss reconciliation demonstrates why settlement needs its own evidence gate");
		assert.equal(result[0]?.settled, false);
		assert.match(result[0]?.reason ?? "", /matching durable cleanup evidence/);
		assert.equal(ganglionMutations, 0);
		const retainedWave = (await stores.fresh().query((ledger) => ledger.get(wave.id))).result!;
		assert.equal(retainedWave.assignments[0]?.status, "dispatched");
		assert.ok(retainedWave.assignments[0]?.cleanup_pending_settlement);
		assert.equal(ganglion.ledger.get(ganglion.ganglionId)?.members[0]?.status, "busy");
	});

	it("never clears an obligation when current capacity provenance differs", async () => {
		const stores = await cerebelStores();
		const lionLedger = new LionLedger();
		const run = lionLedger.create({ objective: "late cleanup", runner_mode: "rpc" });
		const ganglion = setupGanglion();
		const wave = (await stores.first.mutate((ledger) => ledger.planWave({
			assignments: [{ task_id: "task-001", objective: "cleanup task", ganglion_id: ganglion.ganglionId, ganglion_allocation_id: ganglion.allocationId }],
		}))).result;
		await stores.first.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: run.id, lion_run_incarnation_id: run.incarnation_id! }] }));
		await stores.first.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", run.id, run.incarnation_id!));
		lionLedger.finish(run.id, { output: "done", report });

		const persisted = (await stores.first.query((ledger) => ledger.get(wave.id))).result!;
		const corrupted = structuredClone(persisted);
		corrupted.assignments[0]!.ganglion_id = "ganglion-replacement";
		corrupted.assignments[0]!.ganglion_allocation_id = "alloc-replacement";
		const corruptedLedger = new CerebelLedger(undefined, [corrupted]);
		let ganglionMutations = 0;
		const result = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: memoryStore(corruptedLedger) as never,
			lionStore: memoryStore(lionLedger),
			ganglionStore: {
				...memoryStore(ganglion.ledger),
				async mutate<R>(fn: (value: GanglionLedger) => R) { ganglionMutations++; return { result: fn(ganglion.ledger) }; },
			},
		});
		assert.equal(result[0]?.settled, false);
		assert.match(result[0]?.reason ?? "", /capacity provenance differs/);
		assert.equal(ganglionMutations, 0);
		const unchanged = corruptedLedger.get(wave.id)!.assignments[0]!;
		assert.equal(unchanged.status, "dispatched");
		assert.equal(unchanged.cleanup_pending_settlement?.ganglion_id, ganglion.ganglionId);
		assert.equal(unchanged.ganglion_id, "ganglion-replacement");
	});

	it("ignores a replacement LION incarnation and retains the exact obligation", async () => {
		const stores = await cerebelStores();
		const lionLedger = new LionLedger();
		const original = lionLedger.create({ objective: "original", runner_mode: "rpc" });
		const wave = (await stores.first.mutate((ledger) => ledger.planWave({ assignments: [{ objective: "original" }] }))).result;
		await stores.first.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: original.id, lion_run_incarnation_id: original.incarnation_id! }] }));
		await stores.first.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", original.id, original.incarnation_id!));
		lionLedger.finish(original.id, { output: "old", report, status: "failed" });
		lionLedger.delete(original.id);
		const replacement = lionLedger.create({ objective: "replacement", runner_mode: "rpc" });
		assert.equal(replacement.id, original.id);
		assert.notEqual(replacement.incarnation_id, original.incarnation_id);

		const result = await reconcileCleanupPendingSettlements(stores.dir, {
			cerebelStore: stores.fresh(),
			lionStore: memoryStore(lionLedger),
		});
		assert.equal(result[0]?.settled, false);
		assert.match(result[0]?.reason ?? "", /not terminal/);
		const unchanged = (await stores.fresh().query((ledger) => ledger.get(wave.id))).result!;
		assert.equal(unchanged.assignments[0]?.status, "dispatched");
		assert.equal(unchanged.assignments[0]?.cleanup_pending_settlement?.lion_run_incarnation_id, original.incarnation_id);
	});
});
