import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { CerebelStore, FileBackend, resolveCerebelLocation, withLock } from "../extension/backend.ts";

async function tmpStore(): Promise<{ dir: string; backend: FileBackend; store: CerebelStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-test-"));
	const backend = new FileBackend({ cerebelPath: path.join(dir, "cerebel.json"), dir });
	return { dir, backend, store: new CerebelStore(backend) };
}
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

describe("resolveCerebelLocation", () => {
	it("defaults to global project/context namespaced state", () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		process.env.NERVOUS_STATE_ROOT = "/tmp/nervous"; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "work";
		try { assert.equal(resolveCerebelLocation("/tmp/proj").cerebelPath, path.join("/tmp/nervous", "proj", "work", "cerebel", "cerebel.json")); }
		finally { if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot; if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject; if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext; }
	});
	it("respects CEREBEL_PATH when absolute", () => {
		const old = process.env.CEREBEL_PATH;
		process.env.CEREBEL_PATH = "/tmp/cerebel.json";
		try { assert.equal(resolveCerebelLocation("/x").cerebelPath, "/tmp/cerebel.json"); }
		finally { if (old === undefined) delete process.env.CEREBEL_PATH; else process.env.CEREBEL_PATH = old; }
	});
});

describe("FileBackend", () => {
	it("loads fresh when missing", async () => {
		const { backend } = await tmpStore();
		const { ledger, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(ledger.all().length, 0);
	});
	it("round-trips waves", async () => {
		const { store } = await tmpStore();
		await store.mutate((l) => l.planWave({ tasks: [{ id: "task-1", title: "A" }] }));
		const { result } = await store.query((l) => l.current());
		assert.equal(result?.id, "wave-001");
	});
	it("creates backup and no tmp after second save", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((l) => l.planWave({ tasks: [{ id: "a", title: "A" }] }));
		await store.mutate((l) => l.planWave({ tasks: [{ id: "b", title: "B" }] }));
		assert.ok(!(await exists(`${backend.location.cerebelPath}.tmp`)));
		assert.ok(await exists(`${backend.location.cerebelPath}.bak`));
	});
	it("serializes concurrent mutate load-write transactions", async () => {
		const { store } = await tmpStore();
		await Promise.all([
			store.mutate((l) => l.planWave({ tasks: [{ id: "a", title: "A" }] })),
			store.mutate((l) => l.planWave({ tasks: [{ id: "b", title: "B" }] })),
			store.mutate((l) => l.planWave({ tasks: [{ id: "c", title: "C" }] })),
		]);
		const { result } = await store.query((l) => l.all());
		assert.equal(result.length, 3);
		assert.deepEqual(new Set(result.map((w) => w.id)), new Set(["wave-001", "wave-002", "wave-003"]));
	});
	it("fails closed without rewriting state when exact provenance is malformed", async () => {
		const { backend, store, dir } = await tmpStore();
		const wave = (await store.mutate((ledger) => ledger.planWave({ tasks: [{ id: "task-001", title: "A" }] }))).result;
		await store.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] }));
		const raw = JSON.parse(await fs.readFile(backend.location.cerebelPath, "utf8"));
		raw.waves[wave.id].assignments[0].lion_run_incarnation_id = null;
		await fs.writeFile(backend.location.cerebelPath, JSON.stringify(raw), "utf8");
		await assert.rejects(() => backend.load(), /no migration or automatic reset was performed/);
		await assert.rejects(() => backend.mutate((ledger) => ledger.planWave({ tasks: [{ id: "task-002", title: "B" }] })), /no migration or automatic reset was performed/);
		const persisted = await fs.readFile(backend.location.cerebelPath, "utf8");
		assert.match(persisted, /run-001/);
		assert.equal((await fs.readdir(dir)).some((entry) => entry.startsWith("cerebel.json.corrupt-")), false);
	});

	it("fails closed without rewriting a malformed cleanup settlement obligation", async () => {
		const { backend, store, dir } = await tmpStore();
		const wave = (await store.mutate((ledger) => ledger.planWave({ assignments: [{ objective: "cleanup", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] }))).result;
		await store.mutate((ledger) => ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] }));
		await store.mutate((ledger) => ledger.markCleanupPendingSettlementIfOwned(wave.id, "assign-001", "run-001", "inc-001"));
		const raw = JSON.parse(await fs.readFile(backend.location.cerebelPath, "utf8"));
		raw.waves[wave.id].assignments[0].cleanup_pending_settlement.observed_at = 123;
		await fs.writeFile(backend.location.cerebelPath, JSON.stringify(raw), "utf8");
		await assert.rejects(() => backend.load(), /no migration or automatic reset was performed/);
		await assert.rejects(() => backend.mutate((ledger) => ledger.planWave({ tasks: [{ id: "task-002", title: "must not overwrite" }] })), /no migration or automatic reset was performed/);
		const persisted = JSON.parse(await fs.readFile(backend.location.cerebelPath, "utf8"));
		assert.equal(persisted.waves[wave.id].assignments[0].cleanup_pending_settlement.observed_at, 123);
		assert.equal((await fs.readdir(dir)).some((entry) => entry.startsWith("cerebel.json.corrupt-")), false);
	});

	it("recovers corrupt files", async () => {
		const { backend, dir } = await tmpStore();
		await fs.writeFile(backend.location.cerebelPath, "{ broken", "utf8");
		const { ledger, warnings } = await backend.load();
		assert.equal(ledger.all().length, 0);
		assert.ok(warnings.length > 0);
		const entries = await fs.readdir(dir);
		assert.ok(entries.some((e) => e.startsWith("cerebel.json.corrupt-")));
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
