import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";
import { LionStore } from "../extension/backend.ts";
import { attachActiveRunProcess, beginActiveRun, clearActiveRunsForTests, finishActiveRun } from "../extension/active-runs.ts";

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

	it("accepts running steering only for live rpc-backed runs", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-live-steer-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		try {
			const ctx = { cwd: dir, isProjectTrusted: () => false };
			const store = LionStore.fromCwd(dir);
			const jsonRun = (await store.mutate((l) => l.create({ objective: "json", runner_mode: "json" }))).result;
			await store.mutate((l) => l.updateControl(jsonRun.id, { pid: process.pid, pgid: null }));
			const jsonSteer = await lion.execute("call-json", { action: "steer", id: jsonRun.id, message: "live?" }, undefined, undefined, ctx);
			assert.equal(jsonSteer.details.run.steering_messages[0].status, "rejected_running");

			const rpcRun = (await store.mutate((l) => l.create({ objective: "rpc", runner_mode: "rpc" }))).result;
			await store.mutate((l) => l.updateControl(rpcRun.id, { pid: process.pid, pgid: null }));
			const staleRpcSteer = await lion.execute("call-rpc-stale", { action: "steer", id: rpcRun.id, message: "adjust" }, undefined, undefined, ctx);
			assert.equal(staleRpcSteer.details.run.steering_messages[0].status, "rejected_running");

			const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: rpcRun.id }, "rpc");
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => undefined });
			try {
				const liveRpcSteer = await lion.execute("call-rpc-live", { action: "steer", id: rpcRun.id, message: "adjust live" }, undefined, undefined, ctx);
				assert.equal(liveRpcSteer.details.run.steering_messages[1].status, "pending_delivery");
				await store.mutate((l) => l.failOpenSteering(rpcRun.id, "simulated shutdown sweep"));
				const postSweepSteer = await lion.execute("call-rpc-post-sweep", { action: "steer", id: rpcRun.id, message: "land after sweep" }, undefined, undefined, ctx);
				assert.equal(postSweepSteer.details.run.steering_messages[2].status, "pending_delivery");
				const terminal = (await store.mutate((l) => l.finish(rpcRun.id, { output: "done", report: null, status: "completed" }))).result;
				assert.equal(terminal.steering_messages?.[2]?.status, "delivery_failed");
				assert.match(terminal.steering_messages?.[2]?.reason ?? "", /finalized/);
			} finally {
				finishActiveRun(owner);
			}
		} finally {
			clearActiveRunsForTests();
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
		}
	});

	it("records stale running cancellation without signaling persisted PIDs", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-stale-cancel-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		try {
			const ctx = { cwd: dir, isProjectTrusted: () => false };
			const store = LionStore.fromCwd(dir);
			const run = (await store.mutate((l) => l.create({ objective: "stale", runner_mode: "json" }))).result;
			await store.mutate((l) => l.updateControl(run.id, { pid: process.pid, pgid: null }));
			const cancel = await lion.execute("call-cancel-stale", { action: "cancel", id: run.id, reason: "stop" }, undefined, undefined, ctx);
			assert.match(cancel.content[0].text, /no owned active worker was signaled/);
			assert.equal(cancel.details.run.control.cancel_delivery_status, "not_attached");

			let delivered = false;
			const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id }, "json");
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { delivered = true; } });
			try {
				const liveCancel = await lion.execute("call-cancel-live", { action: "cancel", id: run.id, reason: "stop" }, undefined, undefined, ctx);
				assert.equal(delivered, true);
				assert.equal(liveCancel.details.run.control.cancel_delivery_status, "delivered");
			} finally {
				finishActiveRun(owner);
			}
			const repeated = await lion.execute("call-cancel-repeat-unattached", { action: "cancel", id: run.id, reason: "repeat elsewhere" }, undefined, undefined, ctx);
			assert.match(repeated.content[0].text, /no owned active worker was signaled/);
			assert.equal(repeated.details.run.control.cancel_delivery_status, "delivered");
		} finally {
			clearActiveRunsForTests();
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
