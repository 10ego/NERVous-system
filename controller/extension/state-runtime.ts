import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveContextSlug, resolveNervousStateFile, resolveProjectSlug, resolveRoot } from "@nervous-system/state";

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_MAX_ATTEMPTS = 400;
const LOCK_DELAY_MS = 25;
const MAX_DIAGNOSTIC_PATHS = 50;
const LION_STATUSES = new Set(["queued", "running", "completed", "blocked", "failed", "aborted"]);
export const NERVOUS_DASHBOARD_RECORD_LIMIT = 100;
export const NERVOUS_DEFAULT_SYNAPSE_TTL_MS = 24 * 60 * 60 * 1000;
export const NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES = 1000;
export const NERVOUS_DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
/** Trusted reset metadata is a sibling of the raw archive, never inside it. */
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

export interface NervousNamespaceRef {
	root: string;
	project: string;
	context: string;
	projectDir: string;
	contextDir: string;
}

export interface NervousStateFileSnapshot {
	component: NervousStateComponent;
	filePath: string;
	source: "namespace" | "override" | "symlink";
	resolvedPath?: string;
	exists: boolean;
	bytes: number;
	updatedAt?: string;
	recordCount?: number;
	openRecordCount?: number;
	parseError?: string;
}

export interface NervousContextSnapshot extends NervousNamespaceRef {
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
	inspectionErrors: string[];
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

interface ArtifactScan {
	count: number;
	bytes: number;
	symlinkPaths: string[];
}

interface OwnedLockLease {
	path: string;
	owner: string;
	stopHeartbeat(): void;
	releaseAt(releasePath: string): Promise<void>;
}

/** Read-only inventory; component stores remain their own semantic validators. */
export async function inspectNervousContext(cwd: string): Promise<NervousContextSnapshot> {
	const namespace = resolveNamespace(cwd);
	const files = await Promise.all(NERVOUS_STATE_COMPONENTS.map((definition) => inspectStateFile(cwd, definition, true)));
	const entries = await readDirectoryNames(namespace.projectDir);
	const otherContexts = entries.filter((entry) => entry !== namespace.context && entry !== ".archive").sort();
	const archives = await readDirectoryNames(path.join(namespace.projectDir, ".archive"));
	return snapshotFrom(namespace, files, otherContexts, archives.length);
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
			? "- New reset archives do not expire automatically."
			: `- New reset archives are retained for at least ${snapshot.archiveRetentionDays}d; each archive keeps the policy recorded when it was created.`,
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
		const invalid = file.parseError ? `, unreadable: ${file.parseError}` : "";
		const location = file.source === "namespace"
			? "namespace"
			: `${file.source} \`${file.filePath}\`${file.resolvedPath ? ` → \`${file.resolvedPath}\`` : ""}`;
		lines.push(`- ${file.component.toUpperCase()}: ${records}${open}, ${formatBytes(file.bytes)}, ${location}${file.updatedAt ? `, updated ${file.updatedAt}` : ""}${invalid}`);
	}
	lines.push(
		"",
		`Other work contexts: ${snapshot.otherContexts.length}${snapshot.otherContexts.length ? ` (${snapshot.otherContexts.slice(0, 20).join(", ")}${snapshot.otherContexts.length > 20 ? ", …" : ""})` : ""}.`,
		`Reset archives: ${snapshot.archiveCount}.`,
		"Use a distinct `NERVOUS_CONTEXT` for concurrently resumable work. Use `/nervous:reset` when this namespace should start clean.",
	);
	return lines.join("\n");
}

export function resolveNervousArchiveRetentionDays(): number {
	return Math.floor(nonNegativeEnvNumber("NERVOUS_ARCHIVE_RETENTION_DAYS", NERVOUS_DEFAULT_ARCHIVE_RETENTION_DAYS));
}

/** Inspect reset safety without parsing non-LION durable ledgers. */
export async function assessNervousContextReset(
	cwd: string,
	expectedNamespace?: NervousNamespaceRef,
	ignoredArtifacts: ReadonlySet<string> = new Set(),
): Promise<NervousResetAssessment> {
	const namespace = resolveNamespace(cwd);
	assertExpectedNamespace(namespace, expectedNamespace);
	const files = await Promise.all(NERVOUS_STATE_COMPONENTS.map((definition) => inspectStateFile(cwd, definition, false)));
	const snapshot = snapshotFrom(namespace, files, [], 0);
	const artifacts = await scanArtifacts(snapshot.contextDir, ignoredArtifacts);
	const lion = files.find((file) => file.component === "lion");
	const lionActivity = lion?.exists && !lion.parseError && lion.source === "namespace"
		? await readActiveLionRunIds(lion.filePath)
		: { ids: [], unreadable: Boolean(lion?.exists) };
	const unsafePaths = new Set<string>();
	for (const file of files) if (file.source !== "namespace") unsafePaths.add(`${file.component}:${file.filePath}${file.resolvedPath ? `->${file.resolvedPath}` : ""}`);
	for (const symlinkPath of artifacts.symlinkPaths) unsafePaths.add(`symlink:${symlinkPath}`);
	return {
		snapshot,
		artifactCount: artifacts.count,
		artifactBytes: artifacts.bytes,
		overridePaths: [...unsafePaths].slice(0, MAX_DIAGNOSTIC_PATHS),
		inspectionErrors: files.flatMap((file) => file.parseError ? [`${file.component}:${file.parseError}`] : []),
		activeLionRunIds: lionActivity.ids,
		lionStateUnreadable: lionActivity.unreadable,
	};
}

/** Archive the complete context without migration or partial record deletion. */
export async function archiveNervousContext(
	cwd: string,
	options: { force?: boolean; now?: Date; sessionId?: string; expectedNamespace?: NervousNamespaceRef } = {},
): Promise<NervousResetResult> {
	const namespace = resolveNamespace(cwd);
	assertExpectedNamespace(namespace, options.expectedNamespace);
	return withOwnedLock(contextResetLockPath(namespace), async () => {
		assertExpectedNamespace(resolveNamespace(cwd), options.expectedNamespace ?? namespace);
		const preflight = await assessNervousContextReset(cwd, options.expectedNamespace ?? namespace);
		assertResetAllowed(preflight, Boolean(options.force));
		if (preflight.artifactCount === 0) throw new Error(`NERVous context ${namespace.project}/${namespace.context} is already empty`);
		const lockPaths = preflight.snapshot.files.map((file) => `${file.filePath}.lock`).sort();
		const leases = await acquireComponentLocks(lockPaths);
		let archivePath: string | undefined;
		let manifestPath: string | undefined;
		let renamed = false;
		try {
			assertExpectedNamespace(resolveNamespace(cwd), options.expectedNamespace ?? namespace);
			const ignoredLocks = new Set(lockPaths);
			const assessment = await assessNervousContextReset(cwd, options.expectedNamespace ?? namespace, ignoredLocks);
			assertSameStatePaths(preflight.snapshot.files, assessment.snapshot.files);
			assertResetAllowed(assessment, Boolean(options.force));
			if (assessment.artifactCount === 0) throw new Error(`NERVous context ${namespace.project}/${namespace.context} is already empty`);

			const resetAt = (options.now ?? new Date()).toISOString();
			const archiveRoot = path.join(namespace.projectDir, ".archive");
			await assertRealDirectory(namespace.projectDir);
			await ensureRealDirectory(archiveRoot);
			({ archivePath, manifestPath } = await reserveArchivePaths(archiveRoot, namespace.context, resetAt));
			const manifest: NervousArchiveManifest = {
				version: 1,
				project: namespace.project,
				context: namespace.context,
				resetAt,
				originalPath: namespace.contextDir,
				artifactCount: assessment.artifactCount,
				artifactBytes: assessment.artifactBytes,
				archiveRetentionDays: assessment.snapshot.archiveRetentionDays,
				...(options.sessionId ? { sessionId: options.sessionId } : {}),
			};
			await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			for (const lease of leases) lease.stopHeartbeat();
			assertExpectedNamespace(resolveNamespace(cwd), options.expectedNamespace ?? namespace);
			await fs.rename(namespace.contextDir, archivePath);
			renamed = true;
			await releaseComponentLocks(leases, namespace.contextDir, archivePath);

			const warnings: string[] = [];
			let prunedArchivePaths: string[] = [];
			try { prunedArchivePaths = await pruneNervousArchives(cwd, { now: options.now, exclude: new Set([archivePath]) }); }
			catch (error) { warnings.push(`context was archived, but expired archives could not be pruned: ${boundedError(error)}`); }
			return { archivePath, manifestPath, prunedArchivePaths, warnings, assessment };
		} catch (error) {
			if (!renamed && manifestPath) await fs.unlink(manifestPath).catch(() => undefined);
			throw error;
		} finally {
			if (!renamed) await releaseComponentLocks(leases, namespace.contextDir);
		}
	});
}

/** Delete only reset archives whose own recorded retention has elapsed. */
export async function pruneNervousArchives(
	cwd: string,
	options: { now?: Date; exclude?: ReadonlySet<string> } = {},
): Promise<string[]> {
	const namespace = resolveNamespace(cwd);
	const archiveRoot = path.join(namespace.projectDir, ".archive");
	try { await assertRealDirectory(archiveRoot); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const entries = await fs.readdir(archiveRoot, { withFileTypes: true });
	const nowMs = (options.now ?? new Date()).getTime();
	const removed: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const archivePath = path.join(archiveRoot, entry.name);
		if (options.exclude?.has(archivePath)) continue;
		const manifestPath = archiveManifestPath(archivePath);
		const manifest = await readArchiveManifest(manifestPath);
		if (!manifest || manifest.project !== namespace.project || manifest.archiveRetentionDays === 0) continue;
		const expiresAt = Date.parse(manifest.resetAt) + manifest.archiveRetentionDays * 24 * 60 * 60 * 1000;
		if (!Number.isFinite(expiresAt) || nowMs < expiresAt) continue;
		await fs.rm(archivePath, { recursive: true, force: true });
		await fs.unlink(manifestPath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		removed.push(archivePath);
	}
	return removed;
}

function resolveNamespace(cwd: string): NervousNamespaceRef {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const context = resolveContextSlug(cwd);
	const projectDir = path.join(root, project);
	return { root, project, context, projectDir, contextDir: path.join(projectDir, context) };
}

function snapshotFrom(namespace: NervousNamespaceRef, files: NervousStateFileSnapshot[], otherContexts: string[], archiveCount: number): NervousContextSnapshot {
	return {
		...namespace,
		files,
		totalBytes: files.reduce((total, file) => total + file.bytes, 0),
		otherContexts,
		archiveCount,
		archiveRetentionDays: resolveNervousArchiveRetentionDays(),
		synapseRetention: {
			ttlMs: nonNegativeEnvNumber("SYNAPSE_TTL_MS", NERVOUS_DEFAULT_SYNAPSE_TTL_MS),
			maxNotes: nonNegativeEnvNumber("SYNAPSE_MAX_NOTES", NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES),
		},
	};
}

function assertExpectedNamespace(actual: NervousNamespaceRef, expected?: NervousNamespaceRef): void {
	if (!expected) return;
	if (actual.root !== expected.root || actual.project !== expected.project || actual.context !== expected.context || actual.contextDir !== expected.contextDir) {
		throw new Error(`NERVous namespace changed after confirmation (expected ${expected.project}/${expected.context} at ${expected.contextDir}, found ${actual.project}/${actual.context} at ${actual.contextDir}); nothing was reset`);
	}
}

function assertSameStatePaths(before: NervousStateFileSnapshot[], after: NervousStateFileSnapshot[]): void {
	const first = before.map((file) => `${file.component}:${file.filePath}:${file.source}`).join("\n");
	const second = after.map((file) => `${file.component}:${file.filePath}:${file.source}`).join("\n");
	if (first !== second) throw new Error("NERVous component state paths changed while reset was acquiring writer locks; nothing was reset");
}

async function inspectStateFile(
	cwd: string,
	definition: (typeof NERVOUS_STATE_COMPONENTS)[number],
	parseRecords: boolean,
): Promise<NervousStateFileSnapshot> {
	const override = process.env[definition.env];
	const filePath = resolveNervousStateFile(cwd, definition.component, definition.filename, definition.env);
	let source: NervousStateFileSnapshot["source"] = override && path.isAbsolute(override) ? "override" : "namespace";
	let stat;
	try { stat = await fs.lstat(filePath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { component: definition.component, filePath, source, exists: false, bytes: 0 };
		return { component: definition.component, filePath, source, exists: true, bytes: 0, parseError: boundedError(error) };
	}
	let resolvedPath: string | undefined;
	if (stat.isSymbolicLink()) {
		source = "symlink";
		try { resolvedPath = await fs.realpath(filePath); }
		catch (error) { return { component: definition.component, filePath, source, exists: true, bytes: stat.size, parseError: boundedError(error) }; }
	}
	const snapshot: NervousStateFileSnapshot = { component: definition.component, filePath, source, ...(resolvedPath ? { resolvedPath } : {}), exists: true, bytes: stat.size };
	if (!parseRecords) return snapshot;
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
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function scanArtifacts(contextDir: string, ignored: ReadonlySet<string>): Promise<ArtifactScan> {
	const result: ArtifactScan = { count: 0, bytes: 0, symlinkPaths: [] };
	let rootStat;
	try { rootStat = await fs.lstat(contextDir); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
	if (rootStat.isSymbolicLink()) return { count: 1, bytes: rootStat.size, symlinkPaths: [contextDir] };
	if (!rootStat.isDirectory()) throw new Error(`NERVous context path is not a directory: ${contextDir}`);
	const pending = [contextDir];
	while (pending.length) {
		const dirPath = pending.pop()!;
		let directory;
		try { directory = await fs.opendir(dirPath); }
		catch (error) {
			if (dirPath === contextDir && (error as NodeJS.ErrnoException).code === "ENOENT") return result;
			throw error;
		}
		for await (const entry of directory) {
			const entryPath = path.join(dirPath, entry.name);
			if (ignored.has(entryPath)) continue;
			if (entry.isDirectory()) { pending.push(entryPath); continue; }
			const stat = await fs.lstat(entryPath);
			result.count++;
			result.bytes += stat.size;
			if (stat.isSymbolicLink() && result.symlinkPaths.length < MAX_DIAGNOSTIC_PATHS) result.symlinkPaths.push(entryPath);
		}
	}
	return result;
}

async function readActiveLionRunIds(filePath: string): Promise<{ ids: string[]; unreadable: boolean }> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
		if (!isPlainObject(parsed) || !isPlainObject(parsed.runs)) return { ids: [], unreadable: true };
		const ids: string[] = [];
		for (const [key, value] of Object.entries(parsed.runs)) {
			if (!isPlainObject(value) || typeof value.id !== "string" || !value.id.trim() || value.id !== key || typeof value.status !== "string" || !LION_STATUSES.has(value.status)) {
				return { ids: [], unreadable: true };
			}
			if ((value.status === "queued" || value.status === "running") && ids.length < MAX_DIAGNOSTIC_PATHS) ids.push(value.id);
		}
		return { ids, unreadable: false };
	} catch { return { ids: [], unreadable: true }; }
}

function assertResetAllowed(assessment: NervousResetAssessment, force: boolean): void {
	if (assessment.overridePaths.length) throw new Error(`context-wide reset is unavailable while state paths escape the namespace (${assessment.overridePaths.join(", ")}); unset overrides or archive those files manually`);
	if (assessment.inspectionErrors.length) throw new Error(`context state could not be inspected safely (${assessment.inspectionErrors.join(", ")}); nothing was reset`);
	if (!force && assessment.activeLionRunIds.length) throw new Error(`context has queued/running LION records (${assessment.activeLionRunIds.join(", ")}); cancel/reconcile them or rerun /nervous:reset force only after confirming no worker process is live`);
	if (!force && assessment.lionStateUnreadable) throw new Error("LION state is unreadable or schema-invalid, so worker liveness cannot be classified; inspect it or rerun /nervous:reset force only after confirming no worker process is live");
}

async function acquireComponentLocks(lockPaths: string[]): Promise<OwnedLockLease[]> {
	const leases: OwnedLockLease[] = [];
	try {
		for (const lockPath of lockPaths) leases.push(await acquireOwnedLock(lockPath));
		return leases;
	} catch (error) {
		await Promise.all(leases.map((lease) => lease.releaseAt(lease.path)));
		throw error;
	}
}

async function releaseComponentLocks(leases: OwnedLockLease[], contextDir: string, archivePath?: string): Promise<void> {
	await Promise.all(leases.map(async (lease) => {
		lease.stopHeartbeat();
		const releasePath = archivePath ? path.join(archivePath, path.relative(contextDir, lease.path)) : lease.path;
		await lease.releaseAt(releasePath);
	}));
}

function contextResetLockPath(namespace: NervousNamespaceRef): string {
	return path.join(namespace.projectDir, `.reset-${namespace.context}.lock`);
}

async function withOwnedLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	const lease = await acquireOwnedLock(lockPath);
	try { return await fn(); }
	finally { await lease.releaseAt(lockPath); }
}

async function acquireOwnedLock(lockPath: string): Promise<OwnedLockLease> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	const owner = randomUUID();
	let attempts = 0;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now(), owner })); await handle.sync(); }
			finally { await handle.close(); }
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			attempts++;
			if (attempts % 20 === 0 && await lockFileIsStale(lockPath)) { await fs.unlink(lockPath).catch(() => undefined); continue; }
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`timed out acquiring NERVous state lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
	let released = false;
	const heartbeat = setInterval(() => { void refreshOwnedLock(lockPath, owner); }, LOCK_HEARTBEAT_MS);
	heartbeat.unref?.();
	return {
		path: lockPath,
		owner,
		stopHeartbeat: () => clearInterval(heartbeat),
		releaseAt: async (releasePath) => {
			if (released) return;
			released = true;
			clearInterval(heartbeat);
			await unlinkOwnedLock(releasePath, owner);
		},
	};
}

