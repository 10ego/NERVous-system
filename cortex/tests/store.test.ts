import * as assert from "node:assert";
import { describe, it } from "vitest";
import { canTransition, GoalStore } from "../extension/store.ts";
import { CortexError } from "../extension/schema.ts";
import type { GoalStatus } from "../extension/schema.ts";

function store(): GoalStore {
	return new GoalStore("test");
}

describe("GoalStore — analyze", () => {
	it("creates a goal with auto id and sets it current", () => {
		const s = store();
		const g = s.analyze({ prompt: "build a todo api" });
		assert.equal(g.id, "goal-001");
		assert.equal(g.status, "analyzed");
		assert.equal(s.current_goal_id, "goal-001");
		assert.equal(s.current()?.id, "goal-001");
	});

	it("requires a prompt", () => {
		assert.throws(() => store().analyze({ prompt: "" }), CortexError);
	});

	it("records structured intent fields", () => {
		const g = store().analyze({
			prompt: "p",
			intent_summary: "sum",
			goal: "ship a todo api",
			success_criteria: ["c1", "c2"],
			constraints: ["no deps"],
			risks: [{ description: "r", severity: "high" }],
			expected_output: "api + tests",
			complexity: "high",
		});
		assert.deepEqual(g.intent.success_criteria, ["c1", "c2"]);
		assert.equal(g.intent.risks[0]?.severity, "high");
		assert.equal(g.intent.complexity, "high");
	});

	it("heuristic sets needs_magi for high complexity / high-severity risk", () => {
		assert.equal(store().analyze({ prompt: "p", complexity: "high" }).intent.needs_magi, true);
		assert.equal(
			store().analyze({ prompt: "p", complexity: "low", risks: [{ description: "x", severity: "high" }] }).intent.needs_magi,
			true,
		);
		assert.equal(store().analyze({ prompt: "p", complexity: "low" }).intent.needs_magi, false);
	});

	it("explicit needs_magi overrides the heuristic", () => {
		assert.equal(store().analyze({ prompt: "p", complexity: "high", needs_magi: false }).intent.needs_magi, false);
	});
});

describe("GoalStore — plan", () => {
	it("assigns plan ids and resolves dependency titles", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		const planned = s.plan(g.id, {
			subtasks: [
				{ title: "Scaffold", priority: "high" },
				{ title: "Tests", dependencies: ["Scaffold"] },
			],
		});
		assert.equal(planned.status, "planned");
		assert.equal(planned.plan!.subtasks[0]?.id, "plan-001");
		assert.equal(planned.plan!.subtasks[1]?.id, "plan-002");
		assert.deepEqual(planned.plan!.subtasks[1]?.dependencies, ["plan-001"]);
	});

	it("requires at least one subtask", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		assert.throws(() => s.plan(g.id, { subtasks: [] }), CortexError);
	});

	it("rejects plan from a non-analyzed status", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		// now planned -> cannot plan again directly
		assert.throws(() => s.plan(g.id, { subtasks: [{ title: "a" }] }), CortexError);
	});

	it("allows replanning from needs_replan", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ axon_task_id: "task-001" }]);
		s.verify(g.id, { checks: [{ criterion: "c", passed: false }], recommendation: "replan" });
		assert.equal(s.get(g.id)?.status, "needs_replan");
		// replan allowed
		const g2 = s.plan(g.id, { subtasks: [{ title: "a2" }] });
		assert.equal(g2.status, "planned");
	});
});

describe("GoalStore — link", () => {
	it("records axon task ids and moves to executing", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.plan(g.id, { subtasks: [{ title: "a" }, { title: "b" }] });
		const linked = s.link(g.id, [
			{ plan_id: "plan-001", axon_task_id: "task-001" },
			{ plan_id: "plan-002", axon_task_id: "task-002" },
		]);
		assert.equal(linked.status, "executing");
		assert.deepEqual(linked.axon_task_ids, ["task-001", "task-002"]);
		assert.equal(linked.plan!.subtasks[0]?.axon_task_id, "task-001");
	});

	it("requires a plan first", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		assert.throws(() => s.link(g.id, [{ axon_task_id: "task-001" }]), CortexError);
	});
});

