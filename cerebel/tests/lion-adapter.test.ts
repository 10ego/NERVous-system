import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { createLionAdapter } from "../extension/index.ts";
import { LionLedger } from "../../lion/extension/store.ts";
import * as activeRuns from "../../lion/extension/active-runs.ts";
import type { Assignment } from "../extension/schema.ts";
import type { LionReport } from "../../lion/extension/schema.ts";
import type { LionRunRequest } from "../../lion/extension/subprocess.ts";

const report: LionReport = { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] };

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
