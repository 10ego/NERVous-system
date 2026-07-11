import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { attachActiveRunProcess, beginActiveRun, clearActiveRunsForTests, finishActiveRun, getActiveRunIds, requestRunCancellation } from "../extension/active-runs.ts";
import { clearLionCleanupSupervisorsForTests, finalizeExactLionRun, hasLionCleanupSupervisor, registerLionCleanupSupervisor, type LionCleanupHandoff } from "../extension/cleanup-supervisor.ts";
import { LionLedger } from "../extension/store.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function memoryStore(namespaceId = "cleanup-supervisor-tests") {
	const ledger = new LionLedger();
	return {
		namespaceId,
		ledger,
		async mutate<T>(fn: (value: LionLedger) => T) { return { result: fn(ledger) }; },
		async query<T>(fn: (value: LionLedger) => T) { return { result: fn(ledger) }; },
		async mutateMaybe<T>(fn: (value: LionLedger) => { result: T; changed: boolean }) { return fn(ledger); },
	};
}

async function until(predicate: () => boolean, timeoutMs = 1_000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for supervisor");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

afterEach(() => {
	clearLionCleanupSupervisorsForTests();
	clearActiveRunsForTests();
});

describe("LION cleanup supervisor", () => {
	it("retains the exact owner through duplicate exit and retries late finalization/settlement exactly once", async () => {
		const store = memoryStore();
		const run = store.ledger.create({ objective: "late cleanup", runner_mode: "rpc" });
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "rpc");
		const exit = deferred();
		let alive = true;
		attachActiveRunProcess(owner, { pid: 101, pgid: null, isAlive: () => alive, cancel: () => true });
		let cleanupCalls = 0;
		let finalizeCalls = 0;
		let terminalEmissions = 0;
		let settlementAttempts = 0;
		let settlementEmissions = 0;
		const handoff: LionCleanupHandoff = {
			namespaceId: owner.namespaceId,
			runId: owner.runId,
			incarnationId: owner.incarnationId ?? null,
			ownerId: owner.ownerId,
			process: { pid: 101, pgid: null, isAlive: () => alive },
			isAlive: () => alive,
			waitForExit: () => exit.promise,
			cleanup: async () => { cleanupCalls++; if (cleanupCalls === 1) throw new Error("transient temp cleanup failure"); },
			terminalIntent: { kind: "result", output: { text: "done", report: null } },
		};
		assert.equal(registerLionCleanupSupervisor({
			owner,
			handoff,
			retryDelayMs: 1,
			finalize: async (intent) => {
				finalizeCalls++;
				if (finalizeCalls === 1) throw new Error("transient lock failure");
				assert.equal(intent.kind, "result");
				return finalizeExactLionRun(store, owner, { output: "done", report: null });
			},
			emitTerminal: () => { terminalEmissions++; },
			onSettled: async () => {
				settlementAttempts++;
				if (settlementAttempts === 1) throw new Error("transient CEREBEL write failure");
				settlementEmissions++;
			},
			releaseOwner: () => finishActiveRun(owner),
		}), true);
		assert.equal(hasLionCleanupSupervisor(owner), true);
		assert.deepEqual(getActiveRunIds(store.namespaceId), [run.id]);
		alive = false;
		exit.resolve();
		exit.resolve();
		await until(() => getActiveRunIds(store.namespaceId).length === 0);
		assert.equal(store.ledger.get(run.id)?.status, "completed");
		assert.equal(cleanupCalls, 2);
		assert.equal(finalizeCalls, 2);
		assert.equal(terminalEmissions, 1);
		assert.equal(settlementAttempts, 2);
		assert.equal(settlementEmissions, 1);
		assert.equal(hasLionCleanupSupervisor(owner), false);
	});

	it("treats an ambiguous committed persistence failure as authoritative terminal state", async () => {
		const ledger = new LionLedger();
		const run = ledger.create({ objective: "ambiguous", runner_mode: "rpc" });
		const owner = beginActiveRun({ namespaceId: "ambiguous-store", runId: run.id, incarnationId: run.incarnation_id }, "rpc");
		let writes = 0;
		const store = {
			async mutate<T>(fn: (value: LionLedger) => T): Promise<{ result: T }> {
				writes++;
				fn(ledger);
				throw new Error("connection lost after commit");
			},
			async query<T>(fn: (value: LionLedger) => T) { return { result: fn(ledger) }; },
		};
		const result = await finalizeExactLionRun(store, owner, { output: "done", report: null });
		assert.equal(result.disposition, "terminal");
		assert.equal((result.run as { status: string }).status, "completed");
		assert.equal(writes, 1);
		finishActiveRun(owner);
	});

	it("fences a replacement incarnation and never mutates it", async () => {
		const store = memoryStore("replacement-fence");
		const original = store.ledger.create({ objective: "old", runner_mode: "rpc" });
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: original.id, incarnationId: original.incarnation_id }, "rpc");
		store.ledger.finish(original.id, { output: "old", report: null, status: "failed" });
		store.ledger.delete(original.id);
		const replacement = store.ledger.create({ objective: "new", runner_mode: "rpc" });
		const result = await finalizeExactLionRun(store, owner, { output: "stale", report: null });
		assert.equal(result.disposition, "superseded");
		assert.notEqual(replacement.incarnation_id, original.incarnation_id);
		assert.equal(store.ledger.get(replacement.id)?.status, "running");
		assert.equal(store.ledger.get(replacement.id)?.output, null);
		finishActiveRun(owner);
	});

	it("keeps an otherwise-idle process alive until a supervisor retry succeeds", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lion-supervisor-liveness-"));
		const marker = path.join(dir, "retried");
		const supervisorUrl = pathToFileURL(path.resolve(process.cwd(), "lion/extension/cleanup-supervisor.ts")).href;
		const activeRunsUrl = pathToFileURL(path.resolve(process.cwd(), "lion/extension/active-runs.ts")).href;
		const script = `
			import fs from "node:fs";
			import { beginActiveRun, finishActiveRun } from ${JSON.stringify(activeRunsUrl)};
			import { registerLionCleanupSupervisor } from ${JSON.stringify(supervisorUrl)};
			const owner = beginActiveRun({ namespaceId: "idle-retry", runId: "run-001", incarnationId: "inc-001" }, "rpc");
			let alive = true;
			let attempts = 0;
			const accepted = registerLionCleanupSupervisor({
				owner,
				handoff: {
					namespaceId: owner.namespaceId, runId: owner.runId, incarnationId: owner.incarnationId,
					ownerId: owner.ownerId, process: { pid: 1, pgid: null }, isAlive: () => alive,
					waitForExit: async () => { alive = false; }, cleanup: async () => {},
					terminalIntent: { kind: "result", output: { text: "done", report: null } },
				},
				retryDelayMs: 40,
				finalize: async () => {
					attempts++;
					if (attempts === 1) throw new Error("retry");
					fs.writeFileSync(${JSON.stringify(marker)}, "retried");
					return { disposition: "superseded" };
				},
				releaseOwner: () => finishActiveRun(owner),
			});
			if (!accepted) process.exitCode = 2;
		`;
		const child = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 2_000 });
		assert.equal(child.status, 0, child.stderr);
		assert.equal(fs.readFileSync(marker, "utf8"), "retried");
	});

	it("registry loss performs no persisted-PID reattachment or signaling", async () => {
		const store = memoryStore("restart-no-signal");
		const run = store.ledger.create({ objective: "restart", runner_mode: "rpc" });
		const owner = beginActiveRun({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id }, "rpc");
		let signals = 0;
		attachActiveRunProcess(owner, { pid: 202, pgid: null, isAlive: () => true, cancel: () => { signals++; return true; } });
		store.ledger.updateControlIfCurrent(run.id, run.incarnation_id, { pid: 202, pgid: null, started_at: new Date().toISOString() });
		clearLionCleanupSupervisorsForTests();
		clearActiveRunsForTests();
		const cancellation = await requestRunCancellation(store, run.id, "after restart", { expectedIncarnationId: run.incarnation_id });
		assert.equal(cancellation.delivery?.delivered ?? false, false);
		assert.equal(signals, 0);
	});
});
