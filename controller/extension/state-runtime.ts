import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveContextSlug, resolveNervousStateFile, resolveProjectSlug, resolveRoot } from "@nervous-system/state";

const CONTEXT_RESET_LOCK_STALE_MS = 30_000;
export const NERVOUS_DASHBOARD_RECORD_LIMIT = 100;
export const NERVOUS_DEFAULT_SYNAPSE_TTL_MS = 24 * 60 * 60 * 1000;
export const NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES = 1000;
export const NERVOUS_DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
export const NERVOUS_ARCHIVE_MANIFEST = ".nervous-archive.json";

export const NERVOUS_STATE_COMPONENTS = [
	{ component: "cortex", filename: "cortex.json", env: "CORTEX_PATH", collection: "goals", terminal: ["completed", "cancelled"] },
	{ component: "magi", filename: "history.json", env: "MAGI_HISTORY_PATH", collection: "records", terminal: [] },
	{ component: "axon", filename: "ledger.json", env: "AXON_LEDGER_PATH", collection: "tasks", terminal: ["completed", "failed", "cancelled"] },
	{ component: "synapse", filename: "synapse.json", env: "SYNAPSE_PATH", collection: "notes", terminal: [] },
	{ component: "lion", filename: "runs.json", env: "LION_RUNS_PATH", collection: "runs", terminal: ["completed", "blocked", "failed", "aborted"] },
	{ component: "cerebel", filename: "cerebel.json", env: "CEREBEL_PATH", collection: "waves", terminal: ["completed", "cancelled"] },
	{ component: "ganglion", filename: "ganglion.json", env: "GANGLION_PATH", collection: "ganglions", terminal: ["completed", "cancelled"] },
	{ component: "amygdala", filename: "amygdala.json", env: "AMYGDALA_PATH", collection: "incidents", terminal: ["resolved", "accepted"] },
] as const;

export type NervousStateComponent = (typeof NERVOUS_STATE_COMPONENTS)[number]["component"];

export interface NervousStateFileSnapshot {
	component: NervousStateComponent;
	filePath: string;
	source: "namespace" | "override";
	exists: boolean;
	bytes: number;
	updatedAt?: string;
	recordCount?: number;
	openRecordCount?: number;
	parseError?: string;
}

export interface NervousContextSnapshot {
	root: string;
	project: string;
	context: string;
	projectDir: string;
	contextDir: string;
	files: NervousStateFileSnapshot[];
	totalBytes: number;
	otherContexts: string[];
	archiveCount: number;
	archiveRetentionDays: number;
	synapseRetention: { ttlMs: number; maxNotes: number };
}

export interface NervousResetAssessment {
	snapshot: NervousContextSnapshot;
	artifactCount: number;
	artifactBytes: number;
	overridePaths: string[];
	liveLockPaths: string[];
	activeLionRunIds: string[];
	lionStateUnreadable: boolean;
}

export interface NervousResetResult {
	archivePath: string;
	manifestPath: string;
	prunedArchivePaths: string[];
	warnings: string[];
	assessment: NervousResetAssessment;
}

export interface NervousArchiveManifest {
	version: 1;
	project: string;
	context: string;
	resetAt: string;
	originalPath: string;
	artifactCount: number;
	artifactBytes: number;
	archiveRetentionDays: number;
	sessionId?: string;
}

/** Read-only raw inventory; component stores remain their own semantic validators. */
export async function inspectNervousContext(cwd: string): Promise<NervousContextSnapshot> {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const context = resolveContextSlug(cwd);
	const projectDir = path.join(root, project);
	const contextDir = path.join(projectDir, context);
	const files = await Promise.all(NERVOUS_STATE_COMPONENTS.map((definition) => inspectStateFile(cwd, definition)));
	const entries = await readDirectoryNames(projectDir);
	const otherContexts = entries.filter((entry) => entry !== context && entry !== ".archive").sort();
	const archives = await readDirectoryNames(path.join(projectDir, ".archive"));
	return {
		root,
		project,
		context,
		projectDir,
		contextDir,
		files,
		totalBytes: files.reduce((total, file) => total + file.bytes, 0),
		otherContexts,
		archiveCount: archives.length,
		archiveRetentionDays: resolveNervousArchiveRetentionDays(),
		synapseRetention: {
			ttlMs: nonNegativeEnvNumber("SYNAPSE_TTL_MS", NERVOUS_DEFAULT_SYNAPSE_TTL_MS),
			maxNotes: nonNegativeEnvNumber("SYNAPSE_MAX_NOTES", NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES),
		},
	};
}

