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
		assert.throws(() => l.delete(b.id), /cannot delete nonterminal/);
		l.finish(b.id, { output: "ok", report: null });
		assert.equal(l.delete(b.id).id, b.id);
		assert.equal(l.all().length, 1);
	});

	it("tracks process control, cancellation, and stale PID reconciliation", () => {
		const l = new LionLedger();
		const running = l.create({ objective: "run" });
		const controlled = l.updateControl(running.id, { pid: 123, pgid: 123, started_at: "2026-01-01T00:00:00.000Z" });
		assert.equal(controlled.control?.pid, 123);
		const cancel = l.requestCancel(running.id, "user asked");
		assert.equal(cancel.signal, "SIGTERM");
		assert.equal(cancel.pid, 123);
		const delivered = l.markCancelDelivery(running.id, "not_attached");
		assert.equal(delivered.control?.cancel_delivery_status, "not_attached");
		assert.equal(l.markCancelDelivery(running.id, "delivered").control?.cancel_delivery_status, "delivered");
		assert.equal(l.markCancelDelivery(running.id, "not_alive").control?.cancel_delivery_status, "delivered");
		const repeated = l.requestCancel(running.id, "repeat from another caller");
		assert.equal(repeated.run.control?.cancel_delivery_status, "delivered");
		const changed = l.reconcileControls(() => false, { now_ms: Date.now() + 60_000, stale_after_ms: 1 });
		assert.equal(changed[0]?.status, "aborted");
		assert.match(changed[0]?.error ?? "", /Cancelled/);
		const again = l.requestCancel(running.id, "again");
		assert.equal(again.already_terminal, true);

		const queued = l.create({ objective: "queued", start: false });
		const queuedCancel = l.requestCancel(queued.id, "not needed");
		assert.equal(queuedCancel.run.status, "aborted");
		assert.equal(queuedCancel.signal, undefined);
	});

	it("skips active and fresh records during control reconciliation", () => {
		const l = new LionLedger();
		const active = l.create({ objective: "active" });
		l.updateControl(active.id, { pid: 111, last_seen_at: "2026-01-01T00:00:00.000Z" });
		assert.equal(l.reconcileControls(() => false, { active_run_ids: [active.id], now_ms: Date.now() + 600_000, stale_after_ms: 1 }).length, 0);
		assert.equal(l.get(active.id)?.status, "running");

		const fresh = l.create({ objective: "fresh" });
		const freshNow = Date.now();
		l.updateControl(fresh.id, { pid: 222, last_seen_at: new Date(freshNow).toISOString() });
		assert.equal(l.reconcileControls(() => false, { now_ms: freshNow, stale_after_ms: 30_000 }).length, 0);
		assert.equal(l.get(fresh.id)?.status, "running");

		const stale = l.reconcileControls(() => false, { now_ms: Date.now() + 60_000, stale_after_ms: 30_000 });
		assert.equal(stale.some((r) => r.id === fresh.id && r.status === "failed"), true);
	});

	it("reconciles PID reuse only when process-birth identity proves replacement", () => {
		const l = new LionLedger();
		const replaced = l.create({ objective: "original process" });
		l.updateControl(replaced.id, { pid: 4242, process_identity: "boot-a:start-1", last_seen_at: replaced.started_at });
		const changed = l.reconcileControls(() => true, {
			now_ms: Date.parse(replaced.started_at) + 60_000,
			stale_after_ms: 1,
			get_process_identity: () => "boot-a:start-2",
		});
		assert.equal(changed[0]?.status, "failed");

		const same = l.create({ objective: "same process" });
		l.updateControl(same.id, { pid: 4343, process_identity: "boot-a:start-3", last_seen_at: same.started_at });
		assert.equal(l.reconcileControls(() => true, { now_ms: Date.parse(same.started_at) + 60_000, stale_after_ms: 1, get_process_identity: () => "boot-a:start-3" }).length, 0);
		const legacy = l.create({ objective: "legacy unverifiable" });
		l.updateControl(legacy.id, { pid: 4444, last_seen_at: legacy.started_at });
		assert.equal(l.reconcileControls(() => true, { now_ms: Date.parse(legacy.started_at) + 60_000, stale_after_ms: 1, get_process_identity: (pid) => pid === 4343 ? "boot-a:start-3" : "boot-a:start-other" }).length, 0);
	});

	it("reconciles a stale ownerless running run without process metadata", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "lost before attach" });
		const changed = l.reconcileControls(() => true, { now_ms: Date.now() + 60_000, stale_after_ms: 1, active_run_ids: [] });
		assert.equal(changed[0]?.id, run.id);
		assert.equal(changed[0]?.status, "failed");
		assert.match(changed[0]?.error ?? "", /owner was lost/i);
		assert.equal(changed[0]?.control?.pid, undefined);
		assert.equal(l.delete(run.id).id, run.id);
	});

	it("does not let cancellation bookkeeping postpone owner-loss reconciliation", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "lost owner" });
		const started = Date.parse(run.started_at);
		l.requestCancel(run.id, "first request");
		l.markCancelDelivery(run.id, "not_attached");
		l.requestCancel(run.id, "repeated request");
		const changed = l.reconcileControls(() => false, { now_ms: started + 30_001, stale_after_ms: 30_000, active_run_ids: [] });
		assert.equal(changed[0]?.status, "aborted");
		assert.match(changed[0]?.error ?? "", /Cancelled/);
	});

	it("fails open steering when control reconciliation terminalizes a run", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "rpc stale", runner_mode: "rpc" });
		l.updateControl(run.id, { pid: 456, last_seen_at: "2026-01-01T00:00:00.000Z" });
		l.steer(run.id, "pending at crash", { liveDeliveryAvailable: true });
		const changed = l.reconcileControls(() => false, { now_ms: Date.now() + 60_000, stale_after_ms: 1 });
		assert.equal(changed[0]?.status, "failed");
		assert.equal(changed[0]?.steering_messages?.[0]?.status, "delivery_failed");
		assert.match(changed[0]?.steering_messages?.[0]?.reason ?? "", /reconciled/);
	});

	it("does not write a delayed cancellation result into a reused run id", () => {
		const l = new LionLedger();
		const original = l.create({ objective: "original" });
		l.requestCancel(original.id, "stop");
		l.finish(original.id, { output: "", report: null, status: "aborted" });
		l.delete(original.id);
		const replacement = l.create({ objective: "replacement" });
		assert.equal(replacement.id, original.id);
		assert.notEqual(replacement.incarnation_id, original.incarnation_id);
		const stale = l.markCancelDeliveryIfCurrent(original.id, original.incarnation_id, "delivered");
		assert.equal(stale.committed, false);
		assert.equal(stale.run.control, null);
	});

	it("supports queued pre-start steering and rejects json running steering", () => {
		const l = new LionLedger();
		const queued = l.create({ objective: "queued", start: false });
		const accepted = l.steer(queued.id, "Prefer tests first");
		assert.equal(accepted.accepted, true);
		assert.equal(accepted.message.status, "queued");
		const started = l.start(queued.id);
		assert.equal(started.status, "running");
		assert.equal(started.steering_messages?.[0]?.status, "applied");

		const rejected = l.steer(started.id, "Change now");
		assert.equal(rejected.accepted, false);
		assert.equal(rejected.message.status, "rejected_running");
	});

	it("fences delayed steering writes by immutable run incarnation", () => {
		const l = new LionLedger();
		const original = l.create({ objective: "original", runner_mode: "rpc" });
		const originalMessage = l.steer(original.id, "old message", { liveDeliveryAvailable: true }).message;
		l.reservePendingSteeringIfCurrent(original.id, original.incarnation_id);
		l.finish(original.id, { output: "done", report: null, status: "failed", error: "done" });
		l.delete(original.id);
		const replacement = l.create({ objective: "replacement", runner_mode: "rpc" });
		const replacementMessage = l.steer(replacement.id, "new message", { liveDeliveryAvailable: true }).message;
		assert.equal(replacementMessage.id, originalMessage.id);
		const stale = l.markSteeringDeliveredIfCurrent(original.id, original.incarnation_id, originalMessage.id);
		assert.equal(stale.committed, false);
		assert.equal(l.get(replacement.id)?.steering_messages?.[0]?.status, "pending_delivery");
	});

	it("bounds durable steering messages and terminal history", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "bounded steering", runner_mode: "json" });
		for (let index = 0; index < 125; index++) l.steer(run.id, `${index}:${"x".repeat(5_000)}`);
		const current = l.get(run.id)!;
		assert.equal(current.steering_messages?.length, 100);
		assert.equal(current.steering_messages?.every((message) => message.message.length <= 4_000), true);
		assert.equal(current.steering_messages?.at(-1)?.id, "steer-125");
	});

	it("caps open steering while preserving every accepted queued instruction through start", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "queued history", start: false });
		for (let index = 0; index < 100; index++) l.steer(run.id, `queued-${index}`);
		assert.throws(() => l.steer(run.id, "overflow"), /maximum 100 open steering messages/);
		const started = l.start(run.id);
		assert.equal(started.steering_messages?.length, 100);
		assert.equal(started.steering_messages?.every((message) => message.status === "applied"), true);
		assert.equal(started.steering_messages?.[0]?.message, "queued-0");
		assert.equal(started.steering_messages?.at(-1)?.id, "steer-100");
	});

	it("tracks rpc live steering delivery states", () => {
		const l = new LionLedger();
		const run = l.create({ objective: "rpc", runner_mode: "rpc" });
		const pending = l.steer(run.id, "Change now", { liveDeliveryAvailable: true });
		assert.equal(pending.accepted, true);
		assert.equal(pending.message.status, "pending_delivery");
		const reserved = l.reservePendingSteering(run.id);
		assert.equal(reserved.length, 1);
		assert.equal(reserved[0]?.status, "delivering");
		assert.equal(l.reservePendingSteering(run.id).length, 0);
		let current = l.get(run.id)!;
		assert.equal(current.steering_messages?.[0]?.status, "delivering");
		current = l.markSteeringDelivered(run.id, reserved[0]!.id);
		assert.equal(current.steering_messages?.[0]?.status, "delivered");

		const failed = l.steer(run.id, "Try again", { liveDeliveryAvailable: true });
		const failedReserved = l.reservePendingSteering(run.id)[0]!;
		current = l.markSteeringFailed(run.id, failedReserved.id, "boom");
		assert.equal(current.steering_messages?.find((m) => m.id === failed.message.id)?.status, "delivery_failed");
		assert.match(current.steering_messages?.find((m) => m.id === failed.message.id)?.reason ?? "", /boom/);
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
