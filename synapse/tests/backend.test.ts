import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import {
	FileBackend,
	resolveSynapseLocation,
	resolveStoreRetention,
	SynapseStore,
	withLock,
	DEFAULT_STORE_RETENTION,
} from "../extension/backend.ts";
import type { RetentionPolicy } from "../extension/store.ts";

async function tmpStore(retention?: RetentionPolicy): Promise<{ dir: string; backend: FileBackend; store: SynapseStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-test-"));
	const loc = { synapsePath: path.join(dir, "synapse.json"), dir };
	const backend = new FileBackend(loc);
	return { dir, backend, store: new SynapseStore(backend, retention ?? { ttl_ms: 0, max_notes: 0 }) };
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

describe("resolveSynapseLocation", () => {
	it("defaults to global project/context namespaced state", () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT;
		const oldProject = process.env.NERVOUS_PROJECT;
		const oldContext = process.env.NERVOUS_CONTEXT;
		process.env.NERVOUS_STATE_ROOT = "/tmp/nervous";
		process.env.NERVOUS_PROJECT = "proj";
		process.env.NERVOUS_CONTEXT = "work";
		try {
			const loc = resolveSynapseLocation("/tmp/proj");
			assert.equal(loc.synapsePath, path.join("/tmp/nervous", "proj", "work", "synapse", "synapse.json"));
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});
	it("respects SYNAPSE_PATH when absolute", () => {
		const old = process.env.SYNAPSE_PATH;
		process.env.SYNAPSE_PATH = "/custom/synapse.json";
		try {
			assert.equal(resolveSynapseLocation("/tmp/proj").synapsePath, "/custom/synapse.json");
		} finally {
			if (old === undefined) delete process.env.SYNAPSE_PATH;
			else process.env.SYNAPSE_PATH = old;
		}
	});
});

describe("resolveStoreRetention", () => {
	it("uses defaults when nothing overrides", () => {
		const oldTtl = process.env.SYNAPSE_TTL_MS;
		const oldMax = process.env.SYNAPSE_MAX_NOTES;
		delete process.env.SYNAPSE_TTL_MS;
		delete process.env.SYNAPSE_MAX_NOTES;
		try {
			const r = resolveStoreRetention("/x");
			assert.equal(r.ttl_ms, DEFAULT_STORE_RETENTION.ttl_ms);
			assert.equal(r.max_notes, DEFAULT_STORE_RETENTION.max_notes);
		} finally {
			if (oldTtl !== undefined) process.env.SYNAPSE_TTL_MS = oldTtl;
			if (oldMax !== undefined) process.env.SYNAPSE_MAX_NOTES = oldMax;
		}
	});
	it("respects env overrides", () => {
		const oldTtl = process.env.SYNAPSE_TTL_MS;
		const oldMax = process.env.SYNAPSE_MAX_NOTES;
		process.env.SYNAPSE_TTL_MS = "1000";
		process.env.SYNAPSE_MAX_NOTES = "5";
		try {
			const r = resolveStoreRetention("/x");
			assert.equal(r.ttl_ms, 1000);
			assert.equal(r.max_notes, 5);
		} finally {
			if (oldTtl === undefined) delete process.env.SYNAPSE_TTL_MS;
			else process.env.SYNAPSE_TTL_MS = oldTtl;
			if (oldMax === undefined) delete process.env.SYNAPSE_MAX_NOTES;
			else process.env.SYNAPSE_MAX_NOTES = oldMax;
		}
	});
});

describe("FileBackend — load/save", () => {
	it("load on missing file returns a fresh empty log", async () => {
		const { backend } = await tmpStore();
		const { log, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(log.all().length, 0);
	});

	it("round-trips notes through disk", async () => {
		const { dir } = await tmpStore();
		const store = new SynapseStore(new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }));
		await store.mutate((log) => log.post({ message: "persisted", agent_id: "lion-1", type: "started" }));

		const store2 = new SynapseStore(new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }));
		const { result } = await store2.query((log) => log.get("note-001"));
		assert.equal(result?.message, "persisted");
		assert.equal(result?.agent_id, "lion-1");
	});

	it("atomic write: no .tmp left; .bak appears after 2 saves", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((log) => log.post({ message: "first" }));
		await store.mutate((log) => log.post({ message: "second" }));
		assert.ok(!(await exists(`${backend.location.synapsePath}.tmp`)));
		assert.ok(await exists(`${backend.location.synapsePath}.bak`));
	});

	it("recovers from a corrupt file by starting fresh + backing it up", async () => {
		const { backend, dir } = await tmpStore();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(backend.location.synapsePath, "{ broken json }}}", "utf8");
		const { log, warnings } = await backend.load();
		assert.equal(log.all().length, 0);
		assert.ok(warnings.length > 0);
		const entries = await fs.readdir(dir);
		assert.ok(entries.some((e) => e.startsWith("synapse.json.corrupt-")));
	});
});

