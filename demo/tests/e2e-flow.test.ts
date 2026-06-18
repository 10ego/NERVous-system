import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";

import { CortexStore } from "../../cortex/extension/backend.ts";
import { AxonStore } from "../../axon/extension/backend.ts";
import { SynapseStore } from "../../synapse/extension/backend.ts";
import { LionStore } from "../../lion/extension/backend.ts";
import { CerebelStore } from "../../cerebel/extension/backend.ts";
import { GanglionStore } from "../../ganglion/extension/backend.ts";
import { AmygdalaStore } from "../../amygdala/extension/backend.ts";

/**
 * Full NERVous System deterministic demo.
 *
 * This intentionally avoids live LLM calls and subprocesses. It exercises the
 * durable stores and state machines the pi tools use, proving the components
 * compose into the target flow:
 *   User → CORTEX → AXON → GANGLION → CEREBEL → LION ↔ SYNAPSE
 *        → AMYGDALA (risk) → AXON complete → CORTEX verify/complete
 */
describe("NERVous System final end-to-end demo flow", () => {
	it("builds and verifies the todo API demo flow across every component", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-e2e-"));
		const oldRoot = process.env.NERVOUS_STATE_ROOT;
		const oldProject = process.env.NERVOUS_PROJECT;
		const oldContext = process.env.NERVOUS_CONTEXT;
		process.env.NERVOUS_STATE_ROOT = path.join(cwd, "global-state");
		process.env.NERVOUS_PROJECT = "demo";
		process.env.NERVOUS_CONTEXT = "e2e";
		try {
			const cortex = CortexStore.fromCwd(cwd);
			const axon = AxonStore.fromCwd(cwd);
			const synapse = SynapseStore.fromCwd(cwd);
			const lion = LionStore.fromCwd(cwd);
			const cerebel = CerebelStore.fromCwd(cwd);
			const ganglion = GanglionStore.fromCwd(cwd);
			const amygdala = AmygdalaStore.fromCwd(cwd);

			/* --------------------------- CORTEX: intent + plan --------------------------- */
			const goal = await cortex.mutate((s) =>
				s.analyze({
					prompt: "Build a simple todo API with tests.",
					intent_summary: "Create a small CRUD todo API, cover it with tests, and document usage.",
					goal: "Deliver a working todo API demo with tests and documentation.",
					success_criteria: [
						"CRUD API behavior is implemented",
						"Automated tests cover the API behavior",
						"Usage documentation exists",
						"All AXON tasks are complete",
						"No unresolved critical AMYGDALA risks remain",
					],
					constraints: ["No live LLM calls in deterministic demo", "All state must persist under the active NERVous namespace"],
					risks: [{ description: "Demo orchestration can drift from the original intent", severity: "medium" }],
					expected_output: "Durable proof that the complete NERVous flow works end-to-end.",
					complexity: "medium",
					needs_magi: false,
					magi_rationale: "The demo is deterministic and low-risk; no architectural tradeoff requires council deliberation.",
				}),
			);
			assert.equal(goal.result.id, "goal-001");

			await cortex.mutate((s) =>
				s.plan(goal.result.id, {
					subtasks: [
						{ title: "Implement todo API", description: "Create CRUD endpoint behavior.", priority: "high" },
						{ title: "Add API tests", description: "Cover create/list/update/delete behavior.", dependencies: ["Implement todo API"], priority: "high" },
						{ title: "Document usage", description: "Document endpoints and local test command.", priority: "medium" },
					],
				}),
			);

			/* --------------------------- AXON: durable tasks ----------------------------- */
			const api = await axon.mutate((l) => l.create({ title: "Implement todo API", description: "Create CRUD endpoint behavior.", priority: "high" }));
			const tests = await axon.mutate((l) => l.create({ title: "Add API tests", description: "Cover create/list/update/delete behavior.", dependencies: [api.result.id], priority: "high" }));
			const docs = await axon.mutate((l) => l.create({ title: "Document usage", description: "Document endpoints and local test command.", priority: "medium" }));
			await cortex.mutate((s) =>
				s.link(goal.result.id, [
					{ plan_id: "plan-001", axon_task_id: api.result.id },
					{ plan_id: "plan-002", axon_task_id: tests.result.id },
					{ plan_id: "plan-003", axon_task_id: docs.result.id },
				]),
			);

			/* ------------------------ GANGLION: roster + allocation ---------------------- */
			const group = await ganglion.mutate((g) =>
				g.create({
					name: "todo-demo-ganglion",
					goal_id: goal.result.id,
					max_parallel: 2,
					members: [
						{ id: "lion-api", role: "api implementer", capabilities: ["api", "node"] },
						{ id: "lion-tests", role: "test engineer", capabilities: ["test", "node"] },
						{ id: "lion-docs", role: "documentation", capabilities: ["docs", "markdown"] },
					],
				}),
			);
			assert.equal(group.result.members.length, 3);

			const firstAlloc = await ganglion.mutate((g) =>
				g.allocate(group.result.id, {
					context: "Todo API demo wave 1",
					tasks: [
						{ id: api.result.id, title: api.result.title, description: api.result.description, priority: api.result.priority, required_capabilities: ["api"] },
						{ id: docs.result.id, title: docs.result.title, description: docs.result.description, priority: docs.result.priority, required_capabilities: ["docs"] },
					],
				}),
			);
			assert.deepEqual(firstAlloc.result.allocations.map((a) => a.member_id), ["lion-api", "lion-docs"]);

			/* ---------------------- CEREBEL + LION: wave 1 execution --------------------- */
			const wave1 = await cerebel.mutate((c) =>
				c.planWave({
					goal_id: goal.result.id,
					max_parallel: 2,
					context: "Todo API demo wave 1",
					assignments: firstAlloc.result.allocations.map((a) => ({
						task_id: a.task_id,
						agent_id: a.member_id,
						objective: a.objective,
						context: a.context,
						priority: a.priority,
					})),
				}),
			);

			await runSimulatedLionAssignment({ axon, synapse, lion, cerebel, ganglion, waveId: wave1.result.id, ganglionId: group.result.id, assignmentId: "assign-001", taskId: api.result.id, agentId: "lion-api", summary: "Implemented CRUD todo API behavior.", changedFiles: ["src/todo-api.ts"], dispatch: true });
			await runSimulatedLionAssignment({ axon, synapse, lion, cerebel, ganglion, waveId: wave1.result.id, ganglionId: group.result.id, assignmentId: "assign-002", taskId: docs.result.id, agentId: "lion-docs", summary: "Documented endpoints and local test command.", changedFiles: ["README.md"], dispatch: false });
			await cerebel.mutate((c) => c.complete(wave1.result.id));

			const readyAfterWave1 = await axon.query((l) => l.list({ ready_only: true }).map((t) => t.id));
			assert.deepEqual(readyAfterWave1.result, [tests.result.id]);

			/* ------------------------- AMYGDALA: risk during tests ----------------------- */
			const risk = await amygdala.mutate((a) =>
				a.assess({
					title: "Test dependency uncertainty",
					description: "Dependency/test command was initially unclear for the API test task; retry with bounded check.",
					source: "axon",
					source_id: tests.result.id,
					severity: "medium",
					category: "dependency",
					recommendation: "retry",
					mitigation_plan: ["Identify project test command", "Run bounded test check", "Record evidence"],
					related_ids: [goal.result.id, tests.result.id],
				}),
			);
			await amygdala.mutate((a) => a.addNote(risk.result.id, "Bounded retry path selected for deterministic demo.", "cortex"));

			/* ---------------------- GANGLION/CEREBEL/LION: wave 2 ----------------------- */
			const secondAlloc = await ganglion.mutate((g) =>
				g.allocate(group.result.id, {
					context: "Todo API demo wave 2",
					tasks: [{ id: tests.result.id, title: tests.result.title, description: tests.result.description, priority: tests.result.priority, required_capabilities: ["test"] }],
				}),
			);
			assert.equal(secondAlloc.result.allocations.at(-1)?.member_id, "lion-tests");

			const wave2 = await cerebel.mutate((c) =>
				c.planWave({
					goal_id: goal.result.id,
					max_parallel: 1,
					context: "Todo API demo wave 2",
					assignments: [secondAlloc.result.allocations.at(-1)!].map((a) => ({ task_id: a.task_id, agent_id: a.member_id, objective: a.objective, context: a.context, priority: a.priority })),
				}),
			);
			await runSimulatedLionAssignment({ axon, synapse, lion, cerebel, ganglion, waveId: wave2.result.id, ganglionId: group.result.id, assignmentId: "assign-001", taskId: tests.result.id, agentId: "lion-tests", summary: "Added passing CRUD API tests.", changedFiles: ["tests/todo-api.test.ts"] });
			await cerebel.mutate((c) => c.complete(wave2.result.id));
			await amygdala.mutate((a) => a.resolve(risk.result.id, "Test command uncertainty resolved by successful bounded run.", "lion-tests"));

			/* --------------------------- CORTEX: verify + complete ----------------------- */
			const axonSummary = await axon.query((l) => l.summary());
			const riskSummary = await amygdala.query((a) => a.summary());
			const verified = await cortex.mutate((s) =>
				s.verify(goal.result.id, {
					all_axon_complete: axonSummary.result.by_status.completed === 3,
					checks: [
						{ criterion: "CRUD API behavior is implemented", passed: true, evidence: api.result.id },
						{ criterion: "Automated tests cover the API behavior", passed: true, evidence: tests.result.id },
						{ criterion: "Usage documentation exists", passed: true, evidence: docs.result.id },
						{ criterion: "All AXON tasks are complete", passed: axonSummary.result.by_status.completed === 3, evidence: JSON.stringify(axonSummary.result.by_status) },
						{ criterion: "No unresolved critical AMYGDALA risks remain", passed: riskSummary.result.open_critical.length === 0, evidence: risk.result.id },
					],
				}),
			);
			assert.equal(verified.result.status, "verified");
			const completed = await cortex.mutate((s) => s.complete(goal.result.id));
			assert.equal(completed.result.status, "completed");

			/* ------------------------------- Final assertions ---------------------------- */
			const finalAxon = await axon.query((l) => l.summary());
			const finalSynapse = await synapse.query((s) => s.summary());
			const finalLion = await lion.query((l) => l.summary());
			const finalCerebel = await cerebel.query((c) => c.summary());
			const finalGanglion = await ganglion.query((g) => g.current());
			const finalAmygdala = await amygdala.query((a) => a.summary());
			const finalCortex = await cortex.query((c) => c.get(goal.result.id));

			assert.equal(finalCortex.result?.status, "completed");
			assert.equal(finalAxon.result.by_status.completed, 3);
			assert.equal(finalLion.result.by_status.completed, 3);
			assert.equal(finalCerebel.result.by_status.completed, 2);
			assert.equal(finalGanglion.result?.members.every((m) => m.status === "available"), true);
			assert.equal(finalAmygdala.result.by_status.resolved, 1);
			assert.ok(finalSynapse.result.total >= 6, "SYNAPSE captured transient coordination notes");

			for (const rel of [
				"global-state/demo/e2e/cortex/cortex.json",
				"global-state/demo/e2e/axon/ledger.json",
				"global-state/demo/e2e/synapse/synapse.json",
				"global-state/demo/e2e/lion/runs.json",
				"global-state/demo/e2e/cerebel/cerebel.json",
				"global-state/demo/e2e/ganglion/ganglion.json",
				"global-state/demo/e2e/amygdala/amygdala.json",
			]) {
				assert.ok(fs.existsSync(path.join(cwd, rel)), `${rel} should exist`);
			}
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

async function runSimulatedLionAssignment(args: {
	axon: AxonStore;
	synapse: SynapseStore;
	lion: LionStore;
	cerebel: CerebelStore;
	ganglion: GanglionStore;
	waveId: string;
	ganglionId: string;
	assignmentId: string;
	taskId: string;
	agentId: string;
	summary: string;
	changedFiles: string[];
	/** CEREBEL dispatch is a one-time wave transition; subsequent assignments in the same wave can skip it. */
	dispatch?: boolean;
}): Promise<void> {
	await args.axon.mutate((l) => l.setStatus(args.taskId, "in_progress", `${args.agentId} started`));
	await args.synapse.mutate((s) => s.post({ task_id: args.taskId, agent_id: args.agentId, type: "started", message: `${args.agentId} started ${args.taskId}` }));

	const run = await args.lion.mutate((l) =>
		l.create({
			agent_id: args.agentId,
			task_id: args.taskId,
			objective: `Complete ${args.taskId}`,
			context: "Deterministic E2E demo; no live subprocess.",
		}),
	);
	if (args.dispatch !== false) {
		await args.cerebel.mutate((c) => c.dispatch(args.waveId, { links: [{ assignment_id: args.assignmentId, lion_run_id: run.result.id }] }));
	}

	await args.lion.mutate((l) =>
		l.finish(run.result.id, {
			output: args.summary,
			report: {
				outcome: "completed",
				summary: args.summary,
				changed_files: args.changedFiles,
				tests_run: args.taskId.includes("003") || args.agentId.includes("tests") ? ["npm test"] : [],
				blockers: [],
				next_steps: [],
			},
		}),
	);
	await args.axon.mutate((l) => {
		l.addArtifact(args.taskId, { path: args.changedFiles.join(","), kind: "demo-artifact" });
		l.setStatus(args.taskId, "needs_review", `${args.agentId} finished implementation`);
		l.setReview(args.taskId, "approved");
		return l.setStatus(args.taskId, "completed", `${args.agentId} completed`);
	});
	await args.synapse.mutate((s) => s.post({ task_id: args.taskId, agent_id: args.agentId, type: "completed", message: args.summary }));
	await args.cerebel.mutate((c) => c.record(args.waveId, { assignment_id: args.assignmentId, lion_run_id: run.result.id, outcome: "completed", summary: args.summary, changed_files: args.changedFiles, tests_run: args.agentId.includes("tests") ? ["npm test"] : [] }));
	await args.ganglion.mutate((g) => g.record(args.ganglionId, { task_id: args.taskId, lion_run_id: run.result.id, status: "completed", summary: args.summary }));
}
