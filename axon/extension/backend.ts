/**
 * AXON — durable file backend + store wrapper.
 *
 * Persistence model: a single JSON document at <ledgerPath> (default
 * `~/.pi/nervous/<project>/<context>/axon/ledger.json`), written atomically (temp file + rename) so a
 * crash can never leave a half-written ledger. The previous version is kept as
 * `ledger.json.bak` for one-step rollback.
 *
 * Concurrency: CEREBEL and multiple LION agents may run as separate `pi`
 * subprocesses and all hit the same ledger file. Each write is serialized with
 * an advisory lock file (`<ledger>.lock`, created with O_EXCL) plus stale-lock
 * detection (dead PID or age > TTL). The atomic rename guarantees the ledger is
 * never corrupted even if two writers race; the lock prevents lost updates from
 * interleaved read-modify-write.
 *
 * Robustness on load: a missing file yields an empty ledger; a corrupt file is
 * copied aside (`.corrupt-<ts>`) and a fresh ledger is returned with a warning,
 * so the system always comes up instead of crashing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { Ledger } from "./store.ts";
import type { LedgerFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface LedgerLocation {
	ledgerPath: string;
	dir: string;
}

/**
 * Resolve the ledger path. Precedence:
 *   1. `AXON_LEDGER_PATH` env var (absolute path to the file)
 *   2. `~/.pi/nervous/<project>/<context>/axon/ledger.json`
 */
export function resolveLedgerLocation(cwd: string): LedgerLocation {
	const ledgerPath = resolveNervousStateFile(cwd, "axon", "ledger.json", "AXON_LEDGER_PATH");
	return { ledgerPath, dir: path.dirname(ledgerPath) };
}

/* -------------------------------------------------------------------------- */
/* Cross-process advisory lock                                                */
/* -------------------------------------------------------------------------- */

interface LockInfo {
	pid: number;
	ts: number;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ESRCH = no such process → not alive. EINVAL on some platforms for bad pids.
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function readLock(lockPath: string): Promise<LockInfo | null> {
	try {
		const raw = await fs.readFile(lockPath, "utf8");
		const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
		if (typeof parsed.pid === "number" && typeof parsed.ts === "number") {
			return { pid: parsed.pid, ts: parsed.ts };
		}
		return null;
	} catch {
		return null;
	}
}

async function isLockStale(lockPath: string): Promise<boolean> {
	const info = await readLock(lockPath);
	if (!info) return true;
	if (!isPidAlive(info.pid)) return true;
	if (Date.now() - info.ts > LOCK_STALE_TTL_MS) return true;
	return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Acquire an exclusive lock around `fn`, deleting the lockfile when done. */
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
					/* lock already cleaned up */
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			attempts++;
			if (attempts % 20 === 0 && (await isLockStale(lockPath))) {
				// Steal a stale lock; next loop iteration retries the exclusive open.
				try {
					await fs.unlink(lockPath);
				} catch {
					/* raced; someone else removed it */
				}
				continue;
			}
			if (attempts >= LOCK_MAX_ATTEMPTS) {
				throw new Error(`axon: timed out acquiring lock ${lockPath} after ${attempts} attempts`);
			}
			await sleep(LOCK_DELAY_MS);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* File backend                                                                */
/* -------------------------------------------------------------------------- */

export interface LoadResult {
	ledger: Ledger;
	warnings: string[];
	fresh: boolean; // true when the ledger file did not exist
}

export class FileBackend {
	readonly location: LedgerLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;

	constructor(location: LedgerLocation) {
		this.location = location;
		this.lockPath = `${location.ledgerPath}.lock`;
		this.tmpPath = `${location.ledgerPath}.tmp`;
		this.bakPath = `${location.ledgerPath}.bak`;
	}

	async load(): Promise<LoadResult> {
		return this.loadUnlocked();
	}

	async mutate<T>(fn: (ledger: Ledger) => T): Promise<{ result: T; warnings: string[] }> {
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
		try {
			raw = await fs.readFile(this.location.ledgerPath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { ledger: new Ledger(), warnings: [], fresh: true };
			throw err;
		}

		try {
			const parsed = JSON.parse(raw) as LedgerFile;
			return { ledger: Ledger.fromJSON(parsed), warnings: [], fresh: false };
		} catch (err) {
			// Corrupt: preserve the bad file for inspection and start fresh.
			const stamp = Date.now();
			try {
				await fs.copyFile(this.location.ledgerPath, `${this.location.ledgerPath}.corrupt-${stamp}`);
			} catch {
				/* best effort */
			}
			return {
				ledger: new Ledger(),
				warnings: [
					`ledger at ${this.location.ledgerPath} was corrupt (${err instanceof Error ? err.message : String(err)}); ` +
						`backed up to .corrupt-${stamp} and started fresh.`,
				],
				fresh: false,
			};
		}
	}

	async save(ledger: Ledger): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => this.saveUnlocked(ledger));
	}

	private async saveUnlocked(ledger: Ledger): Promise<void> {
		const data = JSON.stringify(ledger.toJSON(), null, 2);
		// Backup the previous good file before replacing it.
		try {
			await fs.copyFile(this.location.ledgerPath, this.bakPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err; // ignore "no previous file"
		}
		await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
		await fs.rename(this.tmpPath, this.location.ledgerPath);
	}

	/** Atomic wipe (for /axon:reset). Kept here so it goes through the lock. */
	async wipe(): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => {
			try {
				await fs.copyFile(this.location.ledgerPath, this.bakPath);
			} catch {
				/* ignore */
			}
			try {
				await fs.unlink(this.location.ledgerPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw err;
			}
		});
	}
}

/* -------------------------------------------------------------------------- */
/* Store wrapper (load → mutate → save)                                        */
/* -------------------------------------------------------------------------- */

/**
 * High-level store: every mutating call loads the latest ledger from disk,
 * applies the change under the cross-process lock, and saves it back. This
 * guarantees AXON always reflects on-disk truth even when multiple processes
 * are writing concurrently.
 */
export class AxonStore {
	readonly backend: FileBackend;
	constructor(backend: FileBackend) {
		this.backend = backend;
	}

	static fromCwd(cwd: string): AxonStore {
		return new AxonStore(new FileBackend(resolveLedgerLocation(cwd)));
	}

	/** Read-only query against a freshly loaded ledger. */
	async query<T>(fn: (ledger: Ledger) => T): Promise<{ result: T; warnings: string[] }> {
		const { ledger, warnings } = await this.backend.load();
		return { result: fn(ledger), warnings };
	}

	/**
	 * Mutating call: load, apply `fn` (which mutates the ledger in place), save.
	 * Returns the result of `fn` plus any load warnings.
	 *
	 * Note: `fn` should both mutate and return whatever snapshot/value the caller
	 * needs. The ledger is saved unconditionally when `fn` does not throw.
	 */
	async mutate<T>(fn: (ledger: Ledger) => T): Promise<{ result: T; warnings: string[] }> {
		return this.backend.mutate(fn);
	}
}
