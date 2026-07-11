import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { FileBackend, GanglionStore, resolveGanglionLocation, withLock } from "../extension/backend.ts";

async function tmpStore(): Promise<{ dir: string; backend: FileBackend; store: GanglionStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ganglion-test-"));
	const backend = new FileBackend({ ganglionPath: path.join(dir, "ganglion.json"), dir });
	return { dir, backend, store: new GanglionStore(backend) };
}
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

describe("resolveGanglionLocation", () => {
	it("defaults to global project/context namespaced state", () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		process.env.NERVOUS_STATE_ROOT = "/tmp/nervous"; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "work";
		try { assert.equal(resolveGanglionLocation("/tmp/proj").ganglionPath, path.join("/tmp/nervous", "proj", "work", "ganglion", "ganglion.json")); }
		finally { if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot; if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject; if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext; }
	});
	it("respects GANGLION_PATH when absolute", () => {
		const old = process.env.GANGLION_PATH;
		process.env.GANGLION_PATH = "/tmp/ganglion.json";
		try { assert.equal(resolveGanglionLocation("/x").ganglionPath, "/tmp/ganglion.json"); }
		finally { if (old === undefined) delete process.env.GANGLION_PATH; else process.env.GANGLION_PATH = old; }
	});
});

describe("FileBackend", () => {
	it("loads fresh when missing", async () => {
		const { backend } = await tmpStore();
		const { ledger, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(ledger.all().length, 0);
	});
	it("round-trips groups", async () => {
		const { store } = await tmpStore();
		await store.mutate((l) => l.create({ name: "persist" }));
		const { result } = await store.query((l) => l.current());
		assert.equal(result?.name, "persist");
	});
	it("serializes complete concurrent mutations and preserves the monotonic sequence", async () => {
		const { store } = await tmpStore();
		await Promise.all(Array.from({ length: 10 }, (_, index) => store.mutate((ledger) => ledger.create({ name: `group-${index}` }))));
		const groups = (await store.query((ledger) => ledger.all())).result;
		assert.equal(groups.length, 10);
		assert.equal(new Set(groups.map((group) => group.id)).size, 10);
		await store.mutate((ledger) => { for (const group of ledger.all()) ledger.delete(group.id); });
		const next = (await store.mutate((ledger) => ledger.create({ name: "next" }))).result;
		assert.equal(next.id, "ganglion-011");
	});

	it("backup and no tmp after second save", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((l) => l.create({ name: "a" }));
		await store.mutate((l) => l.create({ name: "b" }));
		assert.ok(!(await exists(`${backend.location.ganglionPath}.tmp`)));
		assert.ok(await exists(`${backend.location.ganglionPath}.bak`));
	});
	it("recovers corrupt files", async () => {
		const { backend, dir } = await tmpStore();
		await fs.writeFile(backend.location.ganglionPath, "{ broken", "utf8");
		const { ledger, warnings } = await backend.load();
		assert.equal(ledger.all().length, 0);
		assert.ok(warnings.length > 0);
		assert.ok((await fs.readdir(dir)).some((e) => e.startsWith("ganglion.json.corrupt-")));
	});
});

describe("withLock", () => {
	it("serializes concurrent critical sections", async () => {
		const { dir } = await tmpStore();
		const lockPath = path.join(dir, "x.lock");
		let inside = 0, max = 0;
		const work = () => withLock(lockPath, async () => { inside++; max = Math.max(max, inside); await new Promise((r) => setTimeout(r, 10)); inside--; });
		await Promise.all([work(), work(), work()]);
		assert.equal(max, 1);
		assert.ok(!(await exists(lockPath)));
	});
});
