/**
 * LION — durable file backend.
 *
 * Stores worker run records at `~/.pi/nervous/<project>/<context>/lion/runs.json` (or LION_RUNS_PATH),
 * with atomic writes, backup, advisory lock, and corrupt-file recovery.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { LionLedger } from "./store.ts";
import type { LionFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface LionLocation {
	runsPath: string;
	dir: string;
}

export function resolveLionLocation(cwd: string): LionLocation {
	const runsPath = resolveNervousStateFile(cwd, "lion", "runs.json", "LION_RUNS_PATH");
	return { runsPath, dir: path.dirname(runsPath) };
}

export function canonicalLionNamespace(runsPath: string): string {
	const absolute = path.resolve(runsPath);
	let existing = absolute;
	while (!fsSync.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) return absolute;
		existing = parent;
	}
	try {
		const canonicalBase = fsSync.realpathSync.native(existing);
		return path.join(canonicalBase, path.relative(existing, absolute));
	} catch {
		return absolute;
	}
}

interface LockInfo {
	pid: number;
	ts: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function readLock(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
		return typeof parsed.pid === "number" && typeof parsed.ts === "number" ? { pid: parsed.pid, ts: parsed.ts } : null;
	} catch {
		return null;
	}
}

async function isLockStale(lockPath: string): Promise<boolean> {
	const info = await readLock(lockPath);
	if (!info) return true;
	if (!isPidAlive(info.pid)) return true;
	return Date.now() - info.ts > LOCK_STALE_TTL_MS;
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	let attempts = 0;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() } satisfies LockInfo));
			await handle.close();
			try {
				return await fn();
			} finally {
				try {
					await fs.unlink(lockPath);
				} catch {
					/* ignore */
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			attempts++;
			if (attempts % 20 === 0 && (await isLockStale(lockPath))) {
				try {
					await fs.unlink(lockPath);
				} catch {
					/* raced */
				}
				continue;
			}
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`lion: timed out acquiring lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
}

export interface LoadResult {
	ledger: LionLedger;
	warnings: string[];
	fresh: boolean;
}

export class FileBackend {
	readonly location: LionLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;

	constructor(location: LionLocation) {
		this.location = location;
		this.lockPath = `${location.runsPath}.lock`;
		this.tmpPath = `${location.runsPath}.tmp`;
		this.bakPath = `${location.runsPath}.bak`;
	}

	async load(): Promise<LoadResult> {
		return this.loadUnlocked();
	}

	async save(ledger: LionLedger): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => this.saveUnlocked(ledger));
	}

	async mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const { ledger, warnings } = await this.loadUnlocked();
			const result = fn(ledger);
			await this.saveUnlocked(ledger);
			return { result, warnings };
		});
	}

	async mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; warnings: string[]; changed: boolean }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const { ledger, warnings } = await this.loadUnlocked();
			const outcome = fn(ledger);
			if (outcome.changed) await this.saveUnlocked(ledger);
			return { result: outcome.result, warnings, changed: outcome.changed };
		});
	}

	private async loadUnlocked(): Promise<LoadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.location.runsPath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { ledger: new LionLedger(), warnings: [], fresh: true };
			throw err;
		}

		try {
			return { ledger: LionLedger.fromJSON(JSON.parse(raw) as LionFile), warnings: [], fresh: false };
		} catch (err) {
			const stamp = Date.now();
			try {
				await fs.copyFile(this.location.runsPath, `${this.location.runsPath}.corrupt-${stamp}`);
			} catch {
				/* best effort */
			}
			return {
				ledger: new LionLedger(),
				warnings: [
					`lion run ledger at ${this.location.runsPath} was corrupt (${err instanceof Error ? err.message : String(err)}); backed up to .corrupt-${stamp} and started fresh.`,
				],
				fresh: false,
			};
		}
	}

	private async saveUnlocked(ledger: LionLedger): Promise<void> {
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		try {
			await fs.copyFile(this.location.runsPath, this.bakPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}
		await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
		await fs.rename(this.tmpPath, this.location.runsPath);
	}
}

export class LionStore {
	readonly backend: FileBackend;
	readonly namespaceId: string;

	constructor(backend: FileBackend) {
		this.backend = backend;
		this.namespaceId = canonicalLionNamespace(backend.location.runsPath);
	}

	static fromCwd(cwd: string): LionStore {
		return new LionStore(new FileBackend(resolveLionLocation(cwd)));
	}

	async query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		const { ledger, warnings } = await this.backend.load();
		return { result: fn(ledger), warnings };
	}

	async mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T; warnings: string[] }> {
		return this.backend.mutate(fn);
	}

	async mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; warnings: string[]; changed: boolean }> {
		return this.backend.mutateMaybe(fn);
	}
}
