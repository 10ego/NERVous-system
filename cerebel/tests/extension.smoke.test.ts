import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { GanglionStore } from "../../ganglion/extension/backend.ts";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

describe("cerebel extension factory", () => {
	it("registers the cerebel tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const cerebel = tools.find((t) => t.name === "cerebel");
		assert.ok(cerebel);
		assert.equal(typeof cerebel.execute, "function");
		assert.equal(typeof cerebel.renderCall, "function");
		assert.equal(typeof cerebel.renderResult, "function");
		assert.ok(cerebel.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("cerebel"));
		assert.ok(names.includes("cerebel:waves"));
	});

	it("releases linked GANGLION capacity when recording a terminal assignment", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-ganglion-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const cwd = dir;
			const ganglionStore = GanglionStore.fromCwd(cwd);
			await ganglionStore.mutate((l) => { const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] }); l.allocate(g.id, { tasks: [{ id: "task-api", title: "API" }] }); });
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((t) => t.name === "cerebel");
			const ctx = { cwd };
			await cerebel.execute("tool", { action: "plan_wave", assignments: [{ task_id: "task-api", agent_id: "lion-api", objective: "API", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] }, undefined, undefined, ctx);
			await cerebel.execute("tool", { action: "dispatch", links: [{ assignment_id: "assign-001", lion_run_id: "run-001" }] }, undefined, undefined, ctx);
			const result = await cerebel.execute("tool", { action: "record", assignment_id: "assign-001", lion_run_id: "run-001", outcome: "completed", summary: "done" }, undefined, undefined, ctx);
			assert.match(result.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded/);
			const { result: ganglion } = await ganglionStore.query((l) => l.get("ganglion-001"));
			assert.equal(ganglion?.members[0]?.status, "available");
			assert.equal(ganglion?.members[0]?.last_run_id, "run-001");
			assert.equal(ganglion?.allocations[0]?.status, "completed");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});
});
