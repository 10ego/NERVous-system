import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { FileBackend, LionStore, resolveLionLocation, withLock } from "../extension/backend.ts";

async function tmpStore(): Promise<{ dir: string; backend: FileBackend; store: LionStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-test-"));
	const backend = new FileBackend({ runsPath: path.join(dir, "runs.json"), dir });
	return { dir, backend, store: new LionStore(backend) };
}
async function exists(p: string): Promise<boolean> {
	try { await fs.access(p); return true; } catch { return false; }
}

describe("resolveLionLocation", () => {
	it("defaults to global project/context namespaced state", () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT;
		const oldProject = process.env.NERVOUS_PROJECT;
		const oldContext = process.env.NERVOUS_CONTEXT;
		const oldLionRunsPath = process.env.LION_RUNS_PATH;
		process.env.NERVOUS_STATE_ROOT = "/tmp/nervous";
		process.env.NERVOUS_PROJECT = "proj";
		process.env.NERVOUS_CONTEXT = "work";
		delete process.env.LION_RUNS_PATH;
		try {
			assert.equal(resolveLionLocation("/tmp/proj").runsPath, path.join("/tmp/nervous", "proj", "work", "lion", "runs.json"));
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
			if (oldLionRunsPath === undefined) delete process.env.LION_RUNS_PATH; else process.env.LION_RUNS_PATH = oldLionRunsPath;
		}
	});
	it("respects absolute LION_RUNS_PATH", () => {
		const old = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = "/x/runs.json";
		try { assert.equal(resolveLionLocation("/tmp/proj").runsPath, "/x/runs.json"); }
		finally { if (old === undefined) delete process.env.LION_RUNS_PATH; else process.env.LION_RUNS_PATH = old; }
	});
});

describe("FileBackend", () => {
	it("loads a fresh empty ledger when missing", async () => {
		const { backend } = await tmpStore();
		const { ledger, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(ledger.all().length, 0);
	});

	it("round-trips runs through disk", async () => {
		const { store } = await tmpStore();
		await store.mutate((l) => l.create({ objective: "persist" }));
		const { result } = await store.query((l) => l.all());
		assert.equal(result.length, 1);
		assert.equal(result[0]?.objective, "persist");
	});

	it("skips saving conditional mutations when unchanged", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((l) => l.create({ objective: "persist" }));
		const before = await fs.readFile(backend.location.runsPath, "utf8");
		const out = await store.mutateMaybe((l) => ({ result: l.all().length, changed: false }));
		const after = await fs.readFile(backend.location.runsPath, "utf8");
		assert.equal(out.changed, false);
		assert.equal(out.result, 1);
		assert.equal(after, before);
	});

	it("leaves no tmp and creates backup after second save", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((l) => l.create({ objective: "a" }));
		await store.mutate((l) => l.create({ objective: "b" }));
		assert.ok(!(await exists(`${backend.location.runsPath}.tmp`)));
		assert.ok(await exists(`${backend.location.runsPath}.bak`));
	});

	it("serializes concurrent mutate load-write transactions", async () => {
		const { store } = await tmpStore();
		await Promise.all([
			store.mutate((l) => l.create({ objective: "a" })),
			store.mutate((l) => l.create({ objective: "b" })),
			store.mutate((l) => l.create({ objective: "c" })),
		]);
		const { result } = await store.query((l) => l.all());
		assert.equal(result.length, 3);
		assert.deepEqual(new Set(result.map((r) => r.id)), new Set(["run-001", "run-002", "run-003"]));
	});

	it("keeps a direct-symlink ledger on one canonical data and ownership namespace", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-symlink-test-"));
		const target = path.join(dir, "target-runs.json");
		const alias = path.join(dir, "alias-runs.json");
		await fs.writeFile(target, JSON.stringify({ version: 1, runs: {} }), "utf8");
		await fs.symlink(target, alias, "file");
		const first = new LionStore(new FileBackend({ runsPath: alias, dir }));
		await first.mutate((l) => l.create({ objective: "through symlink" }));
		const second = new LionStore(new FileBackend({ runsPath: alias, dir }));

		assert.equal(first.backend.location.runsPath, await fs.realpath(target));
		assert.equal(second.namespaceId, first.namespaceId);
		assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
		assert.equal((await second.query((l) => l.all())).result[0]?.objective, "through symlink");
	});

	it("preserves a direct symlink whose ledger target does not exist yet", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lion-dangling-symlink-test-"));
		const target = path.join(dir, "missing-target", "runs.json");
		const alias = path.join(dir, "alias-runs.json");
		await fs.symlink(target, alias, "file");
		const store = new LionStore(new FileBackend({ runsPath: alias, dir }));
		await store.mutate((l) => l.create({ objective: "create target" }));

		assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
		assert.equal(store.backend.location.runsPath, await fs.realpath(target));
		assert.equal(JSON.parse(await fs.readFile(target, "utf8")).runs["run-001"].objective, "create target");
	});

	it("fails closed without rewriting malformed cleanup-pending observations", async () => {
		const { backend, store, dir } = await tmpStore();
		const run = (await store.mutate((ledger) => ledger.create({ objective: "cleanup load", runner_mode: "rpc" }))).result;
		await store.mutate((ledger) => ledger.updateControl(run.id, {
			pid: 6161,
			cleanup_pending: {
				observed_at: run.started_at,
				incarnation_id: run.incarnation_id ?? null,
				pid: 6161,
				pgid: null,
				process_identity: null,
			},
		}));
		const raw = JSON.parse(await fs.readFile(backend.location.runsPath, "utf8"));
		raw.runs[run.id].control.cleanup_pending.observed_at = 123;
		await fs.writeFile(backend.location.runsPath, JSON.stringify(raw), "utf8");
		await assert.rejects(() => backend.load(), /no migration or automatic reset was performed/);
		await assert.rejects(() => backend.mutate((ledger) => ledger.create({ objective: "must not overwrite" })), /no migration or automatic reset was performed/);
		const persisted = JSON.parse(await fs.readFile(backend.location.runsPath, "utf8"));
		assert.equal(persisted.runs[run.id].control.cleanup_pending.observed_at, 123);
		assert.equal((await fs.readdir(dir)).some((entry) => entry.startsWith("runs.json.corrupt-")), false);
	});

	it("recovers corrupt files", async () => {
		const { backend, dir } = await tmpStore();
		await fs.writeFile(backend.location.runsPath, "{ broken", "utf8");
		const { ledger, warnings } = await backend.load();
		assert.equal(ledger.all().length, 0);
		assert.ok(warnings.length > 0);
		const entries = await fs.readdir(dir);
		assert.ok(entries.some((e) => e.startsWith("runs.json.corrupt-")));
	});
});

describe("withLock", () => {
	it("serializes concurrent critical sections", async () => {
		const { dir } = await tmpStore();
		const lockPath = path.join(dir, "x.lock");
		let inside = 0;
		let max = 0;
		const work = () => withLock(lockPath, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 10)); inside--; });
		await Promise.all([work(), work(), work()]);
		assert.equal(max, 1);
		assert.ok(!(await exists(lockPath)));
	});
});
