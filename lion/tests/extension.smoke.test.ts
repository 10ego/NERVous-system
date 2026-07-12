import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
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

afterEach(() => {
	vi.useRealTimers();
	clearActiveRunsForTests();
});

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
			assert.match(dry.content[0].text, new RegExp(`run_id=${id} incarnation_id=${dry.details.run.incarnation_id}`));
			const steer = await lion.execute("call-2", { action: "steer", id, message: "Prefer tests first" }, undefined, undefined, ctx);
			assert.equal(steer.details.run.steering_messages[0].status, "queued");
			const cancel = await lion.execute("call-3", { action: "cancel", id, reason: "not needed" }, undefined, undefined, ctx);
			assert.equal(cancel.details.run.status, "aborted");
		} finally {
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
		}
	});

	it("uses only the cancel action reason as the cancellation explanation", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((tool) => tool.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-cancel-reason-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		try {
			const ctx = { cwd: dir, isProjectTrusted: () => false };
			const contextOnly = await lion.execute("queue-context-only", { action: "run", objective: "queued", context: "worker-only instructions", dry_run: true }, undefined, undefined, ctx);
			const contextOnlyCancellation = await lion.execute("cancel-context-only", { action: "cancel", id: contextOnly.details.run.id, context: "must not become a reason" }, undefined, undefined, ctx);
			assert.equal(contextOnlyCancellation.details.run.control.cancel_reason, null);
			assert.equal(contextOnlyCancellation.details.run.error, "Cancelled before start");

			const withReason = await lion.execute("queue-with-reason", { action: "run", objective: "queued", context: "worker-only instructions", dry_run: true }, undefined, undefined, ctx);
			const withReasonCancellation = await lion.execute("cancel-with-reason", { action: "cancel", id: withReason.details.run.id, reason: "explicit cancellation reason", context: "must not become a reason" }, undefined, undefined, ctx);
			assert.equal(withReasonCancellation.details.run.control.cancel_reason, "explicit cancellation reason");
		} finally {
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("starts a queued steered run through the public tool boundary", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((tool) => tool.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-public-start-"));
		const binDir = path.join(dir, "bin");
		await fs.mkdir(binDir);
		const fakePi = path.join(binDir, "pi");
		const receivedArgsPath = path.join(dir, "received-args.json");
		const reportText = '```json\n{"WORKER_REPORT":{"outcome":"completed","summary":"started successfully","changed_files":[],"tests_run":[],"blockers":[],"next_steps":[]}}\n```';
		await fs.writeFile(fakePi, `#!/usr/bin/env node\nrequire(\"node:fs\").writeFileSync(${JSON.stringify(receivedArgsPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:${JSON.stringify(reportText)}}]}})+\"\\n\");\n`);
		await fs.chmod(fakePi, 0o755);
		const oldRunsPath = process.env.LION_RUNS_PATH, oldPath = process.env.PATH, oldScript = process.argv[1];
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
		process.argv[1] = path.join(dir, "missing-pi-entry.js");
		try {
			const ctx = { cwd: dir, isProjectTrusted: () => false };
			const dry = await lion.execute("queue", { action: "run", objective: "queued work", dry_run: true }, undefined, undefined, ctx);
			const id = dry.details.run.id;
			await lion.execute("steer", { action: "steer", id, message: "Run the focused tests" }, undefined, undefined, ctx);
			const started = await lion.execute("start", { action: "start", id, timeout_ms: 5_000 }, undefined, undefined, ctx);
			assert.equal(started.isError, undefined);
			assert.equal(started.details.run.status, "completed");
			assert.match(started.content[0].text, new RegExp(`run_id=${id} incarnation_id=${started.details.run.incarnation_id}`));
			assert.equal(started.details.run.report?.summary, "started successfully");
			assert.equal(started.details.run.steering_messages[0]?.status, "applied");
			assert.equal(started.details.run.progress?.event, "message_end");
			const receivedArgs = JSON.parse(await fs.readFile(receivedArgsPath, "utf8")) as string[];
			assert.match(receivedArgs.join("\n"), /Run the focused tests/);
			const store = LionStore.fromCwd(dir);
			assert.deepEqual((await store.query((ledger) => ledger.get(id))).result?.status, "completed");
		} finally {
			process.argv[1] = oldScript;
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH; else process.env.LION_RUNS_PATH = oldRunsPath;
			if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		}
	});

	it("rejects cancellation of an unknown direct run id", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((tool) => tool.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-unknown-cancel-"));
		const result = await lion.execute("cancel-missing", { action: "cancel", id: "run-missing" }, undefined, undefined, { cwd: dir, isProjectTrusted: () => false });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not found/);
	});

	it("does not persist a reused run before duplicate ownership admission", async () => {
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-owner-admission-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		const store = LionStore.fromCwd(dir);
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: "run-001" }, "json");
		try {
			const result = await lion.execute("call-owner-conflict", { action: "run", objective: "replacement" }, undefined, undefined, { cwd: dir, isProjectTrusted: () => false });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /owner already exists/);
			assert.equal((await store.query((l) => l.get("run-001"))).result, undefined);
		} finally {
			finishActiveRun(owner);
			clearActiveRunsForTests();
			if (oldRunsPath === undefined) delete process.env.LION_RUNS_PATH;
			else process.env.LION_RUNS_PATH = oldRunsPath;
		}
	});

	it("does not escalate cancellation to a replacement owner", async () => {
		vi.useFakeTimers();
		const { pi, tools } = stubPi();
		factory(pi);
		const lion = tools.find((t) => t.name === "lion");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-escalation-owner-test-"));
		const oldRunsPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = path.join(dir, "runs.json");
		const store = LionStore.fromCwd(dir);
		try {
			const originalRun = (await store.mutate((l) => l.create({ objective: "original" }))).result;
			const original = beginActiveRun({ namespaceId: store.namespaceId, runId: originalRun.id, incarnationId: originalRun.incarnation_id }, "json");
			const originalSignals: string[] = [];
			attachActiveRunProcess(original, { pid: 101, pgid: null, isAlive: () => true, cancel: (signal) => { originalSignals.push(signal); return true; } });
			const cancelled = await lion.execute("call-cancel-original", { action: "cancel", id: originalRun.id }, undefined, undefined, { cwd: dir, isProjectTrusted: () => false });
			assert.equal(cancelled.details.run.control.cancel_delivery_status, "delivered");
			assert.deepEqual(originalSignals, ["SIGTERM"]);

			finishActiveRun(original);
			await store.mutate((l) => { l.finish(originalRun.id, { output: "stopped", report: null, status: "aborted" }); return l.delete(originalRun.id); });
			const replacementRun = (await store.mutate((l) => l.create({ objective: "replacement" }))).result;
			assert.equal(replacementRun.id, originalRun.id);
			let replacementSignals = 0;
			const replacement = beginActiveRun({ namespaceId: store.namespaceId, runId: replacementRun.id, incarnationId: replacementRun.incarnation_id }, "json");
			attachActiveRunProcess(replacement, { pid: 202, pgid: null, isAlive: () => true, cancel: () => { replacementSignals++; return true; } });
			await vi.advanceTimersByTimeAsync(5_000);
			assert.equal(replacementSignals, 0);
			finishActiveRun(replacement);
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

			const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: rpcRun.id, incarnationId: rpcRun.incarnation_id }, "rpc");
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => true });
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
			const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "json");
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { delivered = true; return true; } });
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