export function formatNervousStateReport(snapshot: NervousContextSnapshot): string {
	const ttl = snapshot.synapseRetention.ttlMs === 0 ? "no TTL" : formatDuration(snapshot.synapseRetention.ttlMs);
	const cap = snapshot.synapseRetention.maxNotes === 0 ? "no count cap" : `${snapshot.synapseRetention.maxNotes} notes`;
	const lines = [
		"# NERVous state",
		`- Namespace: \`${snapshot.project}/${snapshot.context}\``,
		`- Active directory: \`${snapshot.contextDir}\``,
		`- Canonical state size: ${formatBytes(snapshot.totalBytes)}`,
		"",
		"## Retention",
		"- CORTEX, MAGI, AXON, LION, CEREBEL, GANGLION, and AMYGDALA are durable: they have no TTL and remain until the whole context is explicitly reset.",
		`- SYNAPSE is transient: ${ttl}, ${cap}; expiry is applied on its next mutation or explicit prune.`,
		`- Dashboard/list limits only display up to ${NERVOUS_DASHBOARD_RECORD_LIMIT} recent records; they do not delete stored data.`,
		snapshot.archiveRetentionDays === 0
			? "- Reset archives do not expire automatically."
			: `- Reset archives are retained for at least ${snapshot.archiveRetentionDays}d, then pruned during a later reset.`,
		"",
		"## Active files",
	];
	for (const file of snapshot.files) {
		if (!file.exists) {
			lines.push(`- ${file.component.toUpperCase()}: empty (${file.source})`);
			continue;
		}
		const records = file.recordCount === undefined ? "records unknown" : `${file.recordCount} record(s)`;
		const open = file.openRecordCount === undefined ? "" : `, ${file.openRecordCount} open`;
		const invalid = file.parseError ? `, unreadable JSON: ${file.parseError}` : "";
		const location = file.source === "override" ? `override \`${file.filePath}\`` : "namespace";
		lines.push(`- ${file.component.toUpperCase()}: ${records}${open}, ${formatBytes(file.bytes)}, ${location}${file.updatedAt ? `, updated ${file.updatedAt}` : ""}${invalid}`);
	}
	lines.push(
		"",
		`Other work contexts: ${snapshot.otherContexts.length}${snapshot.otherContexts.length ? ` (${snapshot.otherContexts.join(", ")})` : ""}.`,
		`Reset archives: ${snapshot.archiveCount}.`,
		"Use a distinct `NERVOUS_CONTEXT` for concurrently resumable work. Use `/nervous:reset` when this namespace should start clean.",
	);
	return lines.join("\n");
}

export function resolveNervousArchiveRetentionDays(): number {
	return Math.floor(nonNegativeEnvNumber("NERVOUS_ARCHIVE_RETENTION_DAYS", NERVOUS_DEFAULT_ARCHIVE_RETENTION_DAYS));
}

/** Inspect raw artifacts without requiring any component ledger to validate. */
export async function assessNervousContextReset(cwd: string): Promise<NervousResetAssessment> {
	const snapshot = await inspectNervousContext(cwd);
	const artifacts = await inspectArtifacts(snapshot.contextDir);
	const lion = snapshot.files.find((file) => file.component === "lion");
	const lionActivity = lion?.exists && !lion.parseError ? await readActiveLionRunIds(lion.filePath) : { ids: [], unreadable: false };
	return {
		snapshot,
		artifactCount: artifacts.count,
		artifactBytes: artifacts.bytes,
		overridePaths: snapshot.files.filter((file) => file.source === "override").map((file) => `${file.component}:${file.filePath}`),
		liveLockPaths: await findLiveLocks(snapshot.contextDir),
		activeLionRunIds: lionActivity.ids,
		lionStateUnreadable: Boolean(lion?.exists && lion.parseError) || lionActivity.unreadable,
	};
}

