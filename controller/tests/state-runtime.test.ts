import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	archiveNervousContext,
	assessNervousContextReset,
	formatNervousStateReport,
	inspectNervousContext,
	NERVOUS_ARCHIVE_MANIFEST,
} from "../extension/state-runtime.ts";

const ENV_KEYS = [
	"NERVOUS_STATE_ROOT", "NERVOUS_PROJECT", "NERVOUS_CONTEXT", "NERVOUS_ARCHIVE_RETENTION_DAYS",
	"CORTEX_PATH", "MAGI_HISTORY_PATH", "AXON_LEDGER_PATH", "SYNAPSE_PATH", "LION_RUNS_PATH", "CEREBEL_PATH", "GANGLION_PATH", "AMYGDALA_PATH",
	"SYNAPSE_TTL_MS", "SYNAPSE_MAX_NOTES",
] as const;

async function withRuntimeEnv<T>(patch: Record<string, string | undefined>, fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-state-runtime-"));
	const old = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of ENV_KEYS) delete process.env[key];
		Object.assign(process.env, { NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "project", NERVOUS_CONTEXT: "main" });
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		return await fn(root);
	} finally {
		for (const key of ENV_KEYS) {
			const value = old[key];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

describe("NERVous context state runtime", () => {
	it("explains durable lifetime, SYNAPSE TTL, view caps, and other contexts", async () => {
		await withRuntimeEnv({}, async (root) => {
			const contextDir = path.join(root, "project", "main");
			fs.mkdirSync(path.join(contextDir, "cortex"), { recursive: true });
			fs.mkdirSync(path.join(contextDir, "synapse"), { recursive: true });
			fs.mkdirSync(path.join(root, "project", "other-issue"), { recursive: true });
			fs.writeFileSync(path.join(contextDir, "cortex", "cortex.json"), JSON.stringify({ updated_at: "2026-07-16T00:00:00.000Z", goals: {
				"goal-001": { status: "completed" }, "goal-002": { status: "executing" },
			} }));
			fs.writeFileSync(path.join(contextDir, "synapse", "synapse.json"), JSON.stringify({ notes: [{ id: "note-001" }] }));

			const snapshot = await inspectNervousContext(root);
			assert.equal(snapshot.files.find((file) => file.component === "cortex")?.recordCount, 2);
			assert.equal(snapshot.files.find((file) => file.component === "cortex")?.openRecordCount, 1);
			assert.deepEqual(snapshot.otherContexts, ["other-issue"]);
			const report = formatNervousStateReport(snapshot);
			assert.match(report, /have no TTL and remain until the whole context is explicitly reset/);
			assert.match(report, /SYNAPSE is transient: 1d TTL, 1000 notes/);
			assert.match(report, /display up to 100 recent records; they do not delete/);
			assert.match(report, /CORTEX: 2 record\(s\), 1 open/);
		});
	});

	it("archives the whole raw context without parsing rejected component state and prunes expired reset archives", async () => {
		await withRuntimeEnv({}, async (root) => {
			const now = new Date("2026-07-16T12:00:00.000Z");
			const projectDir = path.join(root, "project");
			const contextDir = path.join(projectDir, "main");
			const rejected = JSON.stringify({ version: 1, waves: { "wave-001": { assignments: [{ id: "assign-001", lion_run_id: "run-001" }] } } });
			fs.mkdirSync(path.join(contextDir, "cerebel"), { recursive: true });
			fs.mkdirSync(path.join(contextDir, "lion", "runs.json.progress"), { recursive: true });
			fs.writeFileSync(path.join(contextDir, "cerebel", "cerebel.json"), rejected);
			fs.writeFileSync(path.join(contextDir, "cerebel", "cerebel.json.bak"), rejected);
			fs.writeFileSync(path.join(contextDir, "lion", "runs.json"), JSON.stringify({ runs: { "run-001": { id: "run-001", status: "completed" } } }));
			fs.writeFileSync(path.join(contextDir, "lion", "runs.json.progress", "orphan.json"), "progress");

			const oldArchive = path.join(projectDir, ".archive", "main-old");
			fs.mkdirSync(oldArchive, { recursive: true });
			fs.writeFileSync(path.join(oldArchive, NERVOUS_ARCHIVE_MANIFEST), JSON.stringify({
				version: 1, project: "project", context: "main", resetAt: "2026-06-01T00:00:00.000Z", originalPath: contextDir,
				artifactCount: 1, artifactBytes: 1, archiveRetentionDays: 30,
			}));

			const result = await archiveNervousContext(root, { now, sessionId: "session-001" });
			assert.equal(fs.existsSync(contextDir), false);
			assert.equal(fs.readFileSync(path.join(result.archivePath, "cerebel", "cerebel.json"), "utf8"), rejected);
			assert.equal(fs.existsSync(path.join(result.archivePath, "lion", "runs.json.progress", "orphan.json")), true);
			assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).sessionId, "session-001");
			assert.deepEqual(result.prunedArchivePaths, [oldArchive]);
			assert.equal(fs.existsSync(oldArchive), false);
			assert.equal((await inspectNervousContext(root)).files.some((file) => file.exists), false);
		});
	});

	it("requires force for active or unreadable LION state and never bypasses path overrides", async () => {
		await withRuntimeEnv({}, async (root) => {
			const lionPath = path.join(root, "project", "main", "lion", "runs.json");
			fs.mkdirSync(path.dirname(lionPath), { recursive: true });
			fs.writeFileSync(lionPath, JSON.stringify({ runs: { "run-live": { id: "run-live", status: "running" } } }));
			assert.deepEqual((await assessNervousContextReset(root)).activeLionRunIds, ["run-live"]);
			await assert.rejects(() => archiveNervousContext(root), /queued\/running LION records/);
			assert.equal(fs.existsSync(lionPath), true);
			assert.equal(fs.existsSync((await archiveNervousContext(root, { force: true })).archivePath), true);
		});

		await withRuntimeEnv({}, async (root) => {
			const lionPath = path.join(root, "project", "main", "lion", "runs.json");
			fs.mkdirSync(path.dirname(lionPath), { recursive: true });
			fs.writeFileSync(lionPath, "{bad-json");
			assert.equal((await assessNervousContextReset(root)).lionStateUnreadable, true);
			await assert.rejects(() => archiveNervousContext(root), /liveness cannot be classified/);
		});

		await withRuntimeEnv({}, async (root) => {
			const override = path.join(root, "tasks.json");
			fs.writeFileSync(override, JSON.stringify({ tasks: {} }));
			process.env.AXON_LEDGER_PATH = override;
			await assert.rejects(() => archiveNervousContext(root, { force: true }), /path overrides are active/);
			assert.equal(fs.existsSync(override), true);
		});
	});

	it("refuses to race a live component writer", async () => {
		await withRuntimeEnv({}, async (root) => {
			const componentDir = path.join(root, "project", "main", "axon");
			fs.mkdirSync(componentDir, { recursive: true });
			fs.writeFileSync(path.join(componentDir, "ledger.json"), JSON.stringify({ tasks: {} }));
			const lockPath = path.join(componentDir, "ledger.json.lock");
			fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
			assert.deepEqual((await assessNervousContextReset(root)).liveLockPaths, [lockPath]);
			await assert.rejects(() => archiveNervousContext(root, { force: true }), /live component writes/);
		});
	});
});
