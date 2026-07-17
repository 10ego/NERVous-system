/** AMYGDALA — durable file backend. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { AmygdalaLedger } from "./store.ts";
import type { AmygdalaFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;
export interface AmygdalaLocation { amygdalaPath: string; dir: string }
export function resolveAmygdalaLocation(cwd: string): AmygdalaLocation {
	const amygdalaPath = resolveNervousStateFile(cwd, "amygdala", "amygdala.json", "AMYGDALA_PATH");
	return { amygdalaPath, dir: path.dirname(amygdalaPath) };
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
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockInfo));
			await handle.close();
			try { return await fn(); }
			finally { await fs.unlink(lockPath).catch(() => undefined); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			attempts++;
			if (attempts % 20 === 0 && await isLockStale(lockPath)) { await fs.unlink(lockPath).catch(() => undefined); continue; }
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`amygdala: timed out acquiring lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
}

export interface LoadResult { ledger: AmygdalaLedger; warnings: string[]; fresh: boolean }
export class FileBackend {
	readonly location: AmygdalaLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;
	constructor(location: AmygdalaLocation) {
		this.location = location;
		this.lockPath = `${location.amygdalaPath}.lock`;
		this.tmpPath = `${location.amygdalaPath}.tmp`;
		this.bakPath = `${location.amygdalaPath}.bak`;
	}
	async load(): Promise<LoadResult> { return this.loadUnlocked(); }
	async save(ledger: AmygdalaLedger): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, () => this.saveUnlocked(ledger));
	}
	async mutate<T>(fn: (ledger: AmygdalaLedger) => T): Promise<{ result: T; warnings: string[] }> {
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
		try { raw = await fs.readFile(this.location.amygdalaPath, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledger: new AmygdalaLedger(), warnings: [], fresh: true };
			throw error;
		}
		try { return { ledger: AmygdalaLedger.fromJSON(JSON.parse(raw) as AmygdalaFile), warnings: [], fresh: false }; }
		catch (error) {
			const stamp = Date.now();
			await fs.copyFile(this.location.amygdalaPath, `${this.location.amygdalaPath}.corrupt-${stamp}`).catch(() => undefined);
			return {
				ledger: new AmygdalaLedger(),
				warnings: [`amygdala state at ${this.location.amygdalaPath} was corrupt (${error instanceof Error ? error.message : String(error)}); backed up to .corrupt-${stamp} and started fresh.`],
				fresh: false,
			};
		}
	}
	private async saveUnlocked(ledger: AmygdalaLedger): Promise<void> {
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		try { await fs.copyFile(this.location.amygdalaPath, this.bakPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
		await fs.rename(this.tmpPath, this.location.amygdalaPath);
	}
}
export class AmygdalaStore {
	readonly backend: FileBackend;
	constructor(backend: FileBackend) { this.backend = backend; }
	static fromCwd(cwd: string): AmygdalaStore { return new AmygdalaStore(new FileBackend(resolveAmygdalaLocation(cwd))); }
	async query<T>(fn: (ledger: AmygdalaLedger) => T): Promise<{ result: T; warnings: string[] }> {
		const { ledger, warnings } = await this.backend.load();
		return { result: fn(ledger), warnings };
	}
	async mutate<T>(fn: (ledger: AmygdalaLedger) => T): Promise<{ result: T; warnings: string[] }> { return this.backend.mutate(fn); }
}
