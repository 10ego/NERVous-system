/** GANGLION — durable file backend. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { GanglionLedger } from "./store.ts";
import { GanglionError, type GanglionFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface GanglionLocation { ganglionPath: string; dir: string }
export function resolveGanglionLocation(cwd: string): GanglionLocation {
	const ganglionPath = resolveNervousStateFile(cwd, "ganglion", "ganglion.json", "GANGLION_PATH");
	return { ganglionPath, dir: path.dirname(ganglionPath) };
}

interface LockInfo { pid: number; ts: number }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function isPidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (err) { const code = (err as NodeJS.ErrnoException).code; return code !== "ESRCH" && code !== "EINVAL"; } }
async function readLock(lockPath: string): Promise<LockInfo | null> { try { const p = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown; ts?: unknown }; return typeof p.pid === "number" && typeof p.ts === "number" ? { pid: p.pid, ts: p.ts } : null; } catch { return null; } }
async function isLockStale(lockPath: string): Promise<boolean> { const info = await readLock(lockPath); return !info || !isPidAlive(info.pid) || Date.now() - info.ts > LOCK_STALE_TTL_MS; }
export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	let attempts = 0;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockInfo));
			await handle.close();
			try { return await fn(); } finally { try { await fs.unlink(lockPath); } catch { /* ignore */ } }
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			attempts++;
			if (attempts % 20 === 0 && await isLockStale(lockPath)) { try { await fs.unlink(lockPath); } catch { /* raced */ } continue; }
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`ganglion: timed out acquiring lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
}

export interface LoadResult { ledger: GanglionLedger; warnings: string[]; fresh: boolean }
export class FileBackend {
	readonly location: GanglionLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;
	constructor(location: GanglionLocation) {
		this.location = location;
		this.lockPath = `${location.ganglionPath}.lock`;
		this.tmpPath = `${location.ganglionPath}.tmp`;
		this.bakPath = `${location.ganglionPath}.bak`;
	}
	async load(): Promise<LoadResult> { return this.loadUnlocked(); }
	async save(ledger: GanglionLedger): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, () => this.saveUnlocked(ledger));
	}
	async mutate<T>(fn: (ledger: GanglionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const { ledger, warnings } = await this.loadUnlocked();
			const result = fn(ledger);
			await this.saveUnlocked(ledger);
			return { result, warnings };
		});
	}
	private async loadUnlocked(): Promise<LoadResult> {
		let raw: string;
		try { raw = await fs.readFile(this.location.ganglionPath, "utf8"); }
		catch (err) { const code = (err as NodeJS.ErrnoException).code; if (code === "ENOENT") return { ledger: new GanglionLedger(), warnings: [], fresh: true }; throw err; }
		try { return { ledger: GanglionLedger.fromJSON(JSON.parse(raw) as GanglionFile), warnings: [], fresh: false }; }
		catch (err) {
			if (err instanceof GanglionError) {
				throw new GanglionError(err.code, `ganglion state at ${this.location.ganglionPath} was rejected: ${err.message}; no migration or automatic reset was performed`);
			}
			const stamp = Date.now();
			try { await fs.copyFile(this.location.ganglionPath, `${this.location.ganglionPath}.corrupt-${stamp}`); } catch { /* best effort */ }
			return { ledger: new GanglionLedger(), warnings: [`ganglion state at ${this.location.ganglionPath} was corrupt (${err instanceof Error ? err.message : String(err)}); backed up to .corrupt-${stamp} and started fresh.`], fresh: false };
		}
	}
	private async saveUnlocked(ledger: GanglionLedger): Promise<void> {
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		try { await fs.copyFile(this.location.ganglionPath, this.bakPath); } catch (err) { const code = (err as NodeJS.ErrnoException).code; if (code !== "ENOENT") throw err; }
		await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
		await fs.rename(this.tmpPath, this.location.ganglionPath);
	}
}

export class GanglionStore {
	readonly backend: FileBackend;
	constructor(backend: FileBackend) { this.backend = backend; }
	static fromCwd(cwd: string): GanglionStore { return new GanglionStore(new FileBackend(resolveGanglionLocation(cwd))); }
	async query<T>(fn: (ledger: GanglionLedger) => T): Promise<{ result: T; warnings: string[] }> { const { ledger, warnings } = await this.backend.load(); return { result: fn(ledger), warnings }; }
	async mutate<T>(fn: (ledger: GanglionLedger) => T): Promise<{ result: T; warnings: string[] }> { return this.backend.mutate(fn); }
}
