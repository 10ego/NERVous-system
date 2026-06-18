import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { CortexStore, FileBackend, resolveCortexLocation, withLock } from "../extension/backend.ts";

async function tmpStore(): Promise<{ dir: string; backend: FileBackend; store: CortexStore }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-test-"));
	const loc = { cortexPath: path.join(dir, "cortex.json"), dir };
	const backend = new FileBackend(loc);
	return { dir, backend, store: new CortexStore(backend) };
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

describe("resolveCortexLocation", () => {
	it("defaults to global project/context namespaced state", () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		process.env.NERVOUS_STATE_ROOT = "/tmp/nervous"; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "work";
		try { assert.equal(resolveCortexLocation("/tmp/proj").cortexPath, path.join("/tmp/nervous", "proj", "work", "cortex", "cortex.json")); }
		finally { if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot; if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject; if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext; }
	});
	it("respects CORTEX_PATH when absolute", () => {
		const old = process.env.CORTEX_PATH;
		process.env.CORTEX_PATH = "/custom/cortex.json";
		try {
			assert.equal(resolveCortexLocation("/tmp/proj").cortexPath, "/custom/cortex.json");
		} finally {
			if (old === undefined) delete process.env.CORTEX_PATH;
			else process.env.CORTEX_PATH = old;
		}
	});
});

describe("FileBackend — load/save", () => {
	it("load on missing file returns a fresh empty store", async () => {
		const { backend } = await tmpStore();
		const { store, fresh } = await backend.load();
		assert.equal(fresh, true);
		assert.equal(store.all().length, 0);
	});

	it("round-trips goals through disk", async () => {
		const { dir } = await tmpStore();
		const s1 = new CortexStore(new FileBackend({ cortexPath: path.join(dir, "cortex.json"), dir }));
		await s1.mutate((s) => s.analyze({ prompt: "persisted", goal: "ship it" }));
		const s2 = new CortexStore(new FileBackend({ cortexPath: path.join(dir, "cortex.json"), dir }));
		const { result } = await s2.query((s) => s.current());
		assert.equal(result?.intent.goal, "ship it");
	});

	it("atomic write: no .tmp left; .bak appears after 2 saves", async () => {
		const { backend, store } = await tmpStore();
		await store.mutate((s) => s.analyze({ prompt: "a" }));
		await store.mutate((s) => s.analyze({ prompt: "b" }));
		assert.ok(!(await exists(`${backend.location.cortexPath}.tmp`)));
		assert.ok(await exists(`${backend.location.cortexPath}.bak`));
	});

	it("recovers from a corrupt file by starting fresh + backing it up", async () => {
		const { backend, dir } = await tmpStore();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(backend.location.cortexPath, "{ broken }}}", "utf8");
		const { store, warnings } = await backend.load();
		assert.equal(store.all().length, 0);
		assert.ok(warnings.length > 0);
		const entries = await fs.readdir(dir);
		assert.ok(entries.some((e) => e.startsWith("cortex.json.corrupt-")));
	});
});

describe("CortexStore — mutate/query", () => {
	it("mutate persists and query reads latest", async () => {
		const { store } = await tmpStore();
		await store.mutate((s) => s.analyze({ prompt: "a" }));
		const { result } = await store.query((s) => s.all().length);
		assert.equal(result, 1);
	});

	it("a throwing mutate does not corrupt state", async () => {
		const { store } = await tmpStore();
		const g = await store.mutate((s) => s.analyze({ prompt: "a" }));
		// illegal: complete before verify
		await assert.rejects(() => store.mutate((s) => s.complete(g.result.id)));
		const { result } = await store.query((s) => s.get(g.result.id)?.status);
		assert.equal(result, "analyzed"); // unchanged
	});
});

describe("withLock — serialization", () => {
	it("serializes concurrent critical sections and cleans up", async () => {
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

describe("CORTEX — real cross-process concurrency", () => {
	it("three child processes creating goals lose none", async () => {
		const { dir } = await tmpStore();
		const cortexPath = path.join(dir, "cortex.json");

		const runChild = (label: string) =>
			new Promise<void>((resolve, reject) => {
				const p = spawn(process.execPath, ["-e", childScript(cortexPath, label)], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let err = "";
				p.stderr.on("data", (d) => (err += d.toString()));
				p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
			});

		await Promise.all([runChild("A"), runChild("B"), runChild("C")]);

		const backend = new FileBackend({ cortexPath, dir });
		const { store } = await backend.load();
		const goals = store.all().map((g) => g.prompt).sort();
		assert.deepEqual(goals, ["goal-A", "goal-B", "goal-C"]);
	}, 15000);
});

function childScript(cortexPath: string, label: string): string {
	const header = `const CORTEX = ${JSON.stringify(cortexPath)}; const LABEL = ${JSON.stringify(label)};`;
	const body = [
		'const fs = require("node:fs");',
		'(async () => {',
		'  const cortexPath = CORTEX;',
		'  const lock = cortexPath + ".lock";',
		'  const tmp = cortexPath + ".tmp";',
		'  const bak = cortexPath + ".bak";',
		'  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
		'  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH" && e.code !== "EINVAL"; } };',
		'  let attempts = 0;',
		'  for (;;) {',
		'    try {',
		'      const h = fs.openSync(lock, "wx"); fs.writeFileSync(h, JSON.stringify({ pid: process.pid, ts: Date.now() })); fs.closeSync(h);',
		'      try {',
		'        let data = { version: 1, updated_at: new Date().toISOString(), goals: {} };',
		'        try { data = JSON.parse(fs.readFileSync(cortexPath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        let max = 0; for (const id of Object.keys(data.goals || {})) { const m = id.match(/^goal-(\\d+)$/); if (m) max = Math.max(max, +m[1]); }',
		'        const nid = "goal-" + String(max + 1).padStart(3, "0");',
		'        const ts = new Date().toISOString();',
		'        data.goals[nid] = { id: nid, prompt: "goal-" + LABEL, status: "analyzed", intent: { intent_summary: "goal-" + LABEL, goal: "goal-" + LABEL, success_criteria: [], constraints: [], risks: [], expected_output: "", complexity: "medium", needs_magi: false }, axon_task_ids: [], created_at: ts, updated_at: ts };',
		'        data.updated_at = ts;',
		'        try { fs.copyFileSync(cortexPath, bak); } catch (e) { if (e.code !== "ENOENT") throw e; }',
		'        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });',
		'        fs.renameSync(tmp, cortexPath);',
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
