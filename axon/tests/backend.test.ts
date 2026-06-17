import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { AxonStore, FileBackend, resolveLedgerLocation, withLock } from "../extension/backend.ts";
import { Ledger } from "../extension/store.ts";

async function tmpLedger(): Promise<{ dir: string; backend: FileBackend; store: AxonStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "axon-test-"));
	const loc = { ledgerPath: path.join(dir, "ledger.json"), dir };
	const backend = new FileBackend(loc);
	return { dir, backend, store: new AxonStore(backend) };
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

describe("resolveLedgerLocation", () => {
	it("defaults to <cwd>/.pi/axon/ledger.json", () => {
		const loc = resolveLedgerLocation("/tmp/proj");
		assert.equal(loc.ledgerPath, path.join("/tmp/proj", ".pi", "axon", "ledger.json"));
	});
	it("respects AXON_LEDGER_PATH when absolute", () => {
		const old = process.env.AXON_LEDGER_PATH;
		process.env.AXON_LEDGER_PATH = "/custom/path/ledger.json";
		try {
			assert.equal(resolveLedgerLocation("/tmp/proj").ledgerPath, "/custom/path/ledger.json");
		} finally {
			if (old === undefined) delete process.env.AXON_LEDGER_PATH;
			else process.env.AXON_LEDGER_PATH = old;
		}
	});
});

