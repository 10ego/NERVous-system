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
import { isActiveLionStatus, isTerminalLionStatus, type LionFile, type LionProgressSnapshot, type LionRun } from "./schema.ts";
import { ProgressSnapshotStore, emptyLionIoCounters, type LionIoCounters, type ProgressFlushOutcome, type ProgressFlushRequest } from "./progress-sidecar.ts";

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
interface AtomicWriteResult { bytes: number; post_commit_warning?: string }
async function atomicWrite(filePath: string, data: string): Promise<AtomicWriteResult> {
	const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	let renamed = false;
	try {
		const handle = await fs.open(tmp, "wx", 0o600);
		try { await handle.writeFile(data, "utf8"); await handle.sync(); } finally { await handle.close(); }
		await fs.rename(tmp, filePath);
		renamed = true;
		try { await fsyncDirectory(path.dirname(filePath)); }
		catch (error) {
			return { bytes: Buffer.byteLength(data), post_commit_warning: `atomic rename committed but directory sync failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
		}
	} finally {
		if (!renamed) await fs.unlink(tmp).catch(() => undefined);
	}
	return { bytes: Buffer.byteLength(data) };
}

export interface LoadResult { ledger: LionLedger; warnings: string[]; fresh: boolean; canonicalCertain?: boolean; raw?: string }
interface LifecycleChange { ref: { id: string; incarnation_id: string }; kind: "open" | "terminal" | "remove"; wasActive?: boolean }
function boundedWarnings(warnings: string[]): string[] { return warnings.slice(0, 20).map((warning) => warning.slice(0, 500)); }

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
			const loaded = await this.loadUnlocked(false);
			await this.overlayActiveProgressUnlocked(loaded);
			const before = loaded.ledger.all();
			const result = fn(loaded.ledger);
			const lifecycleWarnings = await this.prepareLifecycleUnlocked(before, loaded.ledger, loaded.canonicalCertain !== false);
			const saveWarnings = await this.saveUnlocked(loaded.ledger, loaded.raw);
			const cleanupWarnings = await this.cleanupLifecycleUnlocked(before, loaded.ledger);
			return { result, warnings: boundedWarnings([...loaded.warnings, ...lifecycleWarnings, ...saveWarnings, ...cleanupWarnings]) };
		});
	}

	async mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; warnings: string[]; changed: boolean }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const loaded = await this.loadUnlocked(false);
			await this.overlayActiveProgressUnlocked(loaded);
			const before = loaded.ledger.all();
			const outcome = fn(loaded.ledger);
			let lifecycleWarnings: string[] = [];
			let cleanupWarnings: string[] = [];
			let saveWarnings: string[] = [];
			if (outcome.changed) {
				lifecycleWarnings = await this.prepareLifecycleUnlocked(before, loaded.ledger, loaded.canonicalCertain !== false);
				saveWarnings = await this.saveUnlocked(loaded.ledger, loaded.raw);
				cleanupWarnings = await this.cleanupLifecycleUnlocked(before, loaded.ledger);
			}
			return { result: outcome.result, warnings: boundedWarnings([...loaded.warnings, ...lifecycleWarnings, ...saveWarnings, ...cleanupWarnings]), changed: outcome.changed };
		});
	}

	async flushProgress(ref: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionProgressSnapshot | undefined> {
		return this.progress.flush(ref, progress);
	}

	async flushProgressBatch(requests: ProgressFlushRequest[]): Promise<ProgressFlushOutcome[]> {
		return this.progress.flushBatch(requests);
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
			const saveWarnings = await this.saveUnlocked(reloaded.ledger, reloaded.raw);
			// A crash/failure after save leaves canonical terminal truth; retain a bounded
			// warning so later classification cleanup can recover the ignorable orphan.
			const cleanupWarnings: string[] = [];
			try { await this.progress.removeExactUnlocked({ id, incarnation_id: incarnationId }); }
			catch (error) { cleanupWarnings.push(`terminal progress cleanup deferred for ${id}/${incarnationId}: ${error instanceof Error ? error.message : String(error)}`); }
			return { result, warnings: boundedWarnings([...initial.warnings, ...closed.warnings, ...reloaded.warnings, ...saveWarnings, ...cleanupWarnings]) };
		});
	}

	async deleteExact(id: string): Promise<{ result: LionRun; warnings: string[] }> {
		return this.mutate((ledger) => ledger.delete(id));
	}

	async cleanupProgress(): Promise<string[]> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const loaded = await this.loadUnlocked(false);
			return boundedWarnings([...loaded.warnings, ...await this.progress.cleanupUnlocked(loaded.ledger, loaded.canonicalCertain !== false)]);
		});
	}

	private async prepareLifecycleUnlocked(beforeRuns: LionRun[], ledger: LionLedger, canonicalCertain: boolean): Promise<string[]> {
		const warnings: string[] = [];
		const before = new Map(beforeRuns.map((run) => [run.id, run]));
		const after = new Map(ledger.all().map((run) => [run.id, run]));
		const changes: LifecycleChange[] = [];
		for (const run of after.values()) {
			if (!run.incarnation_id) continue;
			const previous = before.get(run.id);
			const replacement = previous && previous.incarnation_id !== run.incarnation_id;
			if (run.status === "running" && (!previous || replacement || previous.status === "queued")) changes.push({ kind: "open", ref: { id: run.id, incarnation_id: run.incarnation_id } });
			if (previous && previous.incarnation_id === run.incarnation_id && isActiveLionStatus(previous.status) && isTerminalLionStatus(run.status)) changes.push({ kind: "terminal", ref: { id: run.id, incarnation_id: run.incarnation_id }, wasActive: true });
		}
		for (const previous of before.values()) {
			if (!previous.incarnation_id) continue;
			const current = after.get(previous.id);
			if (!current || current.incarnation_id !== previous.incarnation_id) changes.push({ kind: "remove", ref: { id: previous.id, incarnation_id: previous.incarnation_id }, wasActive: isActiveLionStatus(previous.status) });
		}

		// Recovery cleanup is outside the flush path and classifies against the
		// pre-mutation canonical snapshot, so it cannot evict a currently active run.
		// A corrupt canonical load is not authoritative enough to classify any
		// existing sidecar as stale, even when this mutation admits a new run.
		if (changes.some((item) => item.kind === "open")) {
			if (canonicalCertain) warnings.push(...await this.progress.cleanupUnlocked(new LionLedger(undefined, beforeRuns), true));
			else warnings.push("lion progress cleanup skipped because canonical run classification is uncertain");
		}
		for (const change of changes.filter((item) => item.kind === "terminal" || (item.kind === "remove" && item.wasActive))) {
			const closed = await this.progress.closeUnlocked(change.ref);
			warnings.push(...closed.warnings);
			if (change.kind === "terminal" && closed.progress) ledger.foldProgressIfCurrent(change.ref.id, change.ref.incarnation_id, closed.progress);
		}
		for (const change of changes.filter((item) => item.kind === "open")) await this.progress.openUnlocked(change.ref);

		const exactChanges = changes.filter((item) => item.kind === "terminal" || (item.kind === "remove" && item.wasActive));
		if (exactChanges.length) {
			const exactCheck = await this.loadUnlocked(false);
			warnings.push(...exactCheck.warnings);
			for (const change of exactChanges) {
				const canonical = exactCheck.ledger.get(change.ref.id);
				if (!canonical || canonical.incarnation_id !== change.ref.incarnation_id || !isActiveLionStatus(canonical.status)) throw new Error(`lion: terminal/removal exact-check failed for ${change.ref.id}/${change.ref.incarnation_id}`);
			}
		}
		return boundedWarnings(warnings);
	}

	private async cleanupLifecycleUnlocked(beforeRuns: LionRun[], ledger: LionLedger): Promise<string[]> {
		const after = new Map(ledger.all().map((run) => [run.id, run]));
		const refs = new Map<string, { id: string; incarnation_id: string }>();
		for (const run of beforeRuns) {
			if (!run.incarnation_id) continue;
			const current = after.get(run.id);
			const becameTerminal = current?.incarnation_id === run.incarnation_id && isActiveLionStatus(run.status) && isTerminalLionStatus(current.status);
			const removedOrReplaced = !current || current.incarnation_id !== run.incarnation_id;
			if (becameTerminal || removedOrReplaced) refs.set(`${run.id}\0${run.incarnation_id}`, { id: run.id, incarnation_id: run.incarnation_id });
		}
		const warnings: string[] = [];
		for (const ref of refs.values()) {
			try { await this.progress.removeExactUnlocked(ref); }
			catch (error) { warnings.push(`progress cleanup deferred for ${ref.id}/${ref.incarnation_id}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		return boundedWarnings(warnings);
	}

	private async overlayActiveProgressUnlocked(loaded: LoadResult): Promise<void> {
		try { loaded.warnings.push(...await this.progress.overlayUnlocked(loaded.ledger)); }
		catch (error) { loaded.warnings.push(`lion progress overlay was ignored without changing canonical truth: ${error instanceof Error ? error.message : String(error)}`); }
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
			const stamp = Date.now();
			await fs.copyFile(this.location.runsPath, `${this.location.runsPath}.corrupt-${stamp}`).catch(() => undefined);
			return {
				ledger: new LionLedger(), fresh: false, canonicalCertain: false,
				warnings: [`lion run ledger at ${this.location.runsPath} was corrupt (${error instanceof Error ? error.message : String(error)}); backed up to .corrupt-${stamp} and started fresh.`],
			};
		}
		const loaded: LoadResult = { ledger, warnings: [], fresh: false, canonicalCertain: true, raw };
		if (!overlay) return loaded;
		await this.overlayActiveProgressUnlocked(loaded);
		return loaded;
	}

	private async saveUnlocked(ledger: LionLedger, previous?: string): Promise<string[]> {
		this.counters.canonical_serializations++;
		const warnings: string[] = [];
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		if (previous === undefined) {
			try {
				previous = await fs.readFile(this.location.runsPath, "utf8");
				this.counters.canonical_reads++;
				this.counters.canonical_bytes_read += Buffer.byteLength(previous);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		if (previous !== undefined) {
			const backup = await atomicWrite(this.bakPath, previous);
			this.counters.canonical_backups++;
			this.counters.canonical_bytes_written += backup.bytes;
			if (backup.post_commit_warning) warnings.push(backup.post_commit_warning);
		}
		const canonical = await atomicWrite(this.location.runsPath, data);
		this.counters.canonical_writes++;
		this.counters.canonical_bytes_written += canonical.bytes;
		if (canonical.post_commit_warning) warnings.push(canonical.post_commit_warning);
		return warnings;
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
	async flushProgressBatch(requests: ProgressFlushRequest[]): Promise<ProgressFlushOutcome[]> { return this.backend.flushProgressBatch(requests); }
	async finishRun(id: string, incarnationId: string | null | undefined, input: FinishRunInput): Promise<{ result: { run: LionRun | undefined; committed: boolean }; warnings: string[] }> { return this.backend.finishExact(id, incarnationId, input); }
	async deleteRun(id: string): Promise<{ result: LionRun; warnings: string[] }> { return this.backend.deleteExact(id); }
	async cleanupProgressArtifacts(): Promise<string[]> { return this.backend.cleanupProgress(); }
	ioCounters(): Readonly<LionIoCounters> { return this.backend.ioCounters(); }
	resetIoCounters(): void { this.backend.resetIoCounters(); }
}
