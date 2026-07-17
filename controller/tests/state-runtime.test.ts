import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { AxonStore, FileBackend as AxonBackend } from "../../axon/extension/backend.ts";
import {
	archiveNervousContext,
	assessNervousContextReset,
	formatNervousStateReport,
	inspectNervousContext,
	NERVOUS_ARCHIVE_MANIFEST,
	pruneNervousArchives,
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

function writeArchive(projectDir: string, name: string, manifest: Record<string, unknown>): string {
	const archivePath = path.join(projectDir, ".archive", name);
	fs.mkdirSync(archivePath, { recursive: true });
	fs.writeFileSync(`${archivePath}${NERVOUS_ARCHIVE_MANIFEST}`, JSON.stringify(manifest));
	return archivePath;
}

function manifestFor(contextDir: string, resetAt: string, retention: number): Record<string, unknown> {
	return {
		version: 1, project: "project", context: "main", resetAt, originalPath: contextDir,
		artifactCount: 1, artifactBytes: 1, archiveRetentionDays: retention,
	};
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

	it("archives raw rejected state with trusted sibling metadata and prunes an expired archive", async () => {
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
			fs.writeFileSync(path.join(contextDir, NERVOUS_ARCHIVE_MANIFEST), JSON.stringify(manifestFor(contextDir, "2000-01-01T00:00:00.000Z", 1)));

			const oldArchive = writeArchive(projectDir, "main-old", manifestFor(contextDir, "2026-06-01T00:00:00.000Z", 30));
			const result = await archiveNervousContext(root, { now, sessionId: "session-001" });
			assert.equal(fs.existsSync(contextDir), false);
			assert.equal(fs.readFileSync(path.join(result.archivePath, "cerebel", "cerebel.json"), "utf8"), rejected);
			assert.equal(fs.existsSync(path.join(result.archivePath, NERVOUS_ARCHIVE_MANIFEST)), true, "raw preexisting manifest remains untrusted data");
			assert.equal(path.dirname(result.manifestPath), path.dirname(result.archivePath), "trusted manifest is outside raw archive");
			assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).sessionId, "session-001");
			assert.deepEqual(result.prunedArchivePaths, [oldArchive]);
			assert.equal(fs.existsSync(`${oldArchive}${NERVOUS_ARCHIVE_MANIFEST}`), false);
			assert.equal((await inspectNervousContext(root)).files.some((file) => file.exists), false);
		});
	});

	it("honors each archive's recorded retention regardless of the current environment", async () => {
		await withRuntimeEnv({ NERVOUS_ARCHIVE_RETENTION_DAYS: "1" }, async (root) => {
			const projectDir = path.join(root, "project");
			const contextDir = path.join(projectDir, "main");
			const indefinite = writeArchive(projectDir, "indefinite", manifestFor(contextDir, "2020-01-01T00:00:00.000Z", 0));
			const long = writeArchive(projectDir, "long", manifestFor(contextDir, "2026-06-01T00:00:00.000Z", 90));
			const elapsed = writeArchive(projectDir, "elapsed", manifestFor(contextDir, "2026-06-01T00:00:00.000Z", 10));
			const removed = await pruneNervousArchives(root, { now: new Date("2026-07-16T00:00:00.000Z") });
			assert.deepEqual(removed, [elapsed]);
			assert.equal(fs.existsSync(indefinite), true);
			assert.equal(fs.existsSync(long), true);
		});
	});

	it("pins the confirmed namespace before acquiring or renaming state", async () => {
		await withRuntimeEnv({}, async (root) => {
			const mainFile = path.join(root, "project", "main", "axon", "ledger.json");
			fs.mkdirSync(path.dirname(mainFile), { recursive: true });
			fs.writeFileSync(mainFile, JSON.stringify({ tasks: {} }));
			const confirmed = (await assessNervousContextReset(root)).snapshot;
			process.env.NERVOUS_CONTEXT = "other";
			const otherFile = path.join(root, "project", "other", "axon", "ledger.json");
			fs.mkdirSync(path.dirname(otherFile), { recursive: true });
			fs.writeFileSync(otherFile, JSON.stringify({ tasks: {} }));
			await assert.rejects(() => archiveNervousContext(root, { expectedNamespace: confirmed }), /namespace changed after confirmation/);
			assert.equal(fs.existsSync(mainFile), true);
			assert.equal(fs.existsSync(otherFile), true);
		});
	});

	it("requires force for active, malformed, or unknown-status LION state", async () => {
		await withRuntimeEnv({}, async (root) => {
			const lionPath = path.join(root, "project", "main", "lion", "runs.json");
			fs.mkdirSync(path.dirname(lionPath), { recursive: true });
			fs.writeFileSync(lionPath, JSON.stringify({ runs: { "run-live": { id: "run-live", status: "running" } } }));
			assert.deepEqual((await assessNervousContextReset(root)).activeLionRunIds, ["run-live"]);
			await assert.rejects(() => archiveNervousContext(root), /queued\/running LION records/);
		});
		for (const runs of [{ "run-bad": { id: "run-bad" } }, { "run-bad": { id: "run-bad", status: "mystery" } }, { "run-bad": "not-an-object" }]) {
			await withRuntimeEnv({}, async (root) => {
				const lionPath = path.join(root, "project", "main", "lion", "runs.json");
				fs.mkdirSync(path.dirname(lionPath), { recursive: true });
				fs.writeFileSync(lionPath, JSON.stringify({ runs }));
				assert.equal((await assessNervousContextReset(root)).lionStateUnreadable, true);
				await assert.rejects(() => archiveNervousContext(root), /schema-invalid/);
				assert.equal(fs.existsSync((await archiveNervousContext(root, { force: true })).archivePath), true);
			});
		}
	});

	it("does not parse non-LION ledgers during reset assessment", async () => {
		await withRuntimeEnv({}, async (root) => {
			const cortexPath = path.join(root, "project", "main", "cortex", "cortex.json");
			fs.mkdirSync(path.dirname(cortexPath), { recursive: true });
			fs.writeFileSync(cortexPath, "{large-or-malformed-raw-state");
			const assessment = await assessNervousContextReset(root);
			assert.deepEqual(assessment.inspectionErrors, []);
			const result = await archiveNervousContext(root);
			assert.equal(fs.readFileSync(path.join(result.archivePath, "cortex", "cortex.json"), "utf8"), "{large-or-malformed-raw-state");
		});
	});

	it("rejects explicit and symlink-backed state paths", async () => {
		await withRuntimeEnv({}, async (root) => {
			const override = path.join(root, "tasks.json");
			fs.writeFileSync(override, JSON.stringify({ tasks: {} }));
			process.env.AXON_LEDGER_PATH = override;
			await assert.rejects(() => archiveNervousContext(root, { force: true }), /escape the namespace/);
			assert.equal(fs.existsSync(override), true);
		});
		await withRuntimeEnv({}, async (root) => {
			const external = path.join(root, "external-runs.json");
			fs.writeFileSync(external, JSON.stringify({ runs: {} }));
			const lionPath = path.join(root, "project", "main", "lion", "runs.json");
			fs.mkdirSync(path.dirname(lionPath), { recursive: true });
			fs.symlinkSync(external, lionPath);
			const assessment = await assessNervousContextReset(root);
			assert.match(assessment.overridePaths.join(" "), /symlink/);
			await assert.rejects(() => archiveNervousContext(root, { force: true }), /escape the namespace/);
			assert.equal(fs.existsSync(external), true);
		});
		await withRuntimeEnv({}, async (root) => {
			const externalContext = path.join(root, "external-context");
			fs.mkdirSync(path.join(externalContext, "axon"), { recursive: true });
			fs.writeFileSync(path.join(externalContext, "axon", "ledger.json"), JSON.stringify({ tasks: {} }));
			fs.mkdirSync(path.join(root, "project"), { recursive: true });
			fs.symlinkSync(externalContext, path.join(root, "project", "main"), "dir");
			await assert.rejects(() => archiveNervousContext(root, { force: true }), /escape the namespace/);
			assert.equal(fs.existsSync(path.join(externalContext, "axon", "ledger.json")), true);
		});
	});

	it("coordinates reset with an in-flight component transaction", async () => {
		await withRuntimeEnv({}, async (root) => {
			const ledgerPath = path.join(root, "project", "main", "axon", "ledger.json");
			const backend = new AxonBackend({ ledgerPath, dir: path.dirname(ledgerPath) });
			const store = new AxonStore(backend);
			const rawBackend = backend as any;
			const saveUnlocked = rawBackend.saveUnlocked.bind(backend);
			let releaseSave!: () => void;
			const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
			let saving!: () => void;
			const savingStarted = new Promise<void>((resolve) => { saving = resolve; });
			rawBackend.saveUnlocked = async (ledger: unknown) => { saving(); await saveGate; return saveUnlocked(ledger); };
			const writer = store.mutate((ledger) => ledger.create({ title: "committed before reset" }));
			await savingStarted;
			let resetSettled = false;
			const reset = archiveNervousContext(root).finally(() => { resetSettled = true; });
			await delay(75);
			assert.equal(resetSettled, false, "reset waits for the writer's complete transaction");
			releaseSave();
			await writer;
			const result = await reset;
			const archived = JSON.parse(fs.readFileSync(path.join(result.archivePath, "axon", "ledger.json"), "utf8"));
			assert.equal(archived.tasks["task-001"].title, "committed before reset");
			assert.equal(fs.existsSync(path.join(root, "project", "main")), false);
		});
	});

	it("streams a high-cardinality artifact inventory and surfaces directory failures", async () => {
		await withRuntimeEnv({}, async (root) => {
			const sidecars = path.join(root, "project", "main", "lion", "runs.json.progress");
			fs.mkdirSync(sidecars, { recursive: true });
			for (let index = 0; index < 500; index++) fs.writeFileSync(path.join(sidecars, `${index}.json`), "x");
			assert.equal((await assessNervousContextReset(root)).artifactCount, 500);
		});
		await withRuntimeEnv({}, async (root) => {
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, "project"), "not-a-directory");
			await assert.rejects(() => inspectNervousContext(root), /ENOTDIR/);
		});
	});
});
