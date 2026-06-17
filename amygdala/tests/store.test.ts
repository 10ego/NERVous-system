import * as assert from "node:assert";
import { describe, it } from "vitest";
import { AmygdalaLedger, canTransition } from "../extension/store.ts";
import { AmygdalaError } from "../extension/schema.ts";

describe("AmygdalaLedger", () => {
	it("assesses incidents with heuristic triage", () => {
		const l = new AmygdalaLedger();
		const i = l.assess({ description: "Blocked: cannot proceed because production secret token is missing", source: "axon", source_id: "task-001" });
		assert.equal(i.id, "risk-001");
		assert.equal(i.severity, "critical");
		assert.equal(i.category, "security");
		assert.equal(i.recommendation, "human_review");
		assert.equal(i.source_id, "task-001");
	});

	it("allows explicit triage overrides", () => {
		const i = new AmygdalaLedger().assess({ description: "ambiguous architecture decision", severity: "medium", category: "scope", recommendation: "convene_magi" });
		assert.equal(i.severity, "medium");
		assert.equal(i.recommendation, "convene_magi");
	});

	it("requires description", () => {
		assert.throws(() => new AmygdalaLedger().assess({ description: "" }), AmygdalaError);
	});

	it("updates fields", () => {
		const l = new AmygdalaLedger();
		const i = l.assess({ description: "dependency install failed" });
		const u = l.update(i.id, { severity: "high", assigned_to: "lion-1", mitigation_plan: ["pin dependency"] });
		assert.equal(u.severity, "high");
		assert.equal(u.assigned_to, "lion-1");
		assert.deepEqual(u.mitigation_plan, ["pin dependency"]);
	});

	it("status lifecycle, notes, resolve, accept", () => {
		const l = new AmygdalaLedger();
		const i = l.assess({ description: "blocked by unclear requirements" });
		l.setStatus(i.id, "acknowledged", "seen", "cortex");
		l.addNote(i.id, "asked user", "cortex");
		const r = l.resolve(i.id, "clarified", "user");
		assert.equal(r.status, "resolved");
		assert.ok(r.resolved_at);
		assert.equal(r.notes.length, 3);

		const j = l.assess({ description: "low risk" });
		assert.equal(l.accept(j.id, "accepted").status, "accepted");
	});

	it("rejects invalid terminal transition", () => {
		const l = new AmygdalaLedger();
		const i = l.assess({ description: "x" });
		l.resolve(i.id);
		assert.throws(() => l.setStatus(i.id, "open"), AmygdalaError);
	});

	it("list and summary filters", () => {
		const l = new AmygdalaLedger();
		l.assess({ description: "security token leaked" });
		l.assess({ description: "dependency failed" });
		assert.equal(l.list({ severity: "critical" }).length, 1);
		assert.equal(l.list({ category: "dependency" }).length, 1);
		const s = l.summary();
		assert.equal(s.total, 2);
		assert.deepEqual(s.open_critical, ["risk-001"]);
		assert.ok(s.needs_attention.length >= 1);
	});

	it("delete and JSON round trip", () => {
		const l = new AmygdalaLedger("p");
		const i = l.assess({ title: "T", description: "blocked", related_ids: ["task-1"] });
		const back = AmygdalaLedger.fromJSON(l.toJSON());
		assert.equal(back.get(i.id)?.title, "T");
		assert.deepEqual(back.get(i.id)?.related_ids, ["task-1"]);
		assert.equal(back.delete(i.id).id, i.id);
		assert.equal(back.all().length, 0);
	});

	it("coerces bad JSON safely", () => {
		const l = AmygdalaLedger.fromJSON({ incidents: { "risk-x": { severity: "bad", category: "bad", status: "bad", recommendation: "bad", notes: [{ text: "n" }] } } });
		const i = l.get("risk-x")!;
		assert.equal(i.severity, "medium");
		assert.equal(i.category, "unknown");
		assert.equal(i.status, "open");
		assert.equal(i.recommendation, "pause");
	});

	it("transition table", () => {
		assert.ok(canTransition("open", "mitigating"));
		assert.ok(canTransition("escalated", "resolved"));
		assert.ok(!canTransition("resolved", "open"));
	});
});
