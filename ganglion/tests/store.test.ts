import * as assert from "node:assert";
import { describe, it } from "vitest";
import { GanglionLedger, canTransition } from "../extension/store.ts";
import { GanglionError } from "../extension/schema.ts";

describe("GanglionLedger", () => {
	it("creates a default 3-member group", () => {
		const l = new GanglionLedger();
		const g = l.create({ name: "demo" });
		assert.equal(g.id, "ganglion-001");
		assert.equal(g.name, "demo");
		assert.equal(g.status, "forming");
		assert.equal(g.members.length, 3);
		assert.equal(l.current_ganglion_id, g.id);
	});

	it("creates explicit members with normalized capabilities", () => {
		const g = new GanglionLedger().create({ members: [{ id: "LION-API", role: "api", capabilities: ["API", "Node JS"] }] });
		assert.equal(g.members[0]?.id, "lion-api");
		assert.deepEqual(g.members[0]?.capabilities, ["api", "node-js"]);
	});

	it("add/update/remove member", () => {
		const l = new GanglionLedger();
		const g = l.create({ member_count: 1 });
		l.addMember(g.id, { id: "lion-docs", role: "docs", capabilities: ["docs"] });
		let cur = l.get(g.id)!;
		assert.equal(cur.members.length, 2);
		cur = l.updateMember(g.id, "lion-docs", { status: "offline", capabilities: ["markdown"] });
		assert.equal(cur.members.find((m) => m.id === "lion-docs")?.status, "offline");
		assert.deepEqual(cur.members.find((m) => m.id === "lion-docs")?.capabilities, ["markdown"]);
		cur = l.removeMember(g.id, "lion-docs");
		assert.equal(cur.members.length, 1);
	});

	it("allocates by priority, capability, and max_parallel", () => {
		const l = new GanglionLedger();
		const g = l.create({
			max_parallel: 2,
			members: [
				{ id: "lion-api", capabilities: ["api"] },
				{ id: "lion-test", capabilities: ["test"] },
				{ id: "lion-doc", capabilities: ["docs"] },
			],
		});
		const a = l.allocate(g.id, {
			context: "shared",
			tasks: [
				{ id: "task-low", title: "Docs", priority: "low", required_capabilities: ["docs"] },
				{ id: "task-api", title: "API", priority: "critical", required_capabilities: ["api"] },
				{ id: "task-test", title: "Tests", priority: "high", required_capabilities: ["test"] },
			],
		});
		assert.equal(a.status, "active");
		assert.equal(a.allocations.length, 2);
		assert.deepEqual(a.allocations.map((x) => x.task_id), ["task-api", "task-test"]);
		assert.equal(a.allocations[0]?.member_id, "lion-api");
		assert.equal(a.members.filter((m) => m.status === "busy").length, 2);
	});

	it("skips tasks with no matching capability", () => {
		const l = new GanglionLedger();
		const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] });
		const a = l.allocate(g.id, { tasks: [{ id: "task-docs", title: "Docs", required_capabilities: ["docs"] }] });
		assert.equal(a.allocations.length, 0);
		assert.equal(a.members[0]?.status, "available");
	});

	it("records terminal outcome and releases member capacity", () => {
		const l = new GanglionLedger();
		const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] });
		l.allocate(g.id, { tasks: [{ id: "task-api", title: "API", required_capabilities: ["api"] }] });
		const r = l.record(g.id, { allocation_id: "alloc-001", lion_run_id: "run-001", status: "completed", summary: "done" });
		assert.equal(r.allocations[0]?.status, "completed");
		assert.equal(r.members[0]?.status, "available");
		assert.equal(r.members[0]?.last_run_id, "run-001");
	});

	it("reconciles busy members from terminal LION runs", () => {
		const l = new GanglionLedger();
		const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] });
		l.allocate(g.id, { tasks: [{ id: "task-api", title: "API", required_capabilities: ["api"] }] });
		const report = l.reconcile(g.id, [{ id: "run-001", agent_id: "lion-api", task_id: "task-api", status: "completed", summary: "done", updated_at: "2026-01-01T00:00:00.000Z" }]);
		assert.equal(report.released.length, 1);
		assert.equal(report.released[0]?.allocation_id, "alloc-001");
		assert.equal(report.ganglion.allocations[0]?.status, "completed");
		assert.equal(report.ganglion.allocations[0]?.lion_run_id, "run-001");
		assert.equal(report.ganglion.members[0]?.status, "available");
		assert.equal(report.ganglion.members[0]?.last_run_id, "run-001");
	});

	it("release cancels active allocation", () => {
		const l = new GanglionLedger();
		const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] });
		l.allocate(g.id, { tasks: [{ id: "task-api", title: "API" }] });
		const r = l.release(g.id, "alloc-001");
		assert.equal(r.allocations[0]?.status, "cancelled");
		assert.equal(r.members[0]?.status, "available");
	});

	it("busy member cannot be removed", () => {
		const l = new GanglionLedger();
		const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] });
		l.allocate(g.id, { tasks: [{ id: "task-api", title: "API" }] });
		assert.throws(() => l.removeMember(g.id, "lion-api"), GanglionError);
	});

	it("status transitions are enforced", () => {
		assert.ok(canTransition("forming", "active"));
		assert.ok(canTransition("active", "paused"));
		assert.ok(!canTransition("completed", "active"));
		const l = new GanglionLedger();
		const g = l.create();
		l.setStatus(g.id, "active");
		l.setStatus(g.id, "completed");
		assert.throws(() => l.setStatus(g.id, "active"), GanglionError);
	});

	it("list/summary/delete and JSON round-trip", () => {
		const l = new GanglionLedger("p");
		const a = l.create({ name: "a" });
		l.create({ name: "b" });
		l.setStatus(a.id, "active");
		assert.equal(l.list({ status: "active" }).length, 1);
		assert.equal(l.summary().total, 2);
		const back = GanglionLedger.fromJSON(l.toJSON());
		assert.equal(back.get(a.id)?.name, "a");
		assert.equal(back.current_ganglion_id, "ganglion-002");
		back.delete("ganglion-002");
		assert.equal(back.all().length, 1);
	});

	it("coerces bad JSON safely", () => {
		const l = GanglionLedger.fromJSON({ ganglions: { "ganglion-x": { status: "wat", max_parallel: 999, members: [{ status: "bad", capabilities: ["API"] }], allocations: [{ status: "no", priority: "x" }] } } });
		const g = l.get("ganglion-x")!;
		assert.equal(g.status, "forming");
		assert.equal(g.max_parallel, 20);
		assert.equal(g.members[0]?.status, "offline");
		assert.deepEqual(g.members[0]?.capabilities, ["api"]);
		assert.equal(g.allocations[0]?.status, "failed");
		assert.equal(g.allocations[0]?.priority, "medium");
	});
});
