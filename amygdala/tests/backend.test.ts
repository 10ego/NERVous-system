import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { AmygdalaStore, FileBackend, resolveAmygdalaLocation, withLock } from "../extension/backend.ts";

async function tmpStore(): Promise<{ dir: string; backend: FileBackend; store: AmygdalaStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amygdala-test-"));
	const backend = new FileBackend({ amygdalaPath: path.join(dir, "amygdala.json"), dir });
	return { dir, backend, store: new AmygdalaStore(backend) };
}
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

describe("resolveAmygdalaLocation", () => {
	it("defaults to <cwd>/.pi/amygdala/amygdala.json", () => {
		assert.equal(resolveAmygdalaLocation("/tmp/proj").amygdalaPath, path.join("/tmp/proj", ".pi", "amygdala", "amygdala.json"));
	});
	it("respects AMYGDALA_PATH when absolute", () => {
		const old = process.env.AMYGDALA_PATH;
		process.env.AMYGDALA_PATH = "/tmp/amygdala.json";
		try { assert.equal(resolveAmygdalaLocation("/x").amygdalaPath, "/tmp/amygdala.json"); }
		finally { if (old === undefined) delete process.env.AMYGDALA_PATH; else process.env.AMYGDALA_PATH = old; }
	});
});

describe("FileBackend", () => {
	it("loads fresh when missing", async () => {
		const { backend } = await tmpStore();
		const { ledger, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(ledger.all().length, 0);
	});
	it("round-trips incidents", async () => {
		const { store } = await tmpStore();
		await store.mutate((l) => l.assess({ description: "blocked" }));
		const { result } = await store.query((l) => l.all());
		assert.equal(result.length, 1);
		assert.equal(result[0]?.id, "risk-001");
	});
	it("backup and no tmp after second save", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((l) => l.assess({ description: "a" }));
		await store.mutate((l) => l.assess({ description: "b" }));
		assert.ok(!(await exists(`${backend.location.amygdalaPath}.tmp`)));
		assert.ok(await exists(`${backend.location.amygdalaPath}.bak`));
	});
	it("recovers corrupt files", async () => {
		const { backend, dir } = await tmpStore();
		await fs.writeFile(backend.location.amygdalaPath, "{ broken", "utf8");
		const { ledger, warnings } = await backend.load();
		assert.equal(ledger.all().length, 0);
		assert.ok(warnings.length > 0);
		assert.ok((await fs.readdir(dir)).some((e) => e.startsWith("amygdala.json.corrupt-")));
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
