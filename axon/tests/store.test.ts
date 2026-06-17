import * as assert from "node:assert";
import { describe, it } from "vitest";
import { Ledger } from "../extension/store.ts";
import { AxonError } from "../extension/schema.ts";

function fresh(): Ledger {
	return new Ledger("test");
}

describe("Ledger — create + ids", () => {
	it("creates tasks with auto-incrementing zero-padded ids", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b" });
		assert.equal(a.id, "task-001");
		assert.equal(b.id, "task-002");
	});

	it("requires a title", () => {
		assert.throws(() => fresh().create({ title: "" }), AxonError);
		assert.throws(() => fresh().create({ title: "   " }), AxonError);
	});

	it("rejects duplicate explicit ids", () => {
		const l = fresh();
		l.create({ id: "task-001", title: "a" });
		assert.throws(() => l.create({ id: "task-001", title: "b" }), AxonError);
	});

	it("auto-promotes a task with no deps to ready", () => {
		const t = fresh().create({ title: "x" });
		assert.equal(t.status, "ready");
	});

	it("keeps a task pending if dependencies are not satisfied", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b", dependencies: [a.id] });
		assert.equal(b.status, "pending");
	});
});

describe("Ledger — status state machine", () => {
	it("allows ready->in_progress and beyond", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.setStatus(t.id, "in_progress");
		l.setStatus(t.id, "needs_review");
		l.setStatus(t.id, "completed");
		assert.equal(l.get(t.id)?.status, "completed");
	});

	it("rejects illegal transitions", () => {
		const l = fresh();
		const dep = l.create({ title: "dep" });
		const t = l.create({ title: "x", dependencies: [dep.id] }); // pending
		assert.throws(() => l.setStatus(t.id, "in_progress"), AxonError); // pending -> in_progress illegal
		assert.throws(() => l.setStatus(t.id, "completed"), AxonError);
	});

	it("records a note on set_status", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.setStatus(t.id, "in_progress", "starting now");
		assert.equal(l.get(t.id)?.progress_notes.length, 1);
		assert.match(l.get(t.id)!.progress_notes[0]!.text, /starting now/);
	});

	it("entering needs_review sets review_status to under_review", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.setStatus(t.id, "in_progress");
		l.setStatus(t.id, "needs_review");
		assert.equal(l.get(t.id)?.review_status, "under_review");
	});

	it("completed is terminal", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.setStatus(t.id, "in_progress");
		l.setStatus(t.id, "completed");
		assert.throws(() => l.setStatus(t.id, "in_progress"), AxonError);
	});

	it("cannot mark ready when deps unsatisfied", () => {
		const l = fresh();
		const dep = l.create({ title: "dep" });
		const t = l.create({ title: "x", dependencies: [dep.id] }); // pending
		// dep is ready, not completed -> x cannot become ready
		assert.throws(() => l.setStatus(t.id, "ready"), AxonError);
	});
});

describe("Ledger — dependencies + readiness", () => {
	it("promotes a dependent to ready when its dep completes", () => {
		const l = fresh();
		const dep = l.create({ title: "dep" });
		const t = l.create({ title: "x", dependencies: [dep.id] });
		assert.equal(t.status, "pending");

		l.setStatus(dep.id, "in_progress");
		l.setStatus(dep.id, "completed");

		assert.equal(l.get(t.id)?.status, "ready");
	});

	it("recompute promotes eligible pending tasks (and completion auto-promotes)", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		l.setStatus(a.id, "in_progress");
		l.setStatus(a.id, "completed");
		const b = l.create({ title: "b", dependencies: [a.id] });
		// b auto-promotes since a is completed
		assert.equal(b.status, "ready");

		// c depends on d (unsatisfied) -> pending
		const d = l.create({ title: "d" });
		const c = l.create({ title: "c", dependencies: [d.id] });
		assert.equal(c.status, "pending");
		assert.ok(!l.recompute().includes(c.id)); // d not done yet

		// Completing d auto-promotes c (setStatus('completed') runs recompute).
		l.setStatus(d.id, "in_progress");
		const beforeComplete = l.get(c.id)!.status;
		assert.equal(beforeComplete, "pending");
		l.setStatus(d.id, "completed");
		assert.equal(l.get(c.id)?.status, "ready");

		// Manual recompute on a freshly-built ledger with unsatisfied-then-satisfied
		// deps (e.g. after deserialization) still promotes remaining pending tasks.
		const l2 = Ledger.fromJSON(l.toJSON());
		const stillPending = l2.list({ status: "pending" });
		assert.deepEqual(stillPending, []); // none left pending
	});

	it("supports AND dependencies (all must complete)", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b" });
		const c = l.create({ title: "c", dependencies: [a.id, b.id] });
		assert.equal(c.status, "pending");
		l.setStatus(a.id, "in_progress");
		l.setStatus(a.id, "completed");
		assert.equal(l.get(c.id)?.status, "pending"); // b not done
		l.setStatus(b.id, "in_progress");
		l.setStatus(b.id, "completed");
		assert.equal(l.get(c.id)?.status, "ready");
	});
});