describe("GoalStore — verify + complete", () => {
	it("approve when all checks pass (or explicit approve)", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ axon_task_id: "task-001" }]);
		const v = s.verify(g.id, {
			checks: [{ criterion: "works", passed: true, evidence: "tests pass" }],
			all_axon_complete: true,
		});
		assert.equal(v.status, "verified");
		assert.equal(v.verification?.recommendation, "approve");
		assert.equal(v.verification?.ready_for_magi_review, true);
	});

	it("defaults to revise when a check fails", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ axon_task_id: "task-001" }]);
		const v = s.verify(g.id, { checks: [{ criterion: "works", passed: false }] });
		assert.equal(v.status, "needs_replan");
		assert.equal(v.verification?.recommendation, "revise");
	});

	it("complete requires verified", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		assert.throws(() => s.complete(g.id), CortexError); // analyzed
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ axon_task_id: "task-001" }]);
		assert.throws(() => s.complete(g.id), CortexError); // executing
		s.verify(g.id, { checks: [{ criterion: "c", passed: true }] });
		const done = s.complete(g.id);
		assert.equal(done.status, "completed");
	});

	it("cancel works from any non-terminal status", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		assert.equal(s.cancel(g.id).status, "cancelled");
		assert.throws(() => s.cancel(g.id), CortexError); // already terminal
	});
});

describe("GoalStore — transitions", () => {
	it("canTransition is correct across the lifecycle", () => {
		const ok = (a: GoalStatus, b: GoalStatus) => assert.ok(canTransition(a, b), `${a}->${b}`);
		ok("analyzed", "planned");
		ok("planned", "executing");
		ok("executing", "verified");
		ok("verified", "completed");
		ok("verified", "needs_replan");
		ok("needs_replan", "planned");
		assert.ok(!canTransition("analyzed", "executing"));
		assert.ok(!canTransition("executing", "completed"));
		assert.ok(!canTransition("completed", "verified"));
	});
});

describe("GoalStore — current / list / serialization", () => {
	it("current falls back to newest non-terminal goal", () => {
		const s = store();
		const a = s.analyze({ prompt: "a" });
		s.analyze({ prompt: "b" });
		s.complete; // noop
		assert.equal(s.current()?.id, a.id === "goal-001" ? "goal-002" : "goal-001");
		// explicit current wins
		s.setCurrent("goal-001");
		assert.equal(s.current()?.id, "goal-001");
	});

	it("list filters by status", () => {
		const s = store();
		s.analyze({ prompt: "a" });
		const b = s.analyze({ prompt: "b" });
		s.cancel(b.id);
		assert.equal(s.list({ status: "analyzed" }).length, 1);
		assert.equal(s.list({ status: "cancelled" }).length, 1);
	});

	it("round-trips through toJSON/fromJSON", () => {
		const s = store();
		const g = s.analyze({ prompt: "p", goal: "g", success_criteria: ["c"], complexity: "high" });
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ plan_id: "plan-001", axon_task_id: "task-001" }]);
		const back = GoalStore.fromJSON(s.toJSON());
		assert.equal(back.get(g.id)?.intent.goal, "g");
		assert.equal(back.get(g.id)?.status, "executing");
		assert.equal(back.get(g.id)?.plan?.subtasks[0]?.axon_task_id, "task-001");
		assert.equal(back.current_goal_id, g.id);
	});

	it("fromJSON coerces bad enums to safe defaults", () => {
		const bad = {
			meta: { version: 1, updated_at: "x" },
			current_goal_id: "goal-001",
			goals: {
				"goal-001": {
					id: "goal-001",
					prompt: "p",
					status: "bogus",
					intent: { complexity: "nope", needs_magi: "yes", risks: [{ description: "r", severity: "wat" }] },
					axon_task_ids: [],
				},
			},
		};
		const s = GoalStore.fromJSON(bad);
		const g = s.get("goal-001")!;
		assert.equal(g.status, "analyzed");
		assert.equal(g.intent.complexity, "medium");
		assert.equal(g.intent.needs_magi, false);
		assert.equal(g.intent.risks[0]?.severity, "medium");
	});
});
