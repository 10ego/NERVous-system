import * as assert from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { FileBackend, LionStore } from "../extension/backend.ts";
import { LionLedger } from "../extension/store.ts";
import { MAX_PROGRESS_ENVELOPE_BYTES, progressSidecarHash, type ProgressEnvelope } from "../extension/progress-sidecar.ts";
import type { LionProgressSnapshot, LionRun } from "../extension/schema.ts";

async function makeStore(label = "sidecar"): Promise<{ dir: string; backend: FileBackend; store: LionStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `lion-${label}-`));
	const backend = new FileBackend({ runsPath: path.join(dir, "runs.json"), dir });
	return { dir, backend, store: new LionStore(backend) };
}
function snapshot(activity: string, turn = 1): LionProgressSnapshot {
	return { event: "message", activity, active_tools: ["bash"], tool_uses: turn, turn_count: turn, token_total: turn * 10, last_text: null, last_event_at: new Date(Date.now() + turn).toISOString() };
}
async function createRunning(store: LionStore, objective = "work"): Promise<LionRun> {
	return (await store.mutate((ledger) => ledger.create({ objective }))).result;
}
async function exists(filePath: string): Promise<boolean> { try { await fs.lstat(filePath); return true; } catch { return false; } }
const execFileAsync = promisify(execFile);

async function flushInChild(runsPath: string, run: Pick<LionRun, "id" | "incarnation_id">, activityPrefix: string): Promise<void> {
	const require = createRequire(import.meta.url);
	const vitestCli = require.resolve("vitest/vitest.mjs");
	const fixture = fileURLToPath(new URL("./progress-sidecar-process.fixture.test.ts", import.meta.url));
	await execFileAsync(process.execPath, [vitestCli, "run", fixture, "--reporter=dot"], {
		cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
		env: {
			...process.env,
			LION_PROGRESS_CHILD: "1",
			LION_RUNS_PATH: runsPath,
			LION_RUN_ID: run.id,
			LION_INCARNATION_ID: run.incarnation_id!,
			LION_ACTIVITY_PREFIX: activityPrefix,
		},
	});
}

async function assertFlushHasZeroCanonicalIo(historySize: number): Promise<{ sidecarBytes: number; canonicalSize: number }> {
	const { backend, store } = await makeStore(`scale-${historySize}`);
	const history = new LionLedger();
	for (let index = 0; index < historySize; index++) {
		const run = history.create({ objective: `historical-${index}-${"x".repeat(100)}` });
		history.finish(run.id, { output: "done", report: null, status: "completed" });
	}
	await backend.save(history);
	const run = await createRunning(store, "current");
	const canonicalSize = (await fs.stat(backend.location.runsPath)).size;
	store.resetIoCounters();
	await store.flushProgress(run, snapshot("bounded"));
	const counters = store.ioCounters();
	assert.deepEqual(
		[counters.canonical_reads, counters.canonical_parses, counters.canonical_backups, counters.canonical_serializations, counters.canonical_writes, counters.canonical_bytes_read, counters.canonical_bytes_written],
		[0, 0, 0, 0, 0, 0, 0],
	);
	assert.ok(counters.sidecar_bytes_written <= MAX_PROGRESS_ENVELOPE_BYTES * 2);
	return { sidecarBytes: counters.sidecar_bytes_written, canonicalSize };
}

