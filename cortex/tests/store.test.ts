import * as assert from "node:assert";
import { describe, it } from "vitest";
import { summarizeGoal } from "../extension/render.ts";
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
			framing: {
				context: ["existing HTTP service"],
				scope: ["CRUD endpoints"],
				non_goals: ["authentication"],
				assumptions: ["in-memory storage is acceptable"],
				open_questions: ["pagination can follow later"],
				candidate_options: ["extend the service", "add a module"],
				decision_needed: "Choose the integration shape.",
			},
			complexity: "high",
		});
		assert.deepEqual(g.intent.success_criteria, ["c1", "c2"]);
		assert.equal(g.intent.risks[0]?.severity, "high");
		assert.equal(g.intent.complexity, "high");
		assert.deepEqual(g.intent.framing?.scope, ["CRUD endpoints"]);
		assert.equal(g.intent.framing?.decision_needed, "Choose the integration shape.");
		assert.match(summarizeGoal(g), /## Task framing/);
		assert.match(summarizeGoal(g), /\*\*Non-goals:\*\* authentication/);
	});

	it("omits an empty framing brief for backward compatibility", () => {
		const g = store().analyze({ prompt: "p", framing: {} });
		assert.equal(g.intent.framing, undefined);
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

describe("GoalStore — refine", () => {
	it("repairs an analyzed goal in place while preserving omitted fields", () => {
		const s = store();
		const original = s.analyze({
			prompt: "abstract",
			intent_summary: "original summary",
			goal: "original goal",
			constraints: ["keep this"],
			framing: {
				context: ["existing context"],
				scope: ["old scope"],
				assumptions: ["existing assumption"],
			},
			needs_magi: true,
		});
		const refined = s.refine(original.id, {
			success_criteria: ["  observable result  "],
			framing: {
				scope: ["  repaired scope  "],
				candidate_options: ["option a", "option b"],
				decision_needed: "Choose an option.",
			},
		});
		assert.equal(refined.id, original.id);
		assert.equal(s.all().length, 1);
		assert.equal(refined.intent.goal, "original goal");
		assert.deepEqual(refined.intent.constraints, ["keep this"]);
		assert.deepEqual(refined.intent.success_criteria, ["observable result"]);
		assert.deepEqual(refined.intent.framing?.context, ["existing context"]);
		assert.deepEqual(refined.intent.framing?.scope, ["repaired scope"]);
		assert.deepEqual(refined.intent.framing?.assumptions, ["existing assumption"]);
		assert.equal(refined.intent.framing?.decision_needed, "Choose an option.");
	});

	it("allows explicitly supplied framing values to be cleared", () => {
		const s = store();
		const goal = s.analyze({
			prompt: "p",
			framing: { context: ["preserve"], scope: ["clear"], decision_needed: "clear this" },
		});
		const refined = s.refine(goal.id, { framing: { scope: [], decision_needed: "" } });
		assert.deepEqual(refined.intent.framing?.context, ["preserve"]);
		assert.deepEqual(refined.intent.framing?.scope, []);
		assert.equal(refined.intent.framing?.decision_needed, undefined);
	});

	it("normalizes malformed framing patches", () => {
		const s = store();
		const goal = s.analyze({ prompt: "p" });
		const refined = s.refine(goal.id, {
			framing: { scope: ["  valid  ", 42, ""] as unknown as string[] },
		});
		assert.deepEqual(refined.intent.framing?.scope, ["valid"]);
	});

	it("requires a field and rejects refinement after planning", () => {
		const s = store();
		const goal = s.analyze({ prompt: "p" });
		assert.throws(() => s.refine(goal.id, {}), CortexError);
		s.plan(goal.id, { subtasks: [{ title: "started planning" }] });
		assert.throws(() => s.refine(goal.id, { goal: "too late" }), CortexError);
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

	it("records blocked and AMYGDALA escalation evidence", () => {
		const s = store();
		const a = s.analyze({ prompt: "blocked work" });
		const blocked = s.block(a.id, { reason: "dependency unavailable", evidence: "AXON task task-123 blocked" });
		assert.equal(blocked.status, "blocked");
		assert.equal(blocked.blocker?.reason, "dependency unavailable");

		const b = s.analyze({ prompt: "risky work" });
		const escalated = s.escalate(b.id, {
			reason: "production data-loss uncertainty",
			evidence: "AMYGDALA incident amygdala-001",
			related_ids: ["amygdala-001"],
		});
		assert.equal(escalated.status, "needs_amygdala");
		assert.deepEqual(escalated.blocker?.related_ids, ["amygdala-001"]);
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
		ok("executing", "blocked");
		ok("executing", "needs_amygdala");
		ok("blocked", "needs_replan");
		ok("needs_amygdala", "blocked");
		assert.ok(!canTransition("analyzed", "executing"));
		assert.ok(!canTransition("executing", "completed"));
		assert.ok(!canTransition("completed", "verified"));
	});
});

describe("GoalStore — config", () => {
	it("defaults drain mode and risk gate to explicit auto-deliberation", () => {
		const s = store();
		assert.equal(s.getConfig().drain_mode, "on_explicit_nervous");
		assert.equal(s.getConfig().default_drain_policy, "default");
		assert.equal(s.getConfig().risk_gate_mode, "auto_deliberate");
	});

	it("sets and persists drain/risk gate config", () => {
		const s = store();
		const cfg = s.setConfig({ drain_mode: "off", default_drain_policy: "conservative", risk_gate_mode: "user_accepted" });
		assert.equal(cfg.drain_mode, "off");
		assert.equal(cfg.default_drain_policy, "conservative");
		assert.equal(cfg.risk_gate_mode, "user_accepted");
		const back = GoalStore.fromJSON(s.toJSON());
		assert.equal(back.getConfig().drain_mode, "off");
		assert.equal(back.getConfig().default_drain_policy, "conservative");
		assert.equal(back.getConfig().risk_gate_mode, "user_accepted");
	});

	it("drain_mode off disables drain unless forced", () => {
		const s = store();
		s.analyze({ prompt: "a" });
		s.setConfig({ drain_mode: "off" });
		assert.throws(() => s.startDrain(), CortexError);
		const run = s.startDrain({ force: true });
		assert.equal(run.actionable_goal_ids.length, 1);
	});

	it("uses configured default drain policy", () => {
		const s = store();
		s.analyze({ prompt: "a" });
		s.setConfig({ default_drain_policy: "aggressive" });
		assert.equal(s.startDrain().policy.name, "aggressive");
	});

	it("risk_gate_mode disabled requires explicit dangerous opt-in evidence", () => {
		const s = store();
		assert.throws(() => s.setConfig({ risk_gate_mode: "disabled" }), CortexError);
		const cfg = s.setConfig({ risk_gate_mode: "disabled", dangerous_opt_in: true, risk_gate_evidence: "user approved automated risky drain" });
		assert.equal(cfg.risk_gate_mode, "disabled");
		assert.match(cfg.risk_gate_evidence ?? "", /approved/);
	});
});

describe("GoalStore — current / list / serialization", () => {
	it("current falls back to newest non-terminal goal", () => {
		const s = store();
		const a = s.analyze({ prompt: "a" });
		s.analyze({ prompt: "b" });
		s.complete; // noop
		assert.equal(s.current()?.id, a.id === "goal-001" ? "goal-002" : "goal-001");
		// explicit actionable current wins
		s.setCurrent("goal-001");
		assert.equal(s.current()?.id, "goal-001");
	});

	it("current skips a blocked current goal and falls back to actionable work", () => {
		const s = store();
		const blocked = s.analyze({ prompt: "blocked" });
		const actionable = s.analyze({ prompt: "actionable" });
		s.block(blocked.id, { reason: "waiting", evidence: "external dependency" });
		s.setCurrent(blocked.id);
		assert.equal(s.current()?.id, actionable.id);
	});

	it("list filters by status", () => {
		const s = store();
		s.analyze({ prompt: "a" });
		const b = s.analyze({ prompt: "b" });
		s.cancel(b.id);
		assert.equal(s.list({ status: "analyzed" }).length, 1);
		assert.equal(s.list({ status: "cancelled" }).length, 1);
	});

	it("starts a bounded drain run over actionable goals and excludes blocked goals", () => {
		const s = store();
		const actionable = s.analyze({ prompt: "do it" });
		const blocked = s.analyze({ prompt: "wait" });
		s.block(blocked.id, { reason: "needs credentials", evidence: "no credential lease" });
		const run = s.startDrain({ max_goals: 10 });
		assert.equal(run.id, "drain-001");
		assert.deepEqual(run.actionable_goal_ids, [actionable.id]);
		assert.deepEqual(run.blocked_goal_ids, [blocked.id]);
		assert.equal(run.policy.max_no_progress_iterations, 5);
	});

	it("drain escalates hard-stop safety signals before action", () => {
		const s = store();
		const risky = s.analyze({ prompt: "migrate production database", risks: [{ description: "data loss possible", severity: "high" }] });
		const safe = s.analyze({ prompt: "update docs" });
		const run = s.startDrain();
		assert.deepEqual(run.actionable_goal_ids, [safe.id]);
		assert.deepEqual(run.blocked_goal_ids, [risky.id]);
		assert.deepEqual(run.due_revisit_goal_ids, [risky.id]);
		assert.equal(s.get(risky.id)?.status, "needs_amygdala");
		assert.match(s.get(risky.id)?.blocker?.evidence ?? "", /data_loss|production/);
	});

	it("user_accepted risk gate proceeds only with scoped acceptance evidence", () => {
		const s = store();
		const risky = s.analyze({ prompt: "production data_loss migration" });
		s.setConfig({ risk_gate_mode: "user_accepted" });
		let run = s.startDrain();
		assert.deepEqual(run.actionable_goal_ids, []);
		assert.deepEqual(run.blocked_goal_ids, [risky.id]);
		assert.equal(s.get(risky.id)?.status, "needs_amygdala");

		// Re-open for the second half of the scenario by creating a fresh risky goal with acceptance evidence.
		const accepted = s.analyze({ prompt: "production data_loss migration with user approval" });
		s.acceptRisk(accepted.id, { reason: "user accepts scoped migration risk", evidence: "ticket-123", actor: "user", scope: accepted.id });
		run = s.startDrain();
		assert.ok(run.actionable_goal_ids.includes(accepted.id));
		assert.ok(run.risk_accepted_goal_ids.includes(accepted.id));
	});

	it("disabled risk gate records accepted-risk evidence instead of escalating", () => {
		const s = store();
		const risky = s.analyze({ prompt: "production credential rotation" });
		s.setConfig({ risk_gate_mode: "disabled", dangerous_opt_in: true, risk_gate_evidence: "explicit user automation window" });
		const run = s.startDrain();
		assert.deepEqual(run.actionable_goal_ids, [risky.id]);
		assert.deepEqual(run.blocked_goal_ids, []);
		assert.deepEqual(run.risk_accepted_goal_ids, [risky.id]);
		assert.match(run.evidence.join("\n"), /disabled/);
	});

	it("drain does not mutate hard-stop goals outside the max_goals snapshot", () => {
		const s = store();
		const first = s.analyze({ prompt: "safe first" });
		const outsideBudget = s.analyze({ prompt: "production data_loss outside budget" });
		const run = s.startDrain({ max_goals: 1 });
		assert.deepEqual(run.goal_ids, [first.id]);
		assert.equal(s.get(outsideBudget.id)?.status, "analyzed");
	});

	it("surfaces blocked/skipped work again when next_revisit_at is due", () => {
		const s = store();
		const due = s.analyze({ prompt: "due blocker" });
		const waiting = s.analyze({ prompt: "future blocker" });
		s.block(due.id, { reason: "waiting on dependency", evidence: "task-1", next_revisit_at: "1970-01-01T00:00:00.000Z" });
		s.block(waiting.id, { reason: "waiting on dependency", evidence: "task-2", next_revisit_at: "2999-01-01T00:00:00.000Z" });
		const run = s.startDrain();
		assert.deepEqual(run.due_revisit_goal_ids, [due.id]);
		assert.ok(run.workable_goal_ids.includes(due.id));
		assert.ok(run.waiting_goal_ids.includes(waiting.id));
		assert.equal(s.get(due.id)?.blocker?.revisit_count, 1);
	});

	it("reopens resolved skipped work so it can be replanned", () => {
		const s = store();
		const blocked = s.analyze({ prompt: "blocked" });
		s.escalate(blocked.id, { reason: "needs review", evidence: "amygdala-001" });
		const reopened = s.reopen(blocked.id, { reason: "review accepted mitigation", evidence: "amygdala-001 resolved" });
		assert.equal(reopened.status, "needs_replan");
		assert.match(reopened.blocker?.terminal_resolution ?? "", /accepted mitigation/);
		s.plan(blocked.id, { subtasks: [{ title: "resume safely" }] });
		assert.equal(s.get(blocked.id)?.status, "planned");
	});

	it("surfaces failed work for retryability classification or due retry", () => {
		const s = store();
		const unknown = s.analyze({ prompt: "unknown failure" });
		const retry = s.analyze({ prompt: "retry failure" });
		const future = s.analyze({ prompt: "future retry" });
		s.recordFailure(unknown.id, { reason: "lion failed", evidence: "lion-1" });
		s.recordFailure(retry.id, { reason: "transient", evidence: "lion-2", retryability: "retryable", next_retry_at: "1970-01-01T00:00:00.000Z" });
		s.recordFailure(future.id, { reason: "transient", evidence: "lion-3", retryability: "retryable", next_retry_at: "2999-01-01T00:00:00.000Z" });
		const run = s.startDrain();
		assert.deepEqual(run.needs_retry_classification_goal_ids, [unknown.id]);
		assert.deepEqual(run.retryable_goal_ids, [retry.id]);
		assert.ok(run.workable_goal_ids.includes(unknown.id));
		assert.ok(run.workable_goal_ids.includes(retry.id));
		assert.ok(run.waiting_goal_ids.includes(future.id));
	});

	it("round-trips through toJSON/fromJSON", () => {
		const s = store();
		const g = s.analyze({
			prompt: "p",
			goal: "g",
			success_criteria: ["c"],
			complexity: "high",
			framing: { scope: ["framed scope"], assumptions: ["framed assumption"] },
		});
		s.plan(g.id, { subtasks: [{ title: "a" }] });
		s.link(g.id, [{ plan_id: "plan-001", axon_task_id: "task-001" }]);
		const back = GoalStore.fromJSON(s.toJSON());
		assert.equal(back.get(g.id)?.intent.goal, "g");
		assert.equal(back.get(g.id)?.status, "executing");
		assert.equal(back.get(g.id)?.plan?.subtasks[0]?.axon_task_id, "task-001");
		assert.deepEqual(back.get(g.id)?.intent.framing?.scope, ["framed scope"]);
		assert.deepEqual(back.get(g.id)?.intent.framing?.assumptions, ["framed assumption"]);
		assert.equal(back.current_goal_id, g.id);
	});

	it("round-trips blocker evidence and drain run records", () => {
		const s = store();
		const g = s.analyze({ prompt: "p" });
		s.escalate(g.id, { reason: "unsafe uncertainty", evidence: "amygdala-001", related_ids: ["amygdala-001"] });
		s.startDrain({ evidence: "resume after restart" });
		const back = GoalStore.fromJSON(s.toJSON());
		assert.equal(back.get(g.id)?.status, "needs_amygdala");
		assert.equal(back.get(g.id)?.blocker?.evidence, "amygdala-001");
		assert.equal(back.drain_runs.get("drain-001")?.evidence[0], "resume after restart");
	});

	it("round-trips full drain policy budgets", () => {
		const s = store();
		s.analyze({ prompt: "a" });
		const run = s.startDrain({ policy_name: "aggressive", max_goals: 7 });
		const raw = s.toJSON();
		raw.drain_runs![run.id]!.policy.max_no_progress_iterations = 99;
		raw.drain_runs![run.id]!.policy.hard_stop_categories = ["custom_stop"];
		const back = GoalStore.fromJSON(raw);
		assert.equal(back.drain_runs.get(run.id)?.policy.max_goals, 7);
		assert.equal(back.drain_runs.get(run.id)?.policy.max_no_progress_iterations, 99);
		assert.deepEqual(back.drain_runs.get(run.id)?.policy.hard_stop_categories, ["custom_stop"]);
	});

	it("fromJSON normalizes malformed framing without breaking legacy goals", () => {
		const s = GoalStore.fromJSON({
			goals: {
				"goal-001": {
					prompt: "legacy",
					intent: {
						goal: "legacy",
						framing: {
							scope: ["  retained scope  ", 42, ""],
							assumptions: "not-an-array",
							decision_needed: 99,
						},
					},
				},
			},
		});
		const framing = s.get("goal-001")?.intent.framing;
		assert.deepEqual(framing?.scope, ["retained scope"]);
		assert.deepEqual(framing?.assumptions, []);
		assert.equal(framing?.decision_needed, undefined);
		assert.doesNotThrow(() => summarizeGoal(s.get("goal-001")!));
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
