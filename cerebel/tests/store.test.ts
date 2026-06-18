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
		const d = l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] });
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

	it("records completion and decides to complete", () => {
		const l = new CerebelLedger();
		const w = l.planWave({ tasks: [{ id: "task-001", title: "A" }] });
		l.dispatch(w.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001" }] });
		const r = l.record(w.id, { assignment_id: "assign-001", lion_run_id: "run-001", outcome: "completed", summary: "done", changed_files: ["a.ts"], tests_run: ["npm test"] });
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