describe("Ledger — cycle prevention", () => {
	it("rejects self-dependency", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		assert.throws(() => l.update(a.id, { dependencies: [a.id] }), AxonError);
	});

	it("rejects a direct dependency cycle", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b", dependencies: [a.id] });
		// a depends on b -> cycle b->a->b
		assert.throws(() => l.update(a.id, { dependencies: [b.id] }), AxonError);
	});

	it("rejects a transitive dependency cycle", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b", dependencies: [a.id] });
		const c = l.create({ title: "c", dependencies: [b.id] });
		// a depends on c -> a->c->b->a
		assert.throws(() => l.update(a.id, { dependencies: [c.id] }), AxonError);
	});

	it("rejects self-parenting and parent-chain cycles", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		assert.throws(() => l.update(a.id, { parent_id: a.id }), AxonError);
		const b = l.create({ title: "b", parent_id: a.id });
		// making a a child of b -> a->b->a
		assert.throws(() => l.update(a.id, { parent_id: b.id }), AxonError);
	});

	it("allows diamond dependencies (not a cycle)", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b", dependencies: [a.id] });
		const c = l.create({ title: "c", dependencies: [a.id] });
		// d depends on b and c (diamond) — fine
		const d = l.create({ title: "d", dependencies: [b.id, c.id] });
		assert.equal(d.status, "pending");
	});
});

describe("Ledger — notes/blockers/artifacts/review", () => {
	it("appends progress notes with author", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.addNote(t.id, "step one", "lion-1");
		l.addNote(t.id, "step two");
		const got = l.get(t.id)!;
		assert.equal(got.progress_notes.length, 2);
		assert.equal(got.progress_notes[0]!.author, "lion-1");
		assert.equal(got.progress_notes[1]!.author, undefined);
	});

	it("adds and resolves blockers by index", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.addBlocker(t.id, "waiting on API");
		l.addBlocker(t.id, "missing spec");
		l.resolveBlocker(t.id, 0);
		const got = l.get(t.id)!;
		assert.equal(got.blockers[0]!.resolved, true);
		assert.equal(got.blockers[1]!.resolved, false);
		assert.throws(() => l.resolveBlocker(t.id, 99), AxonError);
	});

	it("adds artifacts", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.addArtifact(t.id, { path: "src/api.ts", kind: "file" });
		assert.equal(l.get(t.id)?.artifacts[0]?.path, "src/api.ts");
	});

	it("sets review status", () => {
		const l = fresh();
		const t = l.create({ title: "x" });
		l.setReview(t.id, "approved");
		assert.equal(l.get(t.id)?.review_status, "approved");
	});
});

describe("Ledger — delete + referential cleanup", () => {
	it("deletes a task and removes it from others' dependencies", () => {
		const l = fresh();
		const a = l.create({ title: "a" });
		const b = l.create({ title: "b", dependencies: [a.id] });
		assert.ok(l.delete(a.id));
		assert.ok(!l.has(a.id));
		assert.deepEqual(l.get(b.id)?.dependencies, []);
	});

	it("orphans children by clearing parent_id", () => {
		const l = fresh();
		const parent = l.create({ title: "p" });
		const child = l.create({ title: "c", parent_id: parent.id });
		l.delete(parent.id);
		assert.equal(l.get(child.id)?.parent_id, null);
	});

	it("delete returns false for unknown id", () => {
		assert.equal(fresh().delete("task-999"), false);
	});
});

describe("Ledger — queries + summary", () => {
	it("filters by status/assignee/parent/ready/blocked", () => {
		const l = fresh();
		const a = l.create({ title: "a", assigned_to: "lion-1" }); // ready
		const b = l.create({ title: "b" }); // ready
		l.setStatus(a.id, "in_progress");
		assert.equal(l.list({ status: "in_progress" }).length, 1);
		assert.equal(l.list({ assigned_to: "lion-1" }).length, 1);
		assert.equal(l.list({ ready_only: true }).length, 1); // only b
		assert.equal(l.readyTasks().length, 1);
	});

	it("summary counts statuses", () => {
		const l = fresh();
		l.create({ title: "a" });
		l.create({ title: "b" });
		const s = l.summary();
		assert.equal(s.total, 2);
		assert.equal((s.by_status["ready"] ?? 0), 2);
		assert.equal(s.terminal, 0);
		assert.equal(s.ready.length, 2);
	});
});

describe("Ledger — serialization round-trip", () => {
	it("toJSON/fromJSON preserves tasks", () => {
		const l = fresh();
		const a = l.create({ title: "a", description: "d", priority: "high" });
		l.setStatus(a.id, "in_progress");
		l.addNote(a.id, "note", "lion-1");
		const json = l.toJSON();
		const back = Ledger.fromJSON(json);
		assert.equal(back.get(a.id)?.title, "a");
		assert.equal(back.get(a.id)?.status, "in_progress");
		assert.equal(back.get(a.id)?.priority, "high");
		assert.equal(back.get(a.id)?.progress_notes.length, 1);
	});

	it("fromJSON coerces unknown enum values to safe defaults", () => {
		const bad = {
			meta: { version: 1, updated_at: "x" },
			tasks: {
				"task-001": { id: "task-001", title: "t", status: "bogus", priority: "nope", review_status: "wat" },
			},
		};
		const l = Ledger.fromJSON(bad);
		const t = l.get("task-001");
		assert.ok(t);
		assert.equal(t!.status, "pending");
		assert.equal(t!.priority, "medium");
		assert.equal(t!.review_status, "not_reviewed");
	});
});
