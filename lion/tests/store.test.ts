import * as assert from "node:assert";
import { describe, it } from "vitest";
import { LionLedger, canTransition } from "../extension/store.ts";
import { LionError } from "../extension/schema.ts";

describe("LionLedger", () => {
	it("creates running runs with auto ids and default agent ids", () => {
		const l = new LionLedger("proj");
		const r = l.create({ objective: "Implement tests", task_id: "task-001" });
		assert.equal(r.id, "run-001");
		assert.equal(r.agent_id, "lion-001");
		assert.equal(r.status, "running");
		assert.equal(r.task_id, "task-001");
	});

	it("can queue dry runs", () => {
		const r = new LionLedger().create({ objective: "x", start: false });
		assert.equal(r.status, "queued");
	});

	it("requires objective or task_id", () => {
		assert.throws(() => new LionLedger().create({ objective: "" }), LionError);
		assert.doesNotThrow(() => new LionLedger().create({ objective: "", task_id: "task-1" }));
	});

	it("finishes completed/blocked/failed from reports", () => {
		const l = new LionLedger();
		const a = l.create({ objective: "a" });
		assert.equal(l.finish(a.id, { output: "ok", report: { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] } }).status, "completed");
		const b = l.create({ objective: "b" });
		assert.equal(l.finish(b.id, { output: "blocked", report: { outcome: "blocked", summary: "no api key", changed_files: [], tests_run: [], blockers: ["no api key"], next_steps: [] } }).status, "blocked");
		const c = l.create({ objective: "c" });
		assert.equal(l.finish(c.id, { output: "bad", report: { outcome: "failed", summary: "bad", changed_files: [], tests_run: [], blockers: [], next_steps: [] } }).status, "failed");
	});

	it("enforces transitions", () => {
		assert.ok(canTransition("queued", "running"));
		assert.ok(canTransition("running", "completed"));
		assert.ok(!canTransition("completed", "running"));
		const l = new LionLedger();
		const r = l.create({ objective: "x" });
		l.finish(r.id, { output: "ok", report: null });
		assert.throws(() => l.start(r.id), LionError);
	});

	it("lists, summarizes, deletes", () => {
		const l = new LionLedger();
		const a = l.create({ objective: "a", agent_id: "lion-a" });
		const b = l.create({ objective: "b", agent_id: "lion-b" });
		l.finish(a.id, { output: "ok", report: null });
		assert.equal(l.list({ status: "completed" }).length, 1);
		assert.equal(l.list({ agent_id: "lion-b" })[0]?.id, b.id);
		assert.equal(l.summary().by_status.completed, 1);
		assert.equal(l.delete(b.id).id, b.id);
		assert.equal(l.all().length, 1);
	});

	it("updates and round-trips bounded live progress snapshots", () => {
		const l = new LionLedger();
		const r = l.create({ objective: "stream" });
		const progress = l.updateProgress(r.id, {
			event: "tool_start",
			activity: "running command",
			active_tools: ["bash"],
			tool_uses: 1,
			turn_count: 2,
			token_total: 1234,
			last_text: "hello",
			last_event_at: "2026-01-01T00:00:00.000Z",
		});
		assert.equal(progress.progress?.event, "tool_start");
		assert.deepEqual(progress.progress?.active_tools, ["bash"]);
		assert.equal(progress.updated_at, "2026-01-01T00:00:00.000Z");

		const back = LionLedger.fromJSON(l.toJSON());
		assert.equal(back.get(r.id)?.progress?.activity, "running command");
		l.finish(r.id, { output: "ok", report: null });
		assert.throws(() => l.updateProgress(r.id, { activity: "late" }), LionError);
	});

	it("round-trips through JSON and coerces bad values", () => {
		const l = new LionLedger("p");
		const r = l.create({ objective: "x", tools: ["read", "bash"] });
		l.finish(r.id, { output: "out", report: { outcome: "partial", summary: "some", changed_files: ["a"], tests_run: ["npm test"], blockers: [], next_steps: ["review"] } });
		const back = LionLedger.fromJSON(l.toJSON());
		assert.equal(back.get(r.id)?.report?.outcome, "partial");
		assert.deepEqual(back.get(r.id)?.tools, ["read", "bash"]);
		assert.equal(back.get(r.id)?.progress, null);

		const bad = LionLedger.fromJSON({ runs: { "run-x": { status: "wat", agent_id: 123, objective: 5, progress: { event: "nope", activity: 7, active_tools: ["read", 1], tool_uses: 2.8 } } } });
		assert.equal(bad.get("run-x")?.status, "failed");
		assert.equal(bad.get("run-x")?.agent_id, "lion-unknown");
		assert.equal(bad.get("run-x")?.progress?.event, "heartbeat");
		assert.deepEqual(bad.get("run-x")?.progress?.active_tools, ["read"]);
	});
});
