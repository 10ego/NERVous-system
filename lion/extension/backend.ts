/**
 * LION durable backend. runs.json is the sole identity/lifecycle authority;
 * exact-incarnation progress sidecars are an optional bounded read overlay.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveNervousStateFile } from "@nervous-system/state";
import { LionLedger, type FinishRunInput } from "./store.ts";
import { LionError, isActiveLionStatus, isTerminalLionStatus, type LionFile, type LionProgressSnapshot, type LionRun } from "./schema.ts";
import { ProgressSnapshotStore, emptyLionIoCounters, type LionIoCounters } from "./progress-sidecar.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface LionLocation { runsPath: string; dir: string }
export function resolveLionLocation(cwd: string): LionLocation {
	const runsPath = resolveNervousStateFile(cwd, "lion", "runs.json", "LION_RUNS_PATH");
	return { runsPath, dir: path.dirname(runsPath) };
}

export function canonicalLionNamespace(runsPath: string): string {
	let absolute = path.resolve(runsPath);
	const seenLinks = new Set<string>();
	for (;;) {
		try {
			const stat = fsSync.lstatSync(absolute);
			if (!stat.isSymbolicLink()) break;
			if (seenLinks.has(absolute)) throw new Error(`lion: symlink cycle at ${absolute}`);
			seenLinks.add(absolute);
			absolute = path.resolve(path.dirname(absolute), fsSync.readlinkSync(absolute));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			break;
		}
	}
	let existing = absolute;
	while (!fsSync.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) return absolute;
		existing = parent;
	}
	try {
		const canonicalBase = fsSync.realpathSync.native(existing);
		return path.join(canonicalBase, path.relative(existing, absolute));
	} catch { return absolute; }
}

interface LockInfo { pid: number; ts: number }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function isPidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { const code = (error as NodeJS.ErrnoException).code; return code !== "ESRCH" && code !== "EINVAL"; }
}
async function readLock(lockPath: string): Promise<LockInfo | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown; ts?: unknown };
		return typeof parsed.pid === "number" && typeof parsed.ts === "number" ? { pid: parsed.pid, ts: parsed.ts } : null;
	} catch { return null; }
}
async function isLockStale(lockPath: string): Promise<boolean> {
	const info = await readLock(lockPath);
	return !info || !isPidAlive(info.pid) || Date.now() - info.ts > LOCK_STALE_TTL_MS;
}
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	let attempts = 0;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockInfo));
			await handle.sync();
			await handle.close();
			try { return await fn(); }
			finally { await fs.unlink(lockPath).catch(() => undefined); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			attempts++;
			if (attempts % 20 === 0 && await isLockStale(lockPath)) { await fs.unlink(lockPath).catch(() => undefined); continue; }
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`lion: timed out acquiring lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
}

async function fsyncDirectory(dir: string): Promise<void> {
	const handle = await fs.open(dir, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicWrite(filePath: string, data: string): Promise<number> {
	const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	const handle = await fs.open(tmp, "wx", 0o600);
	try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
	try {
		await fs.rename(tmp, filePath);
		await fs.chmod(filePath, 0o600);
		await fsyncDirectory(path.dirname(filePath));
	} catch (error) { await fs.unlink(tmp).catch(() => undefined); throw error; }
	return Buffer.byteLength(data);
}

export interface LoadResult { ledger: LionLedger; warnings: string[]; fresh: boolean; canonicalCertain?: boolean }
interface LifecycleChange { ref: { id: string; incarnation_id: string }; kind: "open" | "terminal" | "remove" }

export class FileBackend {
	readonly location: LionLocation;
	readonly progress: ProgressSnapshotStore;
	private readonly lockPath: string;
	private readonly bakPath: string;
	private readonly counters = emptyLionIoCounters();

	constructor(location: LionLocation) {
		const runsPath = canonicalLionNamespace(location.runsPath);
		this.location = { runsPath, dir: path.dirname(runsPath) };
		this.lockPath = `${runsPath}.lock`;
		this.bakPath = `${runsPath}.bak`;
		this.progress = new ProgressSnapshotStore(runsPath, this.lockPath, withLock, this.counters);
	}

	ioCounters(): Readonly<LionIoCounters> { return { ...this.counters }; }
	resetIoCounters(): void { Object.assign(this.counters, emptyLionIoCounters()); }

	async load(): Promise<LoadResult> { return this.loadUnlocked(true); }
	async save(ledger: LionLedger): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => this.saveUnlocked(ledger));
	}

	async mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const loaded = await this.loadUnlocked(true);
			const before = loaded.ledger.all();
			const result = fn(loaded.ledger);
			const lifecycleWarnings = await this.prepareLifecycleUnlocked(before, loaded.ledger);
			await this.saveUnlocked(loaded.ledger);
			await this.cleanupLifecycleUnlocked(before, loaded.ledger);
			return { result, warnings: [...loaded.warnings, ...lifecycleWarnings] };
		});
	}

	async mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; warnings: string[]; changed: boolean }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const loaded = await this.loadUnlocked(true);
			const before = loaded.ledger.all();
			const outcome = fn(loaded.ledger);
			let lifecycleWarnings: string[] = [];
			if (outcome.changed) {
				lifecycleWarnings = await this.prepareLifecycleUnlocked(before, loaded.ledger);
				await this.saveUnlocked(loaded.ledger);
				await this.cleanupLifecycleUnlocked(before, loaded.ledger);
			}
			return { result: outcome.result, warnings: [...loaded.warnings, ...lifecycleWarnings], changed: outcome.changed };
		});
	}

	async flushProgress(ref: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionProgressSnapshot | undefined> {
		return this.progress.flush(ref, progress);
	}

	async finishExact(id: string, incarnationId: string | null | undefined, input: FinishRunInput): Promise<{ result: { run: LionRun | undefined; committed: boolean }; warnings: string[] }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		if (!incarnationId) return this.mutate((ledger) => ledger.finishIfCurrent(id, incarnationId, input));
		return withLock(this.lockPath, async () => {
			const initial = await this.loadUnlocked(false);
			const current = initial.ledger.get(id);
			if (!current || current.incarnation_id !== incarnationId || isTerminalLionStatus(current.status)) {
				return { result: { run: current, committed: false }, warnings: initial.warnings };
			}
			const closed = await this.progress.closeUnlocked({ id, incarnation_id: incarnationId });
			// Reload after durable close. A crash from here through canonical rename is retryable.
			const reloaded = await this.loadUnlocked(false);
			const exact = reloaded.ledger.get(id);
			if (!exact || exact.incarnation_id !== incarnationId || !isActiveLionStatus(exact.status)) {
				return { result: { run: exact, committed: false }, warnings: [...initial.warnings, ...closed.warnings, ...reloaded.warnings] };
			}
			if (closed.progress) reloaded.ledger.foldProgressIfCurrent(id, incarnationId, closed.progress);
			const result = reloaded.ledger.finishIfCurrent(id, incarnationId, input);
			await this.saveUnlocked(reloaded.ledger);
			// A crash after save leaves canonical terminal truth; this cleanup orphan is ignorable.
			await this.progress.removeExactUnlocked({ id, incarnation_id: incarnationId }).catch(() => undefined);
			return { result, warnings: [...initial.warnings, ...closed.warnings, ...reloaded.warnings] };
		});
	}

	async deleteExact(id: string): Promise<{ result: LionRun; warnings: string[] }> {
		return this.mutate((ledger) => ledger.delete(id));
	}

	async cleanupProgress(): Promise<string[]> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const loaded = await this.loadUnlocked(false);
			return [...loaded.warnings, ...await this.progress.cleanupUnlocked(loaded.ledger, loaded.canonicalCertain !== false)];
		});
	}

	private async prepareLifecycleUnlocked(beforeRuns: LionRun[], ledger: LionLedger): Promise<string[]> {
		const warnings: string[] = [];
		const before = new Map(beforeRuns.map((run) => [run.id, run]));
		const after = new Map(ledger.all().map((run) => [run.id, run]));
		const changes: LifecycleChange[] = [];
		for (const run of after.values()) {
			if (!run.incarnation_id) continue;
			const previous = before.get(run.id);
			const replacement = previous && previous.incarnation_id !== run.incarnation_id;
			if (run.status === "running" && (!previous || replacement || previous.status === "queued")) changes.push({ kind: "open", ref: { id: run.id, incarnation_id: run.incarnation_id } });
			if (previous && previous.incarnation_id === run.incarnation_id && isActiveLionStatus(previous.status) && isTerminalLionStatus(run.status)) changes.push({ kind: "terminal", ref: { id: run.id, incarnation_id: run.incarnation_id } });
		}
		for (const previous of before.values()) {
			if (!previous.incarnation_id) continue;
			const current = after.get(previous.id);
			if (!current || current.incarnation_id !== previous.incarnation_id) changes.push({ kind: "remove", ref: { id: previous.id, incarnation_id: previous.incarnation_id } });
		}
		for (const change of changes.filter((item) => item.kind === "open")) await this.progress.openUnlocked(change.ref);
		for (const change of changes.filter((item) => item.kind === "terminal")) {
			const closed = await this.progress.closeUnlocked(change.ref);
			warnings.push(...closed.warnings);
			if (closed.progress) ledger.foldProgressIfCurrent(change.ref.id, change.ref.incarnation_id, closed.progress);
		}
		if (changes.some((item) => item.kind === "terminal")) {
			const exactCheck = await this.loadUnlocked(false);
			warnings.push(...exactCheck.warnings);
			for (const change of changes.filter((item) => item.kind === "terminal")) {
				const canonical = exactCheck.ledger.get(change.ref.id);
				if (!canonical || canonical.incarnation_id !== change.ref.incarnation_id || !isActiveLionStatus(canonical.status)) throw new Error(`lion: terminal exact-check failed for ${change.ref.id}/${change.ref.incarnation_id}`);
			}
		}
		return warnings;
	}

	private async cleanupLifecycleUnlocked(beforeRuns: LionRun[], ledger: LionLedger): Promise<void> {
		const after = new Map(ledger.all().map((run) => [run.id, run]));
		const refs = new Map<string, { id: string; incarnation_id: string }>();
		for (const run of beforeRuns) {
			if (!run.incarnation_id) continue;
			const current = after.get(run.id);
			if (!current || current.incarnation_id !== run.incarnation_id || isTerminalLionStatus(current.status)) refs.set(`${run.id}\0${run.incarnation_id}`, { id: run.id, incarnation_id: run.incarnation_id });
		}
		for (const run of after.values()) if (run.incarnation_id && isTerminalLionStatus(run.status)) refs.set(`${run.id}\0${run.incarnation_id}`, { id: run.id, incarnation_id: run.incarnation_id });
		for (const ref of refs.values()) await this.progress.removeExactUnlocked(ref).catch(() => undefined);
	}

	private async loadUnlocked(overlay: boolean): Promise<LoadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.location.runsPath, "utf8");
			this.counters.canonical_reads++;
			this.counters.canonical_bytes_read += Buffer.byteLength(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledger: new LionLedger(), warnings: [], fresh: true, canonicalCertain: true };
			throw error;
		}
		let ledger: LionLedger;
		try {
			this.counters.canonical_parses++;
			ledger = LionLedger.fromJSON(JSON.parse(raw) as LionFile);
		} catch (error) {
			if (error instanceof LionError) {
				throw new LionError(error.code, `lion state at ${this.location.runsPath} was rejected: ${error.message}; no migration or automatic reset was performed`);
			}
			const stamp = Date.now();
			await fs.copyFile(this.location.runsPath, `${this.location.runsPath}.corrupt-${stamp}`).catch(() => undefined);
			return {
				ledger: new LionLedger(), fresh: false, canonicalCertain: false,
				warnings: [`lion run ledger at ${this.location.runsPath} was corrupt (${error instanceof Error ? error.message : String(error)}); backed up to .corrupt-${stamp} and started fresh.`],
			};
		}
		if (!overlay) return { ledger, warnings: [], fresh: false, canonicalCertain: true };
		try {
			return { ledger, warnings: await this.progress.overlayUnlocked(ledger), fresh: false, canonicalCertain: true };
		} catch (error) {
			return { ledger, warnings: [`lion progress overlay was ignored without changing canonical truth: ${error instanceof Error ? error.message : String(error)}`], fresh: false, canonicalCertain: true };
		}
	}

	private async saveUnlocked(ledger: LionLedger): Promise<void> {
		this.counters.canonical_serializations++;
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		let previous: string | undefined;
		try { previous = await fs.readFile(this.location.runsPath, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (previous !== undefined) {
			const bytes = await atomicWrite(this.bakPath, previous);
			this.counters.canonical_backups++;
			this.counters.canonical_bytes_written += bytes;
		}
		const bytes = await atomicWrite(this.location.runsPath, data);
		this.counters.canonical_writes++;
		this.counters.canonical_bytes_written += bytes;
	}
}

export class LionStore {
	readonly backend: FileBackend;
	readonly namespaceId: string;
	constructor(backend: FileBackend) { this.backend = backend; this.namespaceId = canonicalLionNamespace(backend.location.runsPath); }
	static fromCwd(cwd: string): LionStore { return new LionStore(new FileBackend(resolveLionLocation(cwd))); }
	async query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		const { ledger, warnings } = await this.backend.load(); return { result: fn(ledger), warnings };
	}
	async mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> { return this.backend.mutate(fn); }
	async mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; warnings: string[]; changed: boolean }> { return this.backend.mutateMaybe(fn); }
	async flushProgress(ref: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionProgressSnapshot | undefined> { return this.backend.flushProgress(ref, progress); }
	async finishRun(id: string, incarnationId: string | null | undefined, input: FinishRunInput): Promise<{ result: { run: LionRun | undefined; committed: boolean }; warnings: string[] }> { return this.backend.finishExact(id, incarnationId, input); }
	async deleteRun(id: string): Promise<{ result: LionRun; warnings: string[] }> { return this.backend.deleteExact(id); }
	async cleanupProgressArtifacts(): Promise<string[]> { return this.backend.cleanupProgress(); }
	ioCounters(): Readonly<LionIoCounters> { return this.backend.ioCounters(); }
	resetIoCounters(): void { this.backend.resetIoCounters(); }
}
