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
	it("defaults to <cwd>/.pi/ganglion/ganglion.json", () => {
		assert.equal(resolveGanglionLocation("/tmp/proj").ganglionPath, path.join("/tmp/proj", ".pi", "ganglion", "ganglion.json"));
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