/** Archive the complete context without migration or partial record deletion. */
export async function archiveNervousContext(
	cwd: string,
	options: { force?: boolean; now?: Date; sessionId?: string } = {},
): Promise<NervousResetResult> {
	const initial = await assessNervousContextReset(cwd);
	return withContextResetLock(initial.snapshot.projectDir, initial.snapshot.context, async () => {
		const assessment = await assessNervousContextReset(cwd);
		assertResetAllowed(assessment, Boolean(options.force));
		if (assessment.artifactCount === 0) throw new Error(`NERVous context ${assessment.snapshot.project}/${assessment.snapshot.context} is already empty`);

		const resetAt = (options.now ?? new Date()).toISOString();
		const archiveRoot = path.join(assessment.snapshot.projectDir, ".archive");
		const archiveName = `${assessment.snapshot.context}-${resetAt.replace(/[^0-9TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
		const archivePath = path.join(archiveRoot, archiveName);
		await fs.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
		await fs.rename(assessment.snapshot.contextDir, archivePath);

		const manifest: NervousArchiveManifest = {
			version: 1,
			project: assessment.snapshot.project,
			context: assessment.snapshot.context,
			resetAt,
			originalPath: assessment.snapshot.contextDir,
			artifactCount: assessment.artifactCount,
			artifactBytes: assessment.artifactBytes,
			archiveRetentionDays: assessment.snapshot.archiveRetentionDays,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
		};
		const manifestPath = path.join(archivePath, NERVOUS_ARCHIVE_MANIFEST);
		const warnings: string[] = [];
		try { await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
		catch (error) { warnings.push(`context was archived, but reset metadata could not be written: ${boundedError(error)}`); }
		let prunedArchivePaths: string[] = [];
		try { prunedArchivePaths = await pruneNervousArchives(cwd, { now: options.now, exclude: new Set([archivePath]) }); }
		catch (error) { warnings.push(`context was archived, but expired archives could not be pruned: ${boundedError(error)}`); }
		return { archivePath, manifestPath, prunedArchivePaths, warnings, assessment };
	});
}

/** Delete only valid reset archives older than current retention. */
export async function pruneNervousArchives(
	cwd: string,
	options: { now?: Date; exclude?: ReadonlySet<string> } = {},
): Promise<string[]> {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const archiveRoot = path.join(root, project, ".archive");
	const retentionDays = resolveNervousArchiveRetentionDays();
	if (retentionDays === 0) return [];
	const cutoff = (options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000;
	let entries;
	try { entries = await fs.readdir(archiveRoot, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const removed: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const archivePath = path.join(archiveRoot, entry.name);
		if (options.exclude?.has(archivePath)) continue;
		const manifest = await readArchiveManifest(path.join(archivePath, NERVOUS_ARCHIVE_MANIFEST));
		if (!manifest || manifest.project !== project || Date.parse(manifest.resetAt) > cutoff) continue;
		await fs.rm(archivePath, { recursive: true, force: true });
		removed.push(archivePath);
	}
	return removed;
}

async function inspectStateFile(
	cwd: string,
	definition: (typeof NERVOUS_STATE_COMPONENTS)[number],
): Promise<NervousStateFileSnapshot> {
	const override = process.env[definition.env];
	const filePath = resolveNervousStateFile(cwd, definition.component, definition.filename, definition.env);
	const source = override && path.isAbsolute(override) ? "override" as const : "namespace" as const;
	let stat;
	try { stat = await fs.stat(filePath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { component: definition.component, filePath, source, exists: false, bytes: 0 };
		return { component: definition.component, filePath, source, exists: true, bytes: 0, parseError: boundedError(error) };
	}
	const snapshot: NervousStateFileSnapshot = { component: definition.component, filePath, source, exists: true, bytes: stat.size };
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
		if (!isPlainObject(parsed)) throw new Error("top-level value is not an object");
		const meta = isPlainObject(parsed.meta) ? parsed.meta : undefined;
		const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : typeof meta?.updated_at === "string" ? meta.updated_at : undefined;
		if (updatedAt) snapshot.updatedAt = updatedAt;
		const collection = parsed[definition.collection];
		const records = Array.isArray(collection) ? collection : isPlainObject(collection) ? Object.values(collection) : undefined;
		if (records) {
			snapshot.recordCount = records.length;
			if (definition.terminal.length > 0) {
				const terminal = new Set<string>(definition.terminal);
				snapshot.openRecordCount = records.filter((record) => !isPlainObject(record) || typeof record.status !== "string" || !terminal.has(record.status)).length;
			}
		}
	} catch (error) { snapshot.parseError = boundedError(error); }
	return snapshot;
}

async function readDirectoryNames(dir: string): Promise<string[]> {
	try { return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
	catch { return []; }
}

async function listArtifactPaths(dir: string): Promise<string[]> {
	let entries;
	try { entries = await fs.readdir(dir, { withFileTypes: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const paths: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) paths.push(...await listArtifactPaths(entryPath));
		else paths.push(entryPath);
	}
	return paths;
}

async function inspectArtifacts(contextDir: string): Promise<{ count: number; bytes: number }> {
	const paths = await listArtifactPaths(contextDir);
	const sizes = await Promise.all(paths.map(async (artifactPath) => {
		try { return (await fs.lstat(artifactPath)).size; } catch { return 0; }
	}));
	return { count: paths.length, bytes: sizes.reduce((total, size) => total + size, 0) };
}

async function findLiveLocks(contextDir: string): Promise<string[]> {
	const lockPaths = (await listArtifactPaths(contextDir)).filter((artifactPath) => artifactPath.endsWith(".lock"));
	const live = await Promise.all(lockPaths.map(async (lockPath) => await lockFileIsLive(lockPath) ? lockPath : undefined));
	return live.filter((lockPath): lockPath is string => Boolean(lockPath));
}

async function readActiveLionRunIds(filePath: string): Promise<{ ids: string[]; unreadable: boolean }> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
		if (!isPlainObject(parsed) || !isPlainObject(parsed.runs)) return { ids: [], unreadable: true };
		const ids = Object.entries(parsed.runs).flatMap(([id, run]) =>
			isPlainObject(run) && (run.status === "queued" || run.status === "running") ? [typeof run.id === "string" ? run.id : id] : [],
		);
		return { ids, unreadable: false };
	} catch { return { ids: [], unreadable: true }; }
}

function assertResetAllowed(assessment: NervousResetAssessment, force: boolean): void {
	if (assessment.overridePaths.length) throw new Error(`context-wide reset is unavailable while component path overrides are active (${assessment.overridePaths.join(", ")}); unset them or archive those files manually`);
	if (assessment.liveLockPaths.length) throw new Error(`context has live component writes (${assessment.liveLockPaths.join(", ")}); wait for them to settle before resetting`);
	if (!force && assessment.activeLionRunIds.length) throw new Error(`context has queued/running LION records (${assessment.activeLionRunIds.join(", ")}); cancel/reconcile them or rerun /nervous:reset force only after confirming no worker process is live`);
	if (!force && assessment.lionStateUnreadable) throw new Error("LION state is unreadable, so worker liveness cannot be classified; inspect it or rerun /nervous:reset force only after confirming no worker process is live");
}

async function withContextResetLock<T>(projectDir: string, context: string, fn: () => Promise<T>): Promise<T> {
	await fs.mkdir(projectDir, { recursive: true, mode: 0o700 });
	const lockPath = path.join(projectDir, `.reset-${context}.lock`);
	let handle;
	for (let attempt = 0; attempt < 2; attempt++) {
		try { handle = await fs.open(lockPath, "wx", 0o600); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await lockFileIsLive(lockPath)) throw error;
			await fs.unlink(lockPath).catch(() => undefined);
		}
	}
	if (!handle) throw new Error(`could not acquire NERVous context reset lock ${lockPath}`);
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
		await handle.sync();
		await handle.close();
		handle = undefined;
		return await fn();
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		await fs.unlink(lockPath).catch(() => undefined);
	}
}

async function lockFileIsLive(lockPath: string): Promise<boolean> {
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
		if (!isPlainObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.ts !== "number") return false;
		return Date.now() - parsed.ts <= CONTEXT_RESET_LOCK_STALE_MS && isPidAlive(parsed.pid);
	} catch { return false; }
}

function isPidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function readArchiveManifest(manifestPath: string): Promise<NervousArchiveManifest | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
		if (!isPlainObject(parsed)
			|| parsed.version !== 1
			|| typeof parsed.project !== "string"
			|| typeof parsed.context !== "string"
			|| typeof parsed.resetAt !== "string"
			|| !Number.isFinite(Date.parse(parsed.resetAt))) return undefined;
		return parsed as unknown as NervousArchiveManifest;
	} catch { return undefined; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || !Number.isFinite(Number(raw))) return fallback;
	return Math.max(0, Number(raw));
}

function boundedError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(ms: number): string {
	if (ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)}d TTL`;
	if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h TTL`;
	if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m TTL`;
	return `${ms}ms TTL`;
}