describe("SynapseStore — retention applied on save", () => {
	it("applies ttl pruning on every mutate save", async () => {
		const { dir } = await tmpStore();
		const store = new SynapseStore(
			new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }),
			{ ttl_ms: 10, max_notes: 0 },
		);
		await store.mutate((log) => {
			log.post({ message: "old" });
			log.notes[0]!.created_at = new Date(Date.now() - 1000).toISOString();
		});
		// A second mutate reloads (old note still present on disk since prior save pruned it already),
		// then posts a new note and prunes again.
		await store.mutate((log) => log.post({ message: "new" }));
		const { result } = await store.query((log) => log.all().map((n) => n.message));
		assert.deepEqual(result, ["new"]);
	});

	it("applies max-notes cap on save", async () => {
		const { dir } = await tmpStore();
		const store = new SynapseStore(
			new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }),
			{ ttl_ms: 0, max_notes: 2 },
		);
		await store.mutate((log) => log.post({ message: "1" }));
		await store.mutate((log) => log.post({ message: "2" }));
		const { pruned } = await store.mutate((log) => log.post({ message: "3" }));
		assert.ok(pruned >= 1);
		const { result: total } = await store.query((log) => log.all().length);
		assert.equal(total, 2);
	});

	it("pruneOnly forces pruning against the active retention", async () => {
		const { dir } = await tmpStore();
		// First, persist notes with NO retention (ttl=0, max=0) so they survive.
		const raw = new SynapseStore(
			new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }),
			{ ttl_ms: 0, max_notes: 0 },
		);
		await raw.mutate((log) => {
			log.post({ message: "old" });
			log.notes[0]!.created_at = new Date(Date.now() - 120_000).toISOString();
			log.post({ message: "new" });
		});
		// Then a store WITH retention prunes the stale note on demand. Keep a wide
		// timing margin so parallel suite load cannot age the fresh note out too.
		const store = new SynapseStore(
			new FileBackend({ synapsePath: path.join(dir, "synapse.json"), dir }),
			{ ttl_ms: 60_000, max_notes: 0 },
		);
		const { pruned } = await store.pruneOnly();
		assert.equal(pruned, 1);
		const { result: msgs } = await store.query((log) => log.all().map((n) => n.message));
		assert.deepEqual(msgs, ["new"]);
	});
});

describe("withLock — serialization", () => {
	it("serializes concurrent critical sections", async () => {
		const { dir } = await tmpStore();
		const lockPath = path.join(dir, "test.lock");
		let inside = 0;
		let maxConcurrent = 0;
		const work = async () =>
			withLock(lockPath, async () => {
				inside++;
				maxConcurrent = Math.max(maxConcurrent, inside);
				await new Promise((r) => setTimeout(r, 20));
				inside--;
			});
		await Promise.all([work(), work(), work()]);
		assert.equal(maxConcurrent, 1);
		assert.ok(!(await exists(lockPath)));
	});
});

describe("SYNAPSE — real cross-process concurrency", () => {
	it("three child processes appending notes lose none", async () => {
		const { dir } = await tmpStore();
		const synapsePath = path.join(dir, "synapse.json");

		const runChild = (label: string) =>
			new Promise<void>((resolve, reject) => {
				const p = spawn(process.execPath, ["-e", childScript(synapsePath, label)], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let err = "";
				p.stderr.on("data", (d) => (err += d.toString()));
				p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
			});

		await Promise.all([runChild("A"), runChild("B"), runChild("C")]);

		const backend = new FileBackend({ synapsePath, dir });
		const { log } = await backend.load({ ttl_ms: 0, max_notes: 0 });
		const msgs = log.all().map((n) => n.message).sort();
		assert.deepEqual(msgs, ["from-A", "from-B", "from-C"]);
	}, 15000);
});

/** A self-contained Node script that appends one note to the shared scratchpad. */
function childScript(synapsePath: string, label: string): string {
	const header = `const SYNAPSE = ${JSON.stringify(synapsePath)}; const LABEL = ${JSON.stringify(label)};`;
	const body = [
		'const fs = require("node:fs");',
		'(async () => {',
		'  const synapsePath = SYNAPSE;',
		'  const lock = synapsePath + ".lock";',
		'  const tmp = synapsePath + ".tmp";',
		'  const bak = synapsePath + ".bak";',
		'  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
		'  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH" && e.code !== "EINVAL"; } };',
		'  let attempts = 0;',
		'  for (;;) {',
		'    try {',
		'      const h = fs.openSync(lock, "wx"); fs.writeFileSync(h, JSON.stringify({ pid: process.pid, ts: Date.now() })); fs.closeSync(h);',
		'      try {',
		'        let data = { version: 1, updated_at: new Date().toISOString(), retention: { ttl_ms: 0, max_notes: 0 }, notes: [] };',
		'        try { data = JSON.parse(fs.readFileSync(synapsePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        let max = 0; for (const n of data.notes || []) { const m = n.id.match(/^note-(\\d+)$/); if (m) max = Math.max(max, +m[1]); }',
		'        const nid = "note-" + String(max + 1).padStart(3, "0");',
		'        data.notes.push({ id: nid, task_id: null, agent_id: LABEL, type: "info", message: "from-" + LABEL, created_at: new Date().toISOString() });',
		'        data.updated_at = new Date().toISOString();',
		'        try { fs.copyFileSync(synapsePath, bak); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });',
		'        fs.renameSync(tmp, synapsePath);',
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
