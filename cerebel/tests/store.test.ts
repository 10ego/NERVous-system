import * as assert from "node:assert";
import { describe, it } from "vitest";
import { CerebelLedger, canTransition } from "../extension/store.ts";
import { CerebelError } from "../extension/schema.ts";

describe("CerebelLedger", () => {
	it("plans a wave from AXON task briefs", () => {
		const l = new CerebelLedger();
		const w = l.planWave({
			goal_id: "goal-001",
			max_parallel: 2,
			context: "shared acceptance",
			tasks: [
				{ id: "task-001", title: "API", description: "CRUD", priority: "high" },
				{ id: "task-002", title: "Tests", priority: "medium" },
			],
		});
		assert.equal(w.id, "wave-001");
		assert.equal(w.status, "planned");
		assert.equal(w.assignments.length, 2);
		assert.equal(w.assignments[0]?.task_id, "task-001");
		assert.equal(w.assignments[0]?.agent_id, "lion-001-001");
		assert.equal(l.current_wave_id, "wave-001");
	});

	it("plans direct assignments too", () => {
		const w = new CerebelLedger().planWave({ assignments: [{ objective: "Do x", agent_id: "lion-x", priority: "critical", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] });
		assert.equal(w.assignments[0]?.agent_id, "lion-x");
		assert.equal(w.assignments[0]?.priority, "critical");
		assert.equal(w.assignments[0]?.ganglion_id, "ganglion-001");
		assert.equal(w.assignments[0]?.ganglion_allocation_id, "alloc-001");
	});

	it("requires at least one assignment", () => {
		assert.throws(() => new CerebelLedger().planWave({ tasks: [] }), CerebelError);
	});

	it("dispatches a wave and links LION run ids and GANGLION allocations", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		const d = l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] });
		assert.equal(d.status, "dispatched");
		assert.equal(d.assignments[0]?.status, "dispatched");
		assert.equal(d.assignments[0]?.lion_run_id, "run-001");
		assert.equal(d.assignments[0]?.ganglion_id, "ganglion-001");
		assert.equal(d.assignments[0]?.ganglion_allocation_id, "alloc-001");
		assert.equal(d.decision?.decision, "wait");
	});

	it("auto-dispatches up to max_parallel when no links are supplied", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ max_parallel: 1, tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
		const d = l.dispatch(w.id);
		assert.equal(d.assignments.filter((a) => a.status === "dispatched").length, 1);
		assert.equal(d.decision?.decision, "wait");
	});

	it("subtracts existing dispatches before repeated automatic dispatch", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ max_parallel: 2, tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }] });
		ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001" }] });
		const repeated = ledger.dispatch(wave.id);
		assert.equal(repeated.assignments.filter((assignment) => assignment.status === "dispatched").length, 2);
		assert.equal(repeated.assignments.filter((assignment) => assignment.status === "planned").length, 2);
	});

	it("preserves existing LION links on redispatch", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		assert.doesNotThrow(() => l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] }));
		assert.throws(() => l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-002", lion_run_incarnation_id: "inc-002" }] }), /cannot replace LION provenance/);
		assert.equal(l.get(w.id)?.assignments[0]?.lion_run_id, "run-001");
	});

	it("freezes GANGLION provenance once exact LION linkage exists", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ assignments: [{ objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] });
		ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		assert.equal(ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", "run-001", "inc-001").committed, true);
		assert.doesNotThrow(() => ledger.dispatch(wave.id, { links: [{
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-001",
			ganglion_id: "ganglion-001",
			ganglion_allocation_id: "alloc-001",
		}] }));
		assert.throws(() => ledger.dispatch(wave.id, { links: [{
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-001",
			ganglion_id: "ganglion-002",
			ganglion_allocation_id: "alloc-002",
		}] }), /cannot replace frozen GANGLION provenance/);
		assert.throws(() => ledger.record(wave.id, {
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-001",
			ganglion_allocation_id: "alloc-002",
			outcome: "completed",
		}), /cannot replace frozen GANGLION provenance/);
		const current = ledger.get(wave.id)?.assignments[0];
		assert.equal(current?.ganglion_id, "ganglion-001");
		assert.equal(current?.ganglion_allocation_id, "alloc-001");
		assert.equal(current?.status, "dispatched");
	});

	it("reserves cleanup-pending terminal records for exact settlement", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		assert.equal(ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", "run-001", "inc-001").committed, true);
		assert.throws(() => ledger.record(wave.id, {
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-001",
			outcome: "completed",
			summary: "ordinary record",
		}), /exact supervisor or reconciler settlement must confirm process exit/);
		assert.equal(ledger.get(wave.id)?.assignments[0]?.status, "dispatched");
		const settled = ledger.recordIfOwned(wave.id, "run-001", "inc-001", {
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-001",
			outcome: "completed",
			summary: "confirmed exit",
		});
		assert.equal(settled.committed, true);
		assert.ok(settled.assignment.cleanup_pending_settlement);
		assert.equal(ledger.completeCleanupPendingSettlementIfOwned(wave.id, "assign-001", "run-001", "inc-001"), true);
	});

	it("persists immutable LION incarnations and rejects same-id replacement links", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		assert.throws(() => l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001" }] }), /requires both lion_run_id and lion_run_incarnation_id/);
		const linked = l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-original" }] });
		assert.equal(linked.assignments[0]?.lion_run_incarnation_id, "inc-original");
		assert.throws(() => l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-replacement" }] }), /cannot replace LION provenance/);
		const stale = l.recordIfOwned(w.id, "run-001", "inc-replacement", {
			assignment_id: "assign-001",
			lion_run_id: "run-001",
			lion_run_incarnation_id: "inc-replacement",
			outcome: "completed",
		});
		assert.equal(stale.committed, false);
		assert.equal(stale.assignment.status, "dispatched");
	});

	it("never backfills or replaces existing LION provenance when recording", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-original", lion_run_incarnation_id: "inc-original" }] });
		assert.throws(() => l.record(w.id, {
			assignment_id: "assign-001",
			lion_run_id: "run-replacement",
			lion_run_incarnation_id: "inc-replacement",
			outcome: "completed",
		}), /cannot replace LION provenance/);
		const current = l.get(w.id)?.assignments[0];
		assert.equal(current?.lion_run_id, "run-original");
		assert.equal(current?.lion_run_incarnation_id, "inc-original");
		assert.equal(current?.status, "dispatched");
	});

	it("selects unguarded records by exact LION incarnation when run ids are reused", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-old", title: "Old" }, { id: "task-new", title: "New" }] });
		l.dispatch(w.id, { links: [
			{ assignment_id: "assign-001", lion_run_id: "run-reused", lion_run_incarnation_id: "inc-old" },
			{ assignment_id: "assign-002", lion_run_id: "run-reused", lion_run_incarnation_id: "inc-new" },
		] });
		assert.throws(() => l.record(w.id, { lion_run_id: "run-reused", outcome: "completed" }), /requires both lion_run_id and lion_run_incarnation_id/);
		const recorded = l.record(w.id, { lion_run_id: "run-reused", lion_run_incarnation_id: "inc-new", outcome: "completed", summary: "replacement done" });
		assert.equal(recorded.assignments[0]?.status, "dispatched");
		assert.equal(recorded.assignments[1]?.status, "completed");
		assert.equal(recorded.assignments[1]?.outcome_summary, "replacement done");
	});

	it("preserves explicit record selectors and exact clean-slate provenance", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] });
		const first = l.record(w.id, { assignment_id: "assign-001", lion_run_id: "run-new", lion_run_incarnation_id: "inc-new", outcome: "completed" });
		assert.equal(first.assignments[0]?.lion_run_id, "run-new");
		assert.equal(first.assignments[0]?.lion_run_incarnation_id, "inc-new");
		const second = l.record(w.id, { task_id: "task-b", outcome: "completed" });
		assert.equal(second.assignments[1]?.status, "completed");
		assert.equal(second.assignments[1]?.lion_run_id, null);
	});

	it("rejects persisted linked assignments without an exact incarnation instead of backfilling", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		const raw = l.toJSON() as any;
		raw.waves[w.id].assignments[0].lion_run_id = "run-legacy";
		raw.waves[w.id].assignments[0].lion_run_incarnation_id = null;
		assert.throws(() => CerebelLedger.fromJSON(raw), /delete\/reset this clean-slate record/);
	});

	it("requires an exact assignment id for guarded records", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-shared", title: "A" }, { id: "task-shared", title: "B" }] });
		l.dispatch(w.id, { links: [
			{ assignment_id: "assign-001", lion_run_id: "run-foreign", lion_run_incarnation_id: "inc-foreign" },
			{ assignment_id: "assign-002", lion_run_id: "run-local", lion_run_incarnation_id: "inc-local" },
		] });
		assert.throws(() => l.recordIfOwned(w.id, "run-local", "inc-local", {
			task_id: "task-shared",
			lion_run_id: "run-local",
			outcome: "completed",
		} as never), /requires assignment_id/);
		assert.equal(l.get(w.id)?.assignments[0]?.status, "dispatched");
		assert.equal(l.get(w.id)?.assignments[1]?.status, "dispatched");
	});

	it("rejects mismatched LION provenance in guarded records", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-local", lion_run_incarnation_id: "inc-local" }] });
		assert.throws(() => l.recordIfOwned(w.id, "run-local", "inc-local", {
			assignment_id: "assign-001",
			lion_run_id: "run-foreign",
			outcome: "completed",
			summary: "wrong provenance",
		}), /cannot write LION link/);
		assert.equal(l.get(w.id)?.assignments[0]?.lion_run_id, "run-local");
		assert.equal(l.get(w.id)?.assignments[0]?.status, "dispatched");
	});

	it("does not record guarded results against a nonterminal foreign link", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-foreign", lion_run_incarnation_id: "inc-foreign" }] });
		const result = l.recordIfOwned(w.id, "run-local", "inc-local", {
			assignment_id: "assign-001",
			lion_run_id: "run-local",
			outcome: "completed",
			summary: "local done",
		});
		assert.equal(result.committed, false);
		assert.equal(result.assignment.lion_run_id, "run-foreign");
		assert.equal(result.assignment.status, "dispatched");
	});

	it("does not redispatch terminal assignments", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		l.record(w.id, { assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001", outcome: "completed", summary: "done" });
		assert.throws(() => l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-002" }] }), CerebelError);
		assert.equal(l.get(w.id)?.assignments[0]?.lion_run_id, "run-001");
	});

	it("restores a planned wave after releasing every unlinked reservation", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ max_parallel: 2, tasks: [{ id: "task-001", title: "A" }, { id: "task-002", title: "B" }] });
		l.dispatch(w.id);
		const released = l.releaseReservations(w.id, ["assign-001", "assign-002"]);
		const current = l.get(w.id)!;
		assert.equal(released.length, 2);
		assert.equal(current.status, "planned");
		assert.equal(current.decision?.decision, "dispatch");
		assert.deepEqual(current.decision?.ready_assignment_ids, ["assign-001", "assign-002"]);
	});

	it("restores planned status when completed siblings leave every nonterminal assignment planned", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ max_parallel: 2, tasks: [{ id: "task-001", title: "A" }, { id: "task-002", title: "B" }] });
		l.dispatch(w.id, { links: [
			{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" },
			{ assignment_id: "assign-002" },
		] });
		l.record(w.id, { assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001", outcome: "completed" });
		l.releaseReservations(w.id, ["assign-002"]);
		const current = l.get(w.id)!;
		assert.equal(current.status, "planned");
		assert.equal(current.decision?.decision, "dispatch");
		assert.deepEqual(current.decision?.ready_assignment_ids, ["assign-002"]);
	});

	it("recovers stale dispatched reservations to a coherent planned wave", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001" }] });
		const recovered = l.recoverOrphanedReservations(w.id, { stale_after_ms: 0, now_ms: Date.now() + 1000 });
		const current = l.get(w.id)!;
		assert.equal(recovered.length, 1);
		assert.equal(current.status, "planned");
		assert.equal(current.assignments[0]?.status, "planned");
		assert.equal(current.decision?.decision, "dispatch");
		assert.deepEqual(current.decision?.ready_assignment_ids, ["assign-001"]);
		assert.match(current.assignments[0]?.outcome_summary ?? "", /recovered/);
	});

	it("records completion and decides to complete", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		const r = l.record(w.id, { assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001", outcome: "completed", summary: "done", changed_files: ["a.ts"], tests_run: ["npm test"] });
		assert.equal(r.status, "completed");
		assert.equal(r.decision?.decision, "complete");
		assert.deepEqual(r.assignments[0]?.changed_files, ["a.ts"]);
	});

	it("blocked assignment decides escalation", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id);
		const r = l.record(w.id, { task_id: "task-001", outcome: "blocked", summary: "blocked", blockers: ["missing secret"] });
		assert.equal(r.status, "blocked");
		assert.equal(r.decision?.decision, "escalate_to_amygdala");
	});

	it("failed assignment decides replan", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id);
		const r = l.record(w.id, { task_id: "task-001", outcome: "failed", summary: "failed" });
		assert.equal(r.status, "needs_replan");
		assert.equal(r.decision?.decision, "replan");
	});

	it("complete_wave requires all assignments complete or partial", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
		assert.throws(() => l.complete(w.id), CerebelError);
		l.dispatch(w.id);
		l.record(w.id, { task_id: "a", outcome: "completed" });
		l.record(w.id, { task_id: "b", outcome: "partial" });
		assert.equal(l.complete(w.id).status, "completed");
	});

	it("cancel marks unfinished assignments cancelled", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "a", title: "A" }] });
		const c = l.cancel(w.id);
		assert.equal(c.status, "cancelled");
		assert.equal(c.assignments[0]?.status, "cancelled");
		assert.equal(c.decision?.decision, "cancelled");
	});

	it("preserves cancelled wave status while terminal sibling records settle", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ tasks: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
		ledger.dispatch(wave.id);
		ledger.record(wave.id, { task_id: "a", outcome: "failed", summary: "failed first" });
		ledger.record(wave.id, { task_id: "b", outcome: "blocked", summary: "blocked first" });
		assert.equal(ledger.cancel(wave.id).status, "cancelled");
		const settled = ledger.record(wave.id, { task_id: "b", outcome: "completed", summary: "late sibling result" });
		assert.equal(settled.status, "cancelled");
		assert.equal(settled.decision?.decision, "cancelled");
		assert.equal(settled.assignments.find((assignment) => assignment.task_id === "b")?.status, "completed");
	});

	it("rejects malformed cleanup settlement obligations instead of erasing them", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ assignments: [{ objective: "cleanup", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] });
		ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] });
		ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", "run-001", "inc-001");
		const raw = ledger.toJSON() as any;
		raw.waves[wave.id].assignments[0].cleanup_pending_settlement.observed_at = 123;
		assert.throws(() => CerebelLedger.fromJSON(raw), /malformed cleanup_pending_settlement.*delete\/reset this clean-slate CEREBEL ledger/);

		const mismatched = ledger.toJSON() as any;
		mismatched.waves[wave.id].assignments[0].cleanup_pending_settlement.ganglion_allocation_id = "alloc-replacement";
		assert.throws(() => CerebelLedger.fromJSON(mismatched), /settlement provenance differs from the assignment/);
	});

	it("lists, summarizes, and round-trips JSON", () => {
		const l = new CerebelLedger("p");
		const a = l.planWave({ tasks: [{ id: "a", title: "A" }] });
		l.planWave({ tasks: [{ id: "b", title: "B" }] });
		l.cancel(a.id);
		assert.equal(l.list({ status: "cancelled" }).length, 1);
		assert.equal(l.summary().total, 2);
		const back = CerebelLedger.fromJSON(l.toJSON());
		assert.equal(back.get(a.id)?.status, "cancelled");
		assert.equal(back.current_wave_id, "wave-002");
	});

	it("coerces bad JSON to safe defaults", () => {
		const l = CerebelLedger.fromJSON({ waves: { "wave-x": { status: "wat", max_parallel: 999, assignments: [{ status: "no", priority: "zzz" }] } } });
		const w = l.get("wave-x")!;
		assert.equal(w.status, "needs_replan");
		assert.equal(w.max_parallel, 10);
		assert.equal(w.assignments[0]?.status, "failed");
		assert.equal(w.assignments[0]?.priority, "medium");
	});

	it("transition table protects terminal states", () => {
		assert.ok(canTransition("planned", "dispatched"));
		assert.ok(canTransition("dispatched", "collecting"));
		assert.ok(canTransition("collecting", "completed"));
		assert.ok(!canTransition("completed", "planned"));
	});
});
