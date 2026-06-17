import * as assert from "node:assert";
import { describe, it } from "vitest";
import { NoteLog, DEFAULT_RETENTION } from "../extension/store.ts";
import { SynapseError } from "../extension/schema.ts";

function fresh(): NoteLog {
	return new NoteLog("test");
}

describe("NoteLog — post + ids", () => {
	it("posts notes with auto-incrementing ids", () => {
		const l = fresh();
		const a = l.post({ message: "hello" });
		const b = l.post({ message: "world" });
		assert.equal(a.id, "note-001");
		assert.equal(b.id, "note-002");
	});

	it("requires a non-empty message", () => {
		assert.throws(() => fresh().post({ message: "" }), SynapseError);
		assert.throws(() => fresh().post({ message: "   " }), SynapseError);
	});

	it("rejects overly long messages", () => {
		assert.throws(() => fresh().post({ message: "x".repeat(1001) }), SynapseError);
	});

	it("defaults type to info and task/agent to null", () => {
		const n = fresh().post({ message: "hi" });
		assert.equal(n.type, "info");
		assert.equal(n.task_id, null);
		assert.equal(n.agent_id, null);
	});

	it("records task_id, agent_id, and type", () => {
		const n = fresh().post({ message: "hi", task_id: "task-001", agent_id: "lion-1", type: "started" });
		assert.equal(n.task_id, "task-001");
		assert.equal(n.agent_id, "lion-1");
		assert.equal(n.type, "started");
	});
});

describe("NoteLog — queries", () => {
	it("list sorts newest-first and applies filters + limit", () => {
		const l = fresh();
		l.post({ message: "a", agent_id: "lion-1", task_id: "task-001", type: "started" });
		l.post({ message: "b", agent_id: "lion-2", task_id: "task-001", type: "completed" });
		l.post({ message: "c", agent_id: "lion-1", task_id: "task-002", type: "risk" });
		assert.equal(l.list().length, 3);
		assert.equal(l.list()[0]?.message, "c"); // newest first
		assert.equal(l.list({ agent_id: "lion-1" }).length, 2);
		assert.equal(l.list({ task_id: "task-001" }).length, 2);
		assert.equal(l.list({ type: "risk" }).length, 1);
		assert.equal(l.list({ limit: 1 }).length, 1);
	});

	it("forTask and recent are convenience wrappers", () => {
		const l = fresh();
		l.post({ message: "a", task_id: "task-001" });
		l.post({ message: "b", task_id: "task-001" });
		l.post({ message: "c", task_id: "task-002" });
		assert.equal(l.forTask("task-001").length, 2);
		assert.equal(l.recent(2).length, 2);
	});

	it("get returns a clone", () => {
		const l = fresh();
		const n = l.post({ message: "x" });
		const g = l.get(n.id)!;
		g.message = "mutated";
		assert.notEqual(l.get(n.id)?.message, "mutated");
	});

	it("summary counts by type and task, reports retention and oldest age", () => {
		const l = fresh();
		l.post({ message: "a", type: "started", task_id: "task-001" });
		l.post({ message: "b", type: "started", task_id: "task-001" });
		l.post({ message: "c", type: "risk", task_id: "task-002" });
		const s = l.summary();
		assert.equal(s.total, 3);
		assert.equal(s.by_type["started"], 2);
		assert.equal(s.by_type["risk"], 1);
		assert.equal(s.by_task[0]?.task_id, "task-001");
		assert.equal(s.by_task[0]?.count, 2);
		assert.equal(s.retention.ttl_ms, DEFAULT_RETENTION.ttl_ms);
		assert.ok(s.oldest_age_ms !== null && s.oldest_age_ms >= 0);
	});
});

describe("NoteLog — retention (prune)", () => {
	it("drops notes older than ttl_ms", () => {
		const l = new NoteLog("test", { ttl_ms: 10, max_notes: 0 });
		l.post({ message: "old" });
		// backdate the note
		l.notes[0]!.created_at = new Date(Date.now() - 1000).toISOString();
		l.post({ message: "new" });
		const removed = l.prune();
		assert.equal(removed, 1);
		assert.equal(l.notes.length, 1);
		assert.equal(l.notes[0]?.message, "new");
	});

	it("caps total notes, dropping oldest beyond the cap", () => {
		const l = new NoteLog("test", { ttl_ms: 0, max_notes: 3 });
		l.post({ message: "1" });
		l.post({ message: "2" });
		l.post({ message: "3" });
		l.post({ message: "4" }); // over cap
		const removed = l.prune();
		assert.equal(removed, 1);
		assert.equal(l.notes.length, 3);
		// the oldest ("1") should have been dropped
		assert.ok(!l.notes.find((n) => n.message === "1"));
		assert.ok(l.notes.find((n) => n.message === "4"));
	});

	it("ttl=0 disables ttl pruning; max=0 disables cap", () => {
		const l = new NoteLog("test", { ttl_ms: 0, max_notes: 0 });
		l.notes.push({ id: "note-001", task_id: null, agent_id: null, type: "info", message: "ancient", created_at: "2000-01-01T00:00:00.000Z" });
		l.notes.push({ id: "note-002", task_id: null, agent_id: null, type: "info", message: "x", created_at: new Date().toISOString() });
		assert.equal(l.prune(), 0);
		assert.equal(l.notes.length, 2);
	});
});

describe("NoteLog — clear", () => {
	it("clears everything when no filter", () => {
		const l = fresh();
		l.post({ message: "a" });
		l.post({ message: "b" });
		assert.equal(l.clear(), 2);
		assert.equal(l.notes.length, 0);
	});

	it("clears only matching notes when filtered", () => {
		const l = fresh();
		l.post({ message: "a", agent_id: "lion-1", task_id: "task-001", type: "started" });
		l.post({ message: "b", agent_id: "lion-2", task_id: "task-001", type: "risk" });
		assert.equal(l.clear({ agent_id: "lion-1" }), 1);
		assert.equal(l.notes.length, 1);
		assert.equal(l.clear({ type: "risk" }), 1);
		assert.equal(l.notes.length, 0);
	});
});

describe("NoteLog — serialization round-trip", () => {
	it("toJSON/fromJSON preserves notes", () => {
		const l = fresh();
		l.post({ message: "a", task_id: "task-001", agent_id: "lion-1", type: "started" });
		l.post({ message: "b", type: "decision" });
		const back = NoteLog.fromJSON(l.toJSON());
		assert.equal(back.notes.length, 2);
		assert.equal(back.get("note-001")?.agent_id, "lion-1");
		assert.equal(back.get("note-002")?.type, "decision");
	});

	it("fromJSON coerces invalid enum values to safe defaults", () => {
		const bad = {
			meta: { version: 1, updated_at: "x", retention: { ttl_ms: 0, max_notes: 0 } },
			notes: [
				{ id: "note-001", message: "m", type: "bogus", task_id: 123, agent_id: 456 },
				{ id: "note-002", message: "m2", type: "risk" },
				{ id: "note-003" }, // no message -> dropped
			],
		};
		const l = NoteLog.fromJSON(bad);
		assert.equal(l.notes.length, 2);
		assert.equal(l.get("note-001")?.type, "info"); // invalid -> info
		assert.equal(l.get("note-001")?.task_id, null); // non-string -> null
	});
});
