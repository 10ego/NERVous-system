/**
 * SYNAPSE — durable file backend + store wrapper.
 *
 * Same durability strategy as AXON (atomic temp+rename writes + cross-process
 * lock + corrupt-file recovery) but applied to the transient note log. The key
 * difference: the store wrapper applies {@link RetentionPolicy} on every save so
 * SYNAPSE stays bounded and transient rather than growing without limit.
 *
 * Storage: a single JSON document at <synapsePath> (default
 * `~/.pi/nervous/<project>/<context>/synapse/synapse.json`), shared across CEREBEL/LION subprocesses.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { NoteLog, type RetentionPolicy } from "./store.ts";
import type { SynapseFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface SynapseLocation {
	synapsePath: string;
	dir: string;
}

/**
 * Resolve the scratchpad path. Precedence:
 *   1. `SYNAPSE_PATH` env var (absolute path to the file)
 *   2. `~/.pi/nervous/<project>/<context>/synapse/synapse.json`
 */
export function resolveSynapseLocation(cwd: string): SynapseLocation {
	const synapsePath = resolveNervousStateFile(cwd, "synapse", "synapse.json", "SYNAPSE_PATH");
	return { synapsePath, dir: path.dirname(synapsePath) };
}

/* -------------------------------------------------------------------------- */
/* Cross-process advisory lock (same approach as AXON)                       */
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
				try {
					await fs.unlink(lockPath);
				} catch {
					/* raced; someone else removed it */
				}
				continue;
			}
			if (attempts >= LOCK_MAX_ATTEMPTS) {
				throw new Error(`synapse: timed out acquiring lock ${lockPath} after ${attempts} attempts`);
			}
			await sleep(LOCK_DELAY_MS);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* File backend                                                                */
/* -------------------------------------------------------------------------- */

export interface LoadResult {
	log: NoteLog;
	warnings: string[];
	fresh: boolean; // true when the file did not exist
}

export class FileBackend {
	readonly location: SynapseLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;

	constructor(location: SynapseLocation) {
		this.location = location;
		this.lockPath = `${location.synapsePath}.lock`;
		this.tmpPath = `${location.synapsePath}.tmp`;
		this.bakPath = `${location.synapsePath}.bak`;
	}

	async load(retention?: RetentionPolicy): Promise<LoadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.location.synapsePath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { log: new NoteLog(undefined, retention), warnings: [], fresh: true };
			throw err;
		}

		try {
			const parsed = JSON.parse(raw) as SynapseFile;
			return { log: NoteLog.fromJSON(parsed, retention), warnings: [], fresh: false };
		} catch (err) {
			const stamp = Date.now();
			try {
				await fs.copyFile(this.location.synapsePath, `${this.location.synapsePath}.corrupt-${stamp}`);
			} catch {
				/* best effort */
			}
			return {
				log: new NoteLog(undefined, retention),
				warnings: [
					`synapse log at ${this.location.synapsePath} was corrupt (${err instanceof Error ? err.message : String(err)}); ` +
						`backed up to .corrupt-${stamp} and started fresh.`,
				],
				fresh: false,
			};
		}
	}

	async save(log: NoteLog): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => {
			const data = JSON.stringify(log.toJSON(), null, 2);
			try {
				await fs.copyFile(this.location.synapsePath, this.bakPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw err;
			}
			await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
			await fs.rename(this.tmpPath, this.location.synapsePath);
		});
	}

	async wipe(): Promise<void> {
		await withLock(this.lockPath, async () => {
			try {
				await fs.copyFile(this.location.synapsePath, this.bakPath);
			} catch {
				/* ignore */
			}
			try {
				await fs.unlink(this.location.synapsePath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw err;
			}
		});
	}
}

/* -------------------------------------------------------------------------- */
/* Store wrapper (load → operate → save, with retention on save)             */
/* -------------------------------------------------------------------------- */

export class SynapseStore {
	readonly backend: FileBackend;
	readonly retention: RetentionPolicy;

	constructor(backend: FileBackend, retention: RetentionPolicy = DEFAULT_STORE_RETENTION) {
		this.backend = backend;
		this.retention = retention;
	}

	static fromCwd(cwd: string, retention?: RetentionPolicy): SynapseStore {
		const r = resolveStoreRetention(cwd, retention);
		return new SynapseStore(new FileBackend(resolveSynapseLocation(cwd)), r);
	}

	/** Read-only query against a freshly loaded log. */
	async query<T>(fn: (log: NoteLog) => T): Promise<{ result: T; warnings: string[] }> {
		const { log, warnings } = await this.backend.load(this.retention);
		return { result: fn(log), warnings };
	}

	/**
	 * Mutating call: load, apply `fn`, prune per retention, save. Returns the
	 * result of `fn` plus any load warnings and the number of notes pruned.
	 */
	async mutate<T>(fn: (log: NoteLog) => T): Promise<{ result: T; warnings: string[]; pruned: number }> {
		const { log, warnings } = await this.backend.load(this.retention);
		const result = fn(log);
		const pruned = log.prune(this.retention);
		await this.backend.save(log);
		return { result, warnings, pruned };
	}

	/** Forced prune + save (for the `prune` action). */
	async pruneOnly(): Promise<{ pruned: number }> {
		const { log } = await this.backend.load(this.retention);
		const pruned = log.prune(this.retention);
		await this.backend.save(log);
		return { pruned };
	}
}

/* -------------------------------------------------------------------------- */
/* Retention resolution (env override per project)                            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_STORE_RETENTION: RetentionPolicy = {
	ttl_ms: 24 * 60 * 60 * 1000,
	max_notes: 1000,
};

/**
 * Resolve the effective retention. Precedence:
 *   1. Explicit `retention` argument (from caller/tool)
 *   2. `SYNAPSE_TTL_MS` / `SYNAPSE_MAX_NOTES` env vars
 *   3. DEFAULT_STORE_RETENTION
 */
export function resolveStoreRetention(_cwd: string, retention?: RetentionPolicy): RetentionPolicy {
	if (retention) return retention;
	const ttlEnv = process.env.SYNAPSE_TTL_MS;
	const maxEnv = process.env.SYNAPSE_MAX_NOTES;
	const ttl = ttlEnv !== undefined && Number.isFinite(Number(ttlEnv)) ? Number(ttlEnv) : DEFAULT_STORE_RETENTION.ttl_ms;
	const max =
		maxEnv !== undefined && Number.isFinite(Number(maxEnv)) ? Number(maxEnv) : DEFAULT_STORE_RETENTION.max_notes;
	return { ttl_ms: ttl, max_notes: max };
}