async function refreshOwnedLock(lockPath: string, owner: string): Promise<void> {
	let handle;
	try {
		// Opening first binds updates to our inode; a replacement path can never be
		// overwritten by a late heartbeat from the prior owner.
		handle = await fs.open(lockPath, "r+");
		const parsed = parseLockInfo(await handle.readFile("utf8"));
		if (parsed?.owner !== owner) return;
		const payload = Buffer.from(JSON.stringify({ pid: process.pid, ts: Date.now(), owner }));
		await handle.write(payload, 0, payload.length, 0);
		await handle.truncate(payload.length);
		await handle.sync();
	} catch { /* the context may have been atomically renamed */ }
	finally { await handle?.close().catch(() => undefined); }
}

async function unlinkOwnedLock(lockPath: string, owner: string): Promise<void> {
	try {
		const current = await readLockInfo(lockPath);
		if (current?.owner === owner) await fs.unlink(lockPath);
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function lockFileIsStale(lockPath: string): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	// Reset must never steal from a live writer. The heartbeat timestamp protects
	// reset leases from components' existing age-based stale-lock recovery.
	return !info || !isPidAlive(info.pid);
}

async function readLockInfo(lockPath: string): Promise<{ pid: number; ts: number; owner?: string } | undefined> {
	try { return parseLockInfo(await fs.readFile(lockPath, "utf8")); }
	catch { return undefined; }
}

function parseLockInfo(raw: string): { pid: number; ts: number; owner?: string } | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.ts !== "number") return undefined;
		return { pid: parsed.pid, ts: parsed.ts, ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}) };
	} catch { return undefined; }
}

function isPidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function assertRealDirectory(directoryPath: string): Promise<void> {
	const stat = await fs.lstat(directoryPath);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`NERVous reset rejects non-directory or symlink path ${directoryPath}`);
}

async function ensureRealDirectory(directoryPath: string): Promise<void> {
	try { await assertRealDirectory(directoryPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.mkdir(directoryPath, { recursive: false, mode: 0o700 });
		await assertRealDirectory(directoryPath);
	}
}

async function reserveArchivePaths(archiveRoot: string, context: string, resetAt: string): Promise<{ archivePath: string; manifestPath: string }> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const archiveName = `${context}-${resetAt.replace(/[^0-9TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
		const archivePath = path.join(archiveRoot, archiveName);
		const manifestPath = archiveManifestPath(archivePath);
		try {
			await fs.lstat(archivePath);
			continue;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		try {
			const reservation = await fs.open(manifestPath, "wx", 0o600);
			await reservation.close();
			await fs.unlink(manifestPath);
			return { archivePath, manifestPath };
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	throw new Error("could not reserve a unique NERVous reset archive path");
}

function archiveManifestPath(archivePath: string): string {
	return `${archivePath}${NERVOUS_ARCHIVE_MANIFEST}`;
}

async function readArchiveManifest(manifestPath: string): Promise<NervousArchiveManifest | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
		if (!isPlainObject(parsed)
			|| parsed.version !== 1
			|| typeof parsed.project !== "string"
			|| typeof parsed.context !== "string"
			|| typeof parsed.resetAt !== "string"
			|| !Number.isFinite(Date.parse(parsed.resetAt))
			|| typeof parsed.originalPath !== "string"
			|| typeof parsed.artifactCount !== "number" || !Number.isSafeInteger(parsed.artifactCount) || parsed.artifactCount < 0
			|| typeof parsed.artifactBytes !== "number" || !Number.isSafeInteger(parsed.artifactBytes) || parsed.artifactBytes < 0
			|| typeof parsed.archiveRetentionDays !== "number" || !Number.isSafeInteger(parsed.archiveRetentionDays) || parsed.archiveRetentionDays < 0) return undefined;
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