describe("FileBackend — load/save persistence", () => {
	it("load on missing file returns an empty fresh ledger", async () => {
		const { backend } = await tmpLedger();
		const { ledger, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(ledger.all().length, 0);
	});

	it("round-trips tasks through disk", async () => {
		const { backend, dir } = await tmpLedger();
		const store = new AxonStore(backend);
		const t = await store.mutate((l) => l.create({ title: "persisted", priority: "high" }));
		assert.equal(t.result.id, "task-001");

		// New backend/store pointed at the same file sees the task.
		const store2 = new AxonStore(new FileBackend({ ledgerPath: path.join(dir, "ledger.json"), dir }));
		const r = await store2.query((l) => l.get("task-001"));
		assert.equal(r.result?.title, "persisted");
		assert.equal(r.result?.priority, "high");
	});

	it("writes are atomic: no .tmp left behind, and a .bak appears", async () => {
		const { backend } = await tmpLedger();
		const store = new AxonStore(backend);
		await store.mutate((l) => l.create({ title: "first" }));
		await store.mutate((l) => l.create({ title: "second" }));
		assert.ok(!(await exists(`${backend.location.ledgerPath}.tmp`)), "no leftover tmp");
		assert.ok(await exists(`${backend.location.ledgerPath}.bak`), ".bak created");
	});
});

describe("FileBackend — corruption recovery", () => {
	it("starts fresh from a corrupt ledger and backs it up", async () => {
		const { backend, dir } = await tmpLedger();
		// Write garbage directly.
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(backend.location.ledgerPath, "{ not valid json }}}", "utf8");

		const { ledger, warnings } = await backend.load();
		assert.equal(ledger.all().length, 0);
		assert.ok(warnings.length > 0);
		assert.match(warnings[0]!, /corrupt/i);

		// A .corrupt-<ts> backup exists.
		const entries = await fs.readdir(dir);
		assert.ok(entries.some((e) => e.startsWith("ledger.json.corrupt-")), "corrupt backup created");
	});

	it("recoverable: good .bak can be restored manually if needed", async () => {
		const { backend } = await tmpLedger();
		const store = new AxonStore(backend);
		await store.mutate((l) => l.create({ title: "first" }));
		await store.mutate((l) => l.create({ title: "second" }));
		await store.mutate((l) => l.create({ title: "precious" })); // third write -> .bak holds the 2-task snapshot

		// Corrupt the main file; .bak holds the previous good state (2 tasks).
		await fs.writeFile(backend.location.ledgerPath, "broken", "utf8");
		const bad = await backend.load();
		assert.equal(bad.ledger.all().length, 0);

		// Simulate restore from .bak.
		await fs.copyFile(`${backend.location.ledgerPath}.bak`, backend.location.ledgerPath);
		const restored = await backend.load();
		assert.equal(restored.ledger.all().length, 2);
		assert.ok(restored.ledger.get("task-002")?.title === "second");
	});
});

describe("withLock — cross-call serialization", () => {
	it("serializes two concurrent critical sections in-process", async () => {
		const { dir } = await tmpLedger();
		const lockPath = path.join(dir, "test.lock");
		let inside = 0;
		let maxConcurrent = 0;

		const work = async () => {
			await withLock(lockPath, async () => {
				inside++;
				maxConcurrent = Math.max(maxConcurrent, inside);
				await new Promise((r) => setTimeout(r, 20));
				inside--;
			});
		};
		await Promise.all([work(), work(), work()]);
		assert.equal(maxConcurrent, 1, "critical sections never overlapped");
		assert.ok(!(await exists(lockPath)), "lock removed after work");
	});

	it("releases the lock even if the critical section throws", async () => {
		const { dir } = await tmpLedger();
		const lockPath = path.join(dir, "throw.lock");
		await assert.rejects(
			() =>
				withLock(lockPath, async () => {
					throw new Error("boom");
				}),
			/boom/,
		);
		assert.ok(!(await exists(lockPath)), "lock removed after throw");
	});
});

describe("AxonStore — mutate/query", () => {
	it("mutate persists and query reads latest", async () => {
		const { store } = await tmpLedger();
		await store.mutate((l) => l.create({ title: "a" }));
		await store.mutate((l) => l.create({ title: "b" }));
		const { result } = await store.query((l) => l.summary().total);
		assert.equal(result, 2);
	});

	it("mutate that throws does not corrupt the ledger", async () => {
		const { store } = await tmpLedger();
		await store.mutate((l) => l.create({ title: "a" }));
		// An illegal transition throws inside the op; the ledger must remain valid.
		await assert.rejects(() => store.mutate((l) => l.setStatus("task-001", "completed")));
		// task-001 still exists and is intact.
		const { result } = await store.query((l) => l.get("task-001")?.status);
		assert.equal(result, "ready"); // created with no deps -> ready
	});
});

describe("AXON — real cross-process concurrency", () => {
	it("two child processes writing the same ledger do not lose updates", async () => {
		const { dir } = await tmpLedger();
		const ledgerPath = path.join(dir, "ledger.json");

		const runChild = (label: string) =>
			new Promise<void>((resolve, reject) => {
				const p = spawn(process.execPath, ["-e", childScript(ledgerPath, label)], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let err = "";
				p.stderr.on("data", (d) => (err += d.toString()));
				p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
			});

		await Promise.all([runChild("A"), runChild("B"), runChild("C")]);

		const backend = new FileBackend({ ledgerPath, dir });
		const { ledger } = await backend.load();
		const titles = ledger.all().map((t) => t.title).sort();
		assert.deepEqual(titles, ["from-A", "from-B", "from-C"]);
	}, 15000);
});

/** A self-contained Node script that creates one task on the shared ledger. */
function childScript(ledgerPath: string, label: string): string {
	// Inject params as JSON constants so the child body references locals, not
	// bare TS-parameter identifiers (which would be undefined at eval time).
	const header = `const LEDGER = ${JSON.stringify(ledgerPath)}; const LABEL = ${JSON.stringify(label)};`;
	const body = [
		'const fs = require("node:fs");',
		'(async () => {',
		'  const ledgerPath = LEDGER;',
		'  const lock = ledgerPath + ".lock";',
		'  const tmp = ledgerPath + ".tmp";',
		'  const bak = ledgerPath + ".bak";',
		'  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
		'  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH" && e.code !== "EINVAL"; } };',
		'  let attempts = 0;',
		'  for (;;) {',
		'    try {',
		'      const h = fs.openSync(lock, "wx"); fs.writeFileSync(h, JSON.stringify({ pid: process.pid, ts: Date.now() })); fs.closeSync(h);',
		'      try {',
		'        let data = { version: 1, updated_at: new Date().toISOString(), tasks: {} };',
		'        try { data = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        let max = 0; for (const id of Object.keys(data.tasks || {})) { const m = id.match(/^task-(\\d+)$/); if (m) max = Math.max(max, +m[1]); }',
		'        const nid = "task-" + String(max + 1).padStart(3, "0");',
		'        data.tasks[nid] = { id: nid, title: "from-" + LABEL, description: "", parent_id: null, dependencies: [], assigned_to: null, status: "ready", priority: "medium", progress_notes: [], artifacts: [], blockers: [], review_status: "not_reviewed", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };',
		'        try { fs.copyFileSync(ledgerPath, bak); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });',
		'        fs.renameSync(tmp, ledgerPath);',
		'      } finally { try { fs.unlinkSync(lock); } catch (e) {} }',
		'      return;',
		'    } catch (e) {',
		'      if (e.code !== "EEXIST") throw e;',
		'      attempts++;',
		'      if (attempts % 20 === 0) { try { const info = JSON.parse(fs.readFileSync(lock, "utf8")); if (!isAlive(info.pid) || Date.now() - info.ts > 30000) { try { fs.unlinkSync(lock); } catch (e) {} } } catch (e) { try { fs.unlinkSync(lock); } catch (e2) {} } }',
		'      if (attempts > 400) throw new Error("lock timeout");',
		'      await sleep(25);',
		'    }',
		'  }',
		'})();',
	].join("\n");
	return header + "\n" + body + "\n";
}
