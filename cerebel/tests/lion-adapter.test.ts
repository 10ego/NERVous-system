import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { createLionAdapter } from "../extension/index.ts";
import { LionLedger } from "../../lion/extension/store.ts";
import * as activeRuns from "../../lion/extension/active-runs.ts";
import * as cleanupSupervisor from "../../lion/extension/cleanup-supervisor.ts";
import * as lifecycle from "../../lion/extension/lifecycle.ts";
import * as options from "../../lion/extension/options.ts";
import type { Assignment } from "../extension/schema.ts";
import type { LionReport } from "../../lion/extension/schema.ts";
import type { LionRunRequest } from "../../lion/extension/subprocess.ts";

const report: LionReport = { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] };

afterEach(() => {
	cleanupSupervisor.clearLionCleanupSupervisorsForTests();
	activeRuns.clearActiveRunsForTests();
	vi.restoreAllMocks();
});

function assignment(): Assignment {
	return {
		id: "assign-001",
		task_id: "task-001",
		agent_id: "lion-001",
		objective: "Do work",
		context: "",
		priority: "medium",
		status: "dispatched",
		ganglion_id: null,
		ganglion_allocation_id: null,
		lion_run_id: null,
		outcome_summary: null,
		changed_files: [],
		tests_run: [],
		blockers: [],
		next_steps: [],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

describe("createLionAdapter", () => {
	it("preserves adapter initialization error provenance", async () => {
		const rootCause = new Error("invalid model configuration");
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: "error-provenance",
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const runner = () => async () => ({ text: "", report: null });
		await assert.rejects(() => createLionAdapter(
			{ cwd: process.cwd(), isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{
				lionStore,
				createLionRunner: runner,
				createLionRpcRunner: runner,
				activeRuns,
				lifecycle,
				options: { resolveConfiguredLionModel() { throw rootCause; }, resolveLionRunnerMode() { return "json" as const; } } as never,
			},
		), (error: unknown) => {
			assert.match((error as Error).message, /adapter initialization failed: invalid model configuration/);
			assert.equal((error as Error & { cause?: unknown }).cause, rootCause);
			return true;
		});
	});

	it("selects the RPC runner explicitly and through LION_RUNNER", async () => {
		const oldRunner = process.env.LION_RUNNER;
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: "runner-selection",
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		let jsonCalls = 0, rpcCalls = 0;
		const jsonFactory = () => { jsonCalls++; return async () => ({ text: "", report: null }); };
		const rpcFactory = (config: { store: unknown }) => {
			rpcCalls++;
			assert.equal(config.store, lionStore);
			return async () => ({ text: "", report: null });
		};
		const deps = {
			lionStore,
			createLionRunner: jsonFactory,
			createLionRpcRunner: rpcFactory,
			activeRuns,
			options: { ...options, resolveConfiguredLionModel: () => undefined },
		};
		try {
			await createLionAdapter({ cwd: process.cwd(), isProjectTrusted: () => false } as never, { action: "run_wave", runner_mode: "rpc" } as never, undefined, undefined, deps as never);
			process.env.LION_RUNNER = "rpc";
			await createLionAdapter({ cwd: process.cwd(), isProjectTrusted: () => false } as never, { action: "run_wave" } as never, undefined, undefined, deps as never);
			assert.equal(jsonCalls, 0);
			assert.equal(rpcCalls, 2);
		} finally {
			if (oldRunner === undefined) delete process.env.LION_RUNNER; else process.env.LION_RUNNER = oldRunner;
		}
	});

	it("reports process metadata and pending-cancellation replay failures", async () => {
		const ledger = new LionLedger();
		let mutations = 0;
		const lionStore = {
			namespaceId: "control-diagnostics",
			async mutate<T>(fn: (l: LionLedger) => T) {
				mutations++;
				if (mutations === 2) throw new Error("metadata unavailable");
				return { result: fn(ledger) };
			},
			async query<T>(_fn: (l: LionLedger) => T): Promise<{ result: T }> { throw new Error("replay unavailable"); },
		};
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const runner = () => async (req: LionRunRequest) => {
			req.onProcessStart?.({ pid: process.pid, pgid: null, isAlive: () => false, cancel: () => false });
			req.onProcessExit?.();
			return { text: "ok", report };
		};
		const adapter = await createLionAdapter(
			{ cwd: process.cwd(), isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{ lionStore, createLionRunner: runner, createLionRpcRunner: runner, activeRuns },
		);
		const run = await adapter.createRun(assignment());
		await adapter.run(run, assignment(), () => undefined);
		for (let index = 0; index < 5 && warnings.mock.calls.length < 2; index++) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(warnings.mock.calls.some((call) => String(call[0]).includes("process metadata persistence failed")), true);
		assert.equal(warnings.mock.calls.some((call) => String(call[0]).includes("pending cancellation replay failed")), true);
		await adapter.finishRun(run.id, { output: "ok", report });
	});

	it("retains active ownership until finishRun finalizes the LION ledger", async () => {
		activeRuns.clearActiveRunsForTests();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-lion-adapter-"));
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: path.join(dir, "lion-runs.json"),
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		let exited = false;
		const runner = () => async (req: LionRunRequest) => {
			req.onProcessStart?.({ pid: process.pid, pgid: null, isAlive: () => !exited, cancel: () => true });
			exited = true;
			req.onProcessExit?.();
			return { text: "ok", report };
		};
		const adapter = await createLionAdapter(
			{ cwd: dir, isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{ lionStore, createLionRunner: runner, createLionRpcRunner: runner, activeRuns },
		);
		const run = await adapter.createRun(assignment());
		await adapter.run(run, assignment(), () => undefined);
		assert.ok(activeRuns.getActiveRunIds(lionStore.namespaceId).includes(run.id), "owner should remain while final LION ledger state is not persisted");
		await adapter.finishRun(run.id, { output: "ok", report });
		assert.ok(!activeRuns.getActiveRunIds(lionStore.namespaceId).includes(run.id), "owner should be released after finishRun persists final state");
		assert.equal(ledger.get(run.id)?.status, "completed");
		activeRuns.clearActiveRunsForTests();
	});

	it("keeps run_wave ownership and assignment settlement authority in the late cleanup supervisor", async () => {
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: "run-wave-cleanup-pending",
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const controller = new AbortController();
		let alive = true;
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
		const rpcFactory = () => async (request: LionRunRequest) => {
			const processInfo = { pid: 404, pgid: null, isAlive: () => alive, cancel: () => true };
			request.onProcessStart?.(processInfo);
			controller.abort();
			const accepted = request.registerCleanupSupervisor?.({
				namespaceId: request.cleanupOwner!.namespaceId,
				runId: request.run.id,
				incarnationId: request.run.incarnation_id ?? null,
				ownerId: request.cleanupOwner!.ownerId,
				process: processInfo,
				isAlive: () => alive,
				waitForExit: () => exited,
				cleanup: async () => undefined,
				terminalIntent: { kind: "result", output: { text: "done", report } },
			});
			assert.equal(accepted, true);
			return { settlement: "cleanup_pending" as const, run_id: request.run.id, incarnation_id: request.run.incarnation_id ?? null, owner_id: request.cleanupOwner!.ownerId };
		};
		const adapter = await createLionAdapter(
			{ cwd: process.cwd(), isProjectTrusted: () => false } as never,
			{ action: "run_wave", runner_mode: "rpc" } as never,
			controller.signal,
			undefined,
			{ lionStore, createLionRunner: rpcFactory, createLionRpcRunner: rpcFactory, activeRuns, cleanupSupervisor },
		);
		const run = await adapter.createRun(assignment());
		let lateSettlements = 0;
		const outcome = await adapter.run(run, assignment(), () => undefined, undefined, async (settlement) => {
			assert.equal(settlement.disposition, "terminal");
			lateSettlements++;
		});
		assert.equal("settlement" in outcome ? outcome.settlement : "settled", "cleanup_pending");
		assert.equal(ledger.get(run.id)?.status, "running");
		assert.deepEqual(activeRuns.getActiveRunIds(lionStore.namespaceId), [run.id]);
		alive = false;
		resolveExit();
		for (let index = 0; index < 100 && ledger.get(run.id)?.status === "running"; index++) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(ledger.get(run.id)?.status, "aborted");
		assert.equal(lateSettlements, 1);
		assert.deepEqual(activeRuns.getActiveRunIds(lionStore.namespaceId), []);
	});

	it("emits started progress and terminal LION telemetry for run_wave workers", async () => {
		activeRuns.clearActiveRunsForTests();
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: "telemetry-ledger",
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const events: Array<{ name: string; payload: any }> = [];
		const pi = { events: { emit(name: string, payload: unknown) { events.push({ name, payload }); } } } as never;
		const runner = () => async (req: LionRunRequest) => {
			req.onProgress?.({ event: "message", activity: "working", active_tools: [], tool_uses: 0, turn_count: 1, token_total: null, last_text: null, last_event_at: new Date().toISOString() });
			return { text: "ok", report };
		};
		const adapter = await createLionAdapter(
			{ cwd: process.cwd(), isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{ lionStore, createLionRunner: runner, createLionRpcRunner: runner, activeRuns, lifecycle },
			pi,
		);
		const run = await adapter.createRun(assignment());
		await adapter.updateProgress?.(run.id, { event: "message", activity: "working", active_tools: [], tool_uses: 0, turn_count: 1, token_total: null, last_text: null, last_event_at: new Date().toISOString() });
		await adapter.finishRun(run.id, { output: "ok", report });
		assert.deepEqual(events.map((event) => event.name), ["nervous:lion:started", "nervous:lion:progress", "nervous:lion:completed"]);
		assert.equal(events[0]?.payload.run_incarnation_id, run.incarnation_id);
		activeRuns.clearActiveRunsForTests();
	});

	it("does not finalize a replacement LION incarnation", async () => {
		const ledger = new LionLedger();
		const lionStore = {
			namespaceId: "finalization-fence",
			async mutate<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const runner = () => async () => ({ text: "", report: null });
		const adapter = await createLionAdapter(
			{ cwd: process.cwd(), isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{ lionStore, createLionRunner: runner, createLionRpcRunner: runner, activeRuns },
		);
		const original = await adapter.createRun(assignment());
		ledger.finish(original.id, { output: "external", report: null, status: "failed" });
		ledger.delete(original.id);
		const replacement = ledger.create({ objective: "replacement" });
		await assert.rejects(() => adapter.finishRun(original.id, { output: "stale", report }), /finalization superseded/);
		assert.equal(ledger.get(replacement.id)?.status, "running");
		assert.equal(ledger.get(replacement.id)?.output, null);
		assert.equal(activeRuns.getActiveRunIds(lionStore.namespaceId).length, 0);
	});

	it("does not let delayed process metadata mutate a reused run id", async () => {
		activeRuns.clearActiveRunsForTests();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-lion-stale-metadata-"));
		const ledger = new LionLedger();
		let mutationCount = 0;
		let releaseMetadata!: () => void;
		const metadataHeld = new Promise<void>((resolve) => { releaseMetadata = resolve; });
		const lionStore = {
			namespaceId: path.join(dir, "lion-runs.json"),
			async mutate<T>(fn: (l: LionLedger) => T) {
				mutationCount++;
				if (mutationCount === 2) await metadataHeld;
				return { result: fn(ledger) };
			},
			async query<T>(fn: (l: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const runner = () => async (req: LionRunRequest) => {
			req.onProcessStart?.({ pid: 111, pgid: null, isAlive: () => true, cancel: () => true });
			req.onProcessExit?.();
			return { text: "ok", report };
		};
		const adapter = await createLionAdapter(
			{ cwd: dir, isProjectTrusted: () => false } as never,
			{ action: "run_wave" } as never,
			undefined,
			undefined,
			{ lionStore, createLionRunner: runner, createLionRpcRunner: runner, activeRuns },
		);
		const original = await adapter.createRun(assignment());
		await adapter.run(original, assignment(), () => undefined);
		await adapter.finishRun(original.id, { output: "ok", report });
		ledger.delete(original.id);
		const replacement = ledger.create({ objective: "replacement" });
		assert.equal(replacement.id, original.id);
		releaseMetadata();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(ledger.get(replacement.id)?.control, null);
		activeRuns.clearActiveRunsForTests();
	});
});
