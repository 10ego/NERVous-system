/**
 * CORTEX — durable file backend + store wrapper.
 *
 * Same durability strategy as AXON/SYNAPSE (atomic temp+rename writes +
 * cross-process lock + corrupt-file recovery) applied to the goal store. The
 * goal file is the durable CORTEX state that lets work resume after compaction
 * or restart without the original context window.
 *
 * Storage: a single JSON document at <cortexPath> (default
 * `~/.pi/nervous/<project>/<context>/cortex/cortex.json`), shared across the main agent and any
 * CORTEX subprocesses.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import { GoalStore } from "./store.ts";
import type { CortexFile } from "./schema.ts";

const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;

export interface CortexLocation {
	cortexPath: string;
	dir: string;
}

/**
 * Resolve the cortex-state path. Precedence:
 *   1. `CORTEX_PATH` env var (absolute path to the file)
 *   2. `~/.pi/nervous/<project>/<context>/cortex/cortex.json`
 */
export function resolveCortexLocation(cwd: string): CortexLocation {
	const cortexPath = resolveNervousStateFile(cwd, "cortex", "cortex.json", "CORTEX_PATH");
	return { cortexPath, dir: path.dirname(cortexPath) };
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
				throw new Error(`cortex: timed out acquiring lock ${lockPath} after ${attempts} attempts`);
			}
			await sleep(LOCK_DELAY_MS);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* File backend                                                                */
/* -------------------------------------------------------------------------- */

export interface LoadResult {
	store: GoalStore;
	warnings: string[];
	fresh: boolean;
}

export class FileBackend {
	readonly location: CortexLocation;
	private readonly lockPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;

	constructor(location: CortexLocation) {
		this.location = location;
		this.lockPath = `${location.cortexPath}.lock`;
		this.tmpPath = `${location.cortexPath}.tmp`;
		this.bakPath = `${location.cortexPath}.bak`;
	}

	async load(): Promise<LoadResult> {
		return this.loadUnlocked();
	}

	async mutate<T>(fn: (store: GoalStore) => T): Promise<{ result: T; warnings: string[] }> {
		await fs.mkdir(this.location.dir, { recursive: true });
		return withLock(this.lockPath, async () => {
			const { store, warnings } = await this.loadUnlocked();
			const result = fn(store);
			await this.saveUnlocked(store);
			return { result, warnings };
		});
	}

	private async loadUnlocked(): Promise<LoadResult> {
		let raw: string;
		try {
			raw = await fs.readFile(this.location.cortexPath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { store: new GoalStore(), warnings: [], fresh: true };
			throw err;
		}

		try {
			const parsed = JSON.parse(raw) as CortexFile;
			return { store: GoalStore.fromJSON(parsed), warnings: [], fresh: false };
		} catch (err) {
			const stamp = Date.now();
			try {
				await fs.copyFile(this.location.cortexPath, `${this.location.cortexPath}.corrupt-${stamp}`);
			} catch {
				/* best effort */
			}
			return {
				store: new GoalStore(),
				warnings: [
					`cortex state at ${this.location.cortexPath} was corrupt (${err instanceof Error ? err.message : String(err)}); ` +
						`backed up to .corrupt-${stamp} and started fresh.`,
				],
				fresh: false,
			};
		}
	}

	async save(store: GoalStore): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => this.saveUnlocked(store));
	}

	private async saveUnlocked(store: GoalStore): Promise<void> {
		const data = JSON.stringify(store.toJSON(), null, 2);
		try {
			await fs.copyFile(this.location.cortexPath, this.bakPath);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw err;
		}
		await fs.writeFile(this.tmpPath, data, { encoding: "utf8", mode: 0o600 });
		await fs.rename(this.tmpPath, this.location.cortexPath);
	}

	async wipe(): Promise<void> {
		await fs.mkdir(this.location.dir, { recursive: true });
		await withLock(this.lockPath, async () => {
			try {
				await fs.copyFile(this.location.cortexPath, this.bakPath);
			} catch {
				/* ignore */
			}
			try {
				await fs.unlink(this.location.cortexPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT") throw err;
			}
		});
	}
}

/* -------------------------------------------------------------------------- */
/* Store wrapper (load → operate → save)                                      */
/* -------------------------------------------------------------------------- */

export class CortexStore {
	readonly backend: FileBackend;

	constructor(backend: FileBackend) {
		this.backend = backend;
	}

	static fromCwd(cwd: string): CortexStore {
		return new CortexStore(new FileBackend(resolveCortexLocation(cwd)));
	}

	async query<T>(fn: (store: GoalStore) => T): Promise<{ result: T; warnings: string[] }> {
		const { store, warnings } = await this.backend.load();
		return { result: fn(store), warnings };
	}

	async mutate<T>(fn: (store: GoalStore) => T): Promise<{ result: T; warnings: string[] }> {
		return this.backend.mutate(fn);
	}
}
