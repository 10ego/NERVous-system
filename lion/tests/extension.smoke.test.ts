import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return {
		tools,
		commands,
		pi: {
			registerTool(def: any) { tools.push(def); },
			registerCommand(name: string, options: any) { commands.push({ name, options }); },
		},
	};
}

describe("lion extension factory", () => {
	it("registers the lion tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const lion = tools.find((t) => t.name === "lion");
		assert.ok(lion);
		assert.equal(typeof lion.execute, "function");
		assert.equal(typeof lion.renderCall, "function");
		assert.equal(typeof lion.renderResult, "function");
		assert.ok(lion.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("lion"));
		assert.ok(names.includes("lion:runs"));
	});

	it("supports queued steering and queued cancellation through the tool", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-control-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		try {
			const ctx = { cwd: dir, isProjectTrusted: () => false };
			const dry = await lion.execute("call-1", { action: "run", objective: "queued", dry_run: true }, undefined, undefined, ctx);
			const id = dry.details.run.id;
			const steer = await lion.execute("call-2", { action: "steer", id, message: "Prefer tests first" }, undefined, undefined, ctx);
			assert.equal(steer.details.run.steering_messages[0].status, "queued");
			const cancel = await lion.execute("call-3", { action: "cancel", id, reason: "not needed" }, undefined, undefined, ctx);
			assert.equal(cancel.details.run.status, "aborted");
		} finally {
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
		}
	});

	it("uses configured LION model default when a run omits model", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-config-test-"));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		await fs.writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "nervous.json"), JSON.stringify({ version: 1, models: { lion: { default: "provider/fast", implementationDefault: "provider/implement", reviewDefault: "provider/review" } } }));
		try {
			const result = await lion.execute("call-1", { action: "run", objective: "dry", dry_run: true }, undefined, undefined, {
				cwd: dir,
				isProjectTrusted: () => false,
			});
			assert.equal(result.details.run.model, "provider/implement");
			assert.equal(result.details.run.model_role, "implementation");
			const review = await lion.execute("call-2", { action: "run", objective: "review dry", model_role: "review", dry_run: true }, undefined, undefined, {
				cwd: dir,
				isProjectTrusted: () => false,
			});
			assert.equal(review.details.run.model, "provider/review");
			assert.equal(review.details.run.model_role, "review");
			const explicit = await lion.execute("call-3", { action: "run", objective: "explicit dry", model: "provider/explicit", model_role: "review", dry_run: true }, undefined, undefined, {
				cwd: dir,
				isProjectTrusted: () => false,
			});
			assert.equal(explicit.details.run.model, "provider/explicit");
			assert.equal(explicit.details.run.model_role, "review");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
		}
	});
});