describe("exact-incarnation progress sidecars", () => {
	it("uses a hashed safe mode-0600 path and stores the full versioned identity", async () => {
		const { backend, store } = await makeStore("identity");
		const run = await createRunning(store);
		assert.ok(run.incarnation_id);
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		assert.equal(path.basename(paths.primary), `${progressSidecarHash(store.namespaceId, run.id, run.incarnation_id!)}.json`);
		assert.equal(paths.primary.includes(run.id), false);
		const envelope = JSON.parse(await fs.readFile(paths.primary, "utf8")) as ProgressEnvelope;
		assert.deepEqual([envelope.version, envelope.namespace, envelope.run_id, envelope.incarnation_id, envelope.state, envelope.sequence], [1, store.namespaceId, run.id, run.incarnation_id, "open", 0]);
		assert.equal((await fs.stat(paths.primary)).mode & 0o777, 0o600);
	});

	it("does not create or backfill authority for legacy null incarnations", async () => {
		const { backend, store } = await makeStore("legacy");
		await backend.save(LionLedger.fromJSON({ version: 1, updated_at: new Date().toISOString(), runs: { "run-legacy": { id: "run-legacy", incarnation_id: null, agent_id: "lion-legacy", status: "running", task_id: null, objective: "legacy", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), progress: snapshot("inline") } } }));
		const accepted = await store.flushProgress({ id: "run-legacy", incarnation_id: null }, snapshot("new"));
		assert.equal(accepted, undefined);
		assert.equal((await store.query((ledger) => ledger.get("run-legacy"))).result?.progress?.activity, "inline");
		assert.equal(await exists(backend.progress.root), false);
	});

	it("increments monotonic sequence and selects the highest valid exact primary or backup", async () => {
		const { backend, store } = await makeStore("sequence");
		const run = await createRunning(store);
		const ref = { id: run.id, incarnation_id: run.incarnation_id! };
		await store.flushProgress(run, snapshot("one", 1));
		await store.flushProgress(run, snapshot("two", 2));
		const paths = backend.progress.paths(ref);
		const primary = JSON.parse(await fs.readFile(paths.primary, "utf8")) as ProgressEnvelope;
		const backup = JSON.parse(await fs.readFile(paths.backup, "utf8")) as ProgressEnvelope;
		assert.deepEqual([primary.sequence, primary.progress?.activity, backup.sequence, backup.progress?.activity], [2, "two", 1, "one"]);
		await fs.writeFile(paths.primary, "{malformed", { mode: 0o600 });
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "one");
		await store.flushProgress(run, snapshot("recovered", 3));
		assert.equal((JSON.parse(await fs.readFile(paths.primary, "utf8")) as ProgressEnvelope).progress?.activity, "recovered");
	});

	it("fences stale writers and reused run ids by exact incarnation", async () => {
		const { store } = await makeStore("reuse");
		const original = await createRunning(store, "original");
		await store.flushProgress(original, snapshot("original"));
		await store.finishRun(original.id, original.incarnation_id, { output: "done", report: null, status: "completed" });
		await store.deleteRun(original.id);
		const replacement = await createRunning(store, "replacement");
		assert.equal(replacement.id, original.id);
		assert.notEqual(replacement.incarnation_id, original.incarnation_id);
		assert.equal(await store.flushProgress(original, snapshot("stale")), undefined);
		await store.flushProgress(replacement, snapshot("replacement"));
		assert.equal((await store.query((ledger) => ledger.get(replacement.id))).result?.progress?.activity, "replacement");
	});

	it("rejects symlink roots and symlink artifacts without following them", async () => {
		const { backend, store, dir } = await makeStore("symlink");
		const run = await createRunning(store);
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const victim = path.join(dir, "victim");
		await fs.writeFile(victim, "untouched");
		await fs.unlink(paths.primary);
		await fs.symlink(victim, paths.primary);
		await assert.rejects(() => store.flushProgress(run, snapshot("unsafe")), /malformed artifacts|symlink/);
		assert.equal(await fs.readFile(victim, "utf8"), "untouched");

		const safeRun = await createRunning(store, "backup symlink");
		await store.flushProgress(safeRun, snapshot("one"));
		const safePaths = backend.progress.paths({ id: safeRun.id, incarnation_id: safeRun.incarnation_id! });
		await fs.unlink(safePaths.backup);
		await fs.symlink(victim, safePaths.backup);
		await store.flushProgress(safeRun, snapshot("two", 2));
		assert.equal(await fs.readFile(victim, "utf8"), "untouched");

		const { backend: rootBackend, store: rootStore, dir: rootDir } = await makeStore("root-symlink");
		const rootRun = await createRunning(rootStore);
		await fs.rm(rootBackend.progress.root, { recursive: true });
		await fs.symlink(rootDir, rootBackend.progress.root, "dir");
		await assert.rejects(() => rootStore.flushProgress(rootRun, snapshot("unsafe-root")), /unsafe root/);
	});

	it("bounds snapshots and never replaces the last valid envelope with oversized data", async () => {
		const { backend, store } = await makeStore("bounded");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("valid"));
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const before = await fs.readFile(paths.primary);
		await assert.rejects(() => store.flushProgress(run, { ...snapshot("huge"), activity: "x".repeat(20_000) }), /bounded schema/);
		assert.deepEqual(await fs.readFile(paths.primary), before);
		assert.ok((await fs.stat(paths.primary)).size <= MAX_PROGRESS_ENVELOPE_BYTES);
	});

	it("folds the final drained snapshot and removes exact artifacts", async () => {
		const { backend, store } = await makeStore("fold");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("latest", 7));
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const outcome = await store.finishRun(run.id, run.incarnation_id, { output: "done", report: null, status: "completed" });
		assert.equal(outcome.result.run?.progress?.activity, "latest");
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "latest");
		assert.equal(await exists(paths.primary), false);
		assert.equal(await exists(paths.backup), false);
	});

	it("folds progress through reconciliation terminal paths that use generic canonical mutations", async () => {
		const { backend, store } = await makeStore("reconcile-fold");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("before owner loss", 9));
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const changed = await store.mutate((ledger) => ledger.reconcileControls(() => false, { now_ms: Date.now() + 60_000, stale_after_ms: 1, active_run_refs: [] }));
		assert.equal(changed.result[0]?.status, "failed");
		assert.equal(changed.result[0]?.progress?.activity, "before owner loss");
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "before owner loss");
		assert.equal(await exists(paths.primary), false);
	});

	it("removes abandoned atomic-write temp files before later admission capacity accounting", async () => {
		const { backend, store } = await makeStore("temp-cleanup");
		const run = await createRunning(store);
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const abandoned = `${paths.primary}.tmp-999-00000000-0000-4000-8000-000000000000`;
		await fs.writeFile(abandoned, Buffer.alloc(MAX_PROGRESS_ENVELOPE_BYTES), { mode: 0o600 });

		await createRunning(store, "admission removes abandoned temp");
		await store.flushProgress(run, snapshot("after crash"));

		assert.equal(await exists(abandoned), false);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "after crash");
	});

	it("recovers an interrupted snapshot replacement from the last accepted envelope", async () => {
		const { backend, store } = await makeStore("append-crash");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("accepted", 1));
		const originalWritePrimary = (backend.progress as any).writePrimaryUnlocked.bind(backend.progress);
		(backend.progress as any).writePrimaryUnlocked = async () => { throw new Error("crash before primary replacement"); };
		await assert.rejects(() => store.flushProgress(run, snapshot("not accepted", 2)), /crash before primary replacement/);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "accepted");
		(backend.progress as any).writePrimaryUnlocked = originalWritePrimary;
		await store.flushProgress(run, snapshot("retried", 3));
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "retried");
	});

	it("makes a pre-commit closed snapshot retryable and rejects late writers", async () => {
		const { backend, store } = await makeStore("precommit");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("accepted", 4));
		const originalSave = (backend as any).saveUnlocked.bind(backend);
		let fail = true;
		(backend as any).saveUnlocked = async (...args: unknown[]) => { if (fail) { fail = false; throw new Error("crash before canonical commit"); } return originalSave(...args); };
		await assert.rejects(() => store.finishRun(run.id, run.incarnation_id, { output: "done", report: null }), /crash before canonical commit/);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.status, "running");
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "accepted");
		assert.equal(await store.flushProgress(run, snapshot("late")), undefined);
		(backend as any).saveUnlocked = originalSave;
		const retried = await store.finishRun(run.id, run.incarnation_id, { output: "done", report: null });
		assert.equal(retried.result.committed, true);
		assert.equal(retried.result.run?.progress?.activity, "accepted");
	});

	it("leaves only the closed fence when terminal cleanup is interrupted", async () => {
		const { backend, store } = await makeStore("cleanup-order");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("accepted"));
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const originalUnlink = (backend.progress as any).unlinkArtifactUnlocked.bind(backend.progress);
		(backend.progress as any).unlinkArtifactUnlocked = async (filePath: string) => {
			if (filePath === paths.primary) throw Object.assign(new Error("simulated cleanup interruption"), { code: "EIO" });
			return originalUnlink(filePath);
		};
		const finished = await store.finishRun(run.id, run.incarnation_id, { output: "done", report: null });
		(backend.progress as any).unlinkArtifactUnlocked = originalUnlink;
		assert.equal(finished.result.run?.status, "completed");
		assert.match(finished.warnings.join("\n"), /cleanup deferred/);
		assert.equal(await exists(paths.backup), false, "open backup must be removed first");
		assert.equal(await exists(paths.primary), true, "closed primary remains as the stale-writer fence");
		assert.equal(await store.flushProgress(run, snapshot("late")), undefined);
	});

	it("treats post-commit cleanup failure as terminal canonical truth and later sweeps the orphan", async () => {
		const { backend, store } = await makeStore("postcommit");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("accepted"));
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		const originalRemove = backend.progress.removeExactUnlocked.bind(backend.progress);
		(backend.progress as any).removeExactUnlocked = async () => { throw new Error("cleanup crash"); };
		const finished = await store.finishRun(run.id, run.incarnation_id, { output: "done", report: null });
		assert.equal(finished.result.run?.status, "completed");
		assert.equal(await exists(paths.primary), true);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "accepted");
		(backend.progress as any).removeExactUnlocked = originalRemove;
		await store.cleanupProgressArtifacts();
		assert.equal(await exists(paths.primary), false);
	});

	it("quarantines malformed primary/backup state without resetting canonical provenance", async () => {
		const { backend, store } = await makeStore("malformed");
		const run = await createRunning(store);
		const paths = backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! });
		await fs.writeFile(paths.primary, JSON.stringify({ version: 999, namespace: store.namespaceId }), { mode: 0o600 });
		await fs.writeFile(paths.backup, "not-json", { mode: 0o600 });
		const loaded = await store.query((ledger) => ledger.get(run.id));
		assert.equal(loaded.result?.id, run.id);
		assert.equal(loaded.result?.status, "running");
		assert.equal(loaded.result?.progress, null);
		assert.ok(loaded.warnings.length > 0);
		await assert.rejects(() => store.flushProgress(run, snapshot("ignored")), /malformed artifacts/);
		const quarantine = await fs.readdir(path.join(backend.progress.root, "quarantine"));
		assert.ok(quarantine.length <= 16);
		assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.id, run.id);
	});

	it("cleanup removes only proven terminal/missing/malformed entries and never age-evicts active or unclassifiable files", async () => {
		const { backend, store } = await makeStore("cleanup");
		const active = await createRunning(store);
		const activePaths = backend.progress.paths({ id: active.id, incarnation_id: active.incarnation_id! });
		const old = new Date("2000-01-01T00:00:00.000Z");
		await fs.utimes(activePaths.primary, old, old);
		const unknown = path.join(backend.progress.root, "operator-note.keep");
		await fs.writeFile(unknown, "unclassifiable", { mode: 0o600 });
		const orphanRef = { id: "run-missing", incarnation_id: "inc-missing" };
		const orphanPaths = backend.progress.paths(orphanRef);
		const orphan: ProgressEnvelope = { version: 1, namespace: store.namespaceId, run_id: orphanRef.id, incarnation_id: orphanRef.incarnation_id, state: "open", sequence: 0, progress: null, updated_at: new Date().toISOString() };
		await fs.writeFile(orphanPaths.primary, JSON.stringify(orphan), { mode: 0o600 });
		await store.cleanupProgressArtifacts();
		assert.equal(await exists(activePaths.primary), true, "old active authority must survive cleanup");
		assert.equal(await exists(unknown), true, "unclassifiable entries must survive cleanup");
		assert.equal(await exists(orphanPaths.primary), false, "canonically missing exact entry is proven stale");
	});

	it("never sweeps existing sidecars when canonical classification is uncertain", async () => {
		const { backend, store } = await makeStore("uncertain-canonical");
		const original = await createRunning(store, "original active run");
		await store.flushProgress(original, snapshot("accepted"));
		const originalPaths = backend.progress.paths({ id: original.id, incarnation_id: original.incarnation_id! });

		await fs.writeFile(backend.location.runsPath, "{corrupt", "utf8");
		const admitted = await store.mutate((ledger) => ledger.create({ objective: "new after corrupt canonical" }));
		const replacementPaths = backend.progress.paths({ id: admitted.result.id, incarnation_id: admitted.result.incarnation_id! });

		assert.match(admitted.warnings.join("\n"), /classification is uncertain/);
		assert.equal(await exists(originalPaths.primary), true, "uncertain canonical state must not classify the original sidecar as stale");
		assert.equal(await exists(replacementPaths.primary), true, "the newly admitted exact run still receives its own authority");
		assert.notEqual(admitted.result.incarnation_id, original.incarnation_id);
	});

	it("rejects sidecar roots beneath writable shared parents", async () => {
		if (process.platform === "win32") return;
		const { dir, store } = await makeStore("unsafe-parent");
		await fs.chmod(dir, 0o777);
		await assert.rejects(() => store.mutate((ledger) => ledger.create({ objective: "unsafe parent" })), /unsafe parent/);
	});

	it("overlays active sidecars without cloning or sorting historical runs", async () => {
		const { store } = await makeStore("overlay-refs");
		const run = await createRunning(store);
		await store.flushProgress(run, snapshot("overlay"));
		const originalAll = LionLedger.prototype.all;
		(LionLedger.prototype as any).all = () => { throw new Error("overlay must not call all"); };
		try {
			assert.equal((await store.query((ledger) => ledger.get(run.id))).result?.progress?.activity, "overlay");
		} finally { LionLedger.prototype.all = originalAll; }
	});

	it("reserves a backup slot when admitting a sidecar authority", async () => {
		const { backend, store } = await makeStore("capacity-reservation");
		(backend.progress as any).limits = { maxFiles: 2, maxBytes: MAX_PROGRESS_ENVELOPE_BYTES * 4 };
		const first = await createRunning(store, "first");
		await store.flushProgress(first, snapshot("first flush"));
		await assert.rejects(() => createRunning(store, "second"), /capacity reached/);
		const terminal = await store.finishRun(first.id, first.incarnation_id, { output: "done", report: null });
		assert.equal(terminal.result.run?.status, "completed");
	});

	it("keeps high-cardinality flushes free of capacity directory scans", async () => {
		const { store } = await makeStore("flush-scaling");
		const runs = (await store.mutate((ledger) => Array.from({ length: 48 }, (_, index) => ledger.create({ objective: `active-${index}` })))).result;
		store.resetIoCounters();
		await Promise.all(runs.map((run, index) => store.flushProgress(run, snapshot(`flush-${index}`))));
		const counters = store.ioCounters();
		assert.equal(counters.sidecar_capacity_scans, 0);
		assert.equal(counters.sidecar_capacity_entries, 0);
	});

	it("serializes concurrent workers under one namespace lock without cross-writing", async () => {
		const { store } = await makeStore("concurrent");
		const runs = (await store.mutate((ledger) => Array.from({ length: 12 }, (_, index) => ledger.create({ objective: `worker-${index}` })))).result;
		await Promise.all(runs.flatMap((run, index) => [1, 2, 3].map((turn) => store.flushProgress(run, snapshot(`${index}:${turn}`, turn)))));
		const loaded = (await store.query((ledger) => runs.map((run) => ledger.get(run.id)))).result;
		for (const [index, run] of loaded.entries()) assert.match(run?.progress?.activity ?? "", new RegExp(`^${index}:`));
	});

	it("serializes independent processes without crossing exact run identities", async () => {
		const { backend, store } = await makeStore("multiprocess");
		const runs = (await store.mutate((ledger) => [ledger.create({ objective: "process-a" }), ledger.create({ objective: "process-b" })])).result;
		await Promise.all(runs.flatMap((run, index) => ["a", "b"].map((processLabel) => flushInChild(backend.location.runsPath, run, `process-${index}-${processLabel}`))));
		const loaded = (await store.query((ledger) => runs.map((run) => ledger.get(run.id)))).result;
		for (const [index, run] of loaded.entries()) assert.match(run?.progress?.activity ?? "", new RegExp(`^process-${index}-[ab]:`));
		for (const run of runs) {
			const primary = JSON.parse(await fs.readFile(backend.progress.paths({ id: run.id, incarnation_id: run.incarnation_id! }).primary, "utf8")) as ProgressEnvelope;
			assert.deepEqual([primary.run_id, primary.incarnation_id], [run.id, run.incarnation_id]);
		}
	}, 20_000);

	it("keeps flush canonical work at zero and sidecar bytes bounded for small and large ledgers", async () => {
		const small = await assertFlushHasZeroCanonicalIo(1);
		const large = await assertFlushHasZeroCanonicalIo(600);
		assert.ok(large.canonicalSize > small.canonicalSize * 100);
		assert.ok(large.sidecarBytes <= MAX_PROGRESS_ENVELOPE_BYTES * 2);
		assert.ok(small.sidecarBytes <= MAX_PROGRESS_ENVELOPE_BYTES * 2);
	});
});
