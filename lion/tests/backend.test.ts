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
