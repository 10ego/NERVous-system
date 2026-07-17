import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveNervousStateFile } from "@nervous-system/state";
import type { MagiInput, MagiOutput } from "./schema.ts";

export interface MagiRecord {
	id: string;
	input: MagiInput;
	output: MagiOutput;
	source: string;
	created_at: string;
}

interface MagiHistoryFile {
	version: number;
	updated_at: string;
	records: Record<string, MagiRecord>;
}

const VERSION = 1;
const LOCK_STALE_TTL_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 200;
const LOCK_DELAY_MS = 25;
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isPidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { const code = (error as NodeJS.ErrnoException).code; return code !== "ESRCH" && code !== "EINVAL"; }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
	try {
		const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown; ts?: unknown };
		return typeof parsed.pid !== "number" || typeof parsed.ts !== "number" || !isPidAlive(parsed.pid) || Date.now() - parsed.ts > LOCK_STALE_TTL_MS;
	} catch { return true; }
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	let attempts = 0;
	for (;;) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
			await handle.close();
			try { return await fn(); }
			finally { await fs.unlink(lockPath).catch(() => undefined); }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			attempts++;
			if (attempts % 20 === 0 && await lockIsStale(lockPath)) { await fs.unlink(lockPath).catch(() => undefined); continue; }
			if (attempts >= LOCK_MAX_ATTEMPTS) throw new Error(`magi: timed out acquiring lock ${lockPath}`);
			await sleep(LOCK_DELAY_MS);
		}
	}
}

export function resolveMagiHistoryPath(cwd: string): string {
	return resolveNervousStateFile(cwd, "magi", "history.json", "MAGI_HISTORY_PATH");
}

export class MagiHistoryStore {
	constructor(private readonly historyPath: string) {}

	static fromCwd(cwd: string): MagiHistoryStore {
		return new MagiHistoryStore(resolveMagiHistoryPath(cwd));
	}

	async list(limit = 50): Promise<MagiRecord[]> {
		const file = await this.load();
		return Object.values(file.records)
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
			.slice(0, limit)
			.map(clone);
	}

	async append(input: MagiInput, output: MagiOutput, source: string): Promise<MagiRecord> {
		await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
		return withLock(`${this.historyPath}.lock`, async () => {
			const file = await this.load();
			const id = nextId(Object.keys(file.records));
			const record: MagiRecord = { id, input: clone(input), output: clone(output), source, created_at: now() };
			file.records[id] = record;
			file.updated_at = record.created_at;
			await this.saveUnlocked(file);
			return clone(record);
		});
	}

	private async load(): Promise<MagiHistoryFile> {
		try {
			const raw = await fs.readFile(this.historyPath, "utf8");
			const parsed = JSON.parse(raw) as Partial<MagiHistoryFile>;
			return {
				version: typeof parsed.version === "number" ? parsed.version : VERSION,
				updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : now(),
				records: isRecord(parsed.records) ? coerceRecords(parsed.records) : {},
			};
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { version: VERSION, updated_at: now(), records: {} };
			throw err;
		}
	}

	private async saveUnlocked(file: MagiHistoryFile): Promise<void> {
		const tmp = `${this.historyPath}.tmp`;
		const bak = `${this.historyPath}.bak`;
		try { await fs.copyFile(this.historyPath, bak); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
		await fs.writeFile(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
		await fs.rename(tmp, this.historyPath);
	}
}

function nextId(ids: string[]): string {
	let max = 0;
	for (const id of ids) {
		const m = /^magi-(\d+)$/.exec(id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `magi-${String(max + 1).padStart(3, "0")}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceRecords(raw: Record<string, unknown>): Record<string, MagiRecord> {
	const out: Record<string, MagiRecord> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.output)) continue;
		out[id] = {
			id: typeof value.id === "string" ? value.id : id,
			input: value.input as unknown as MagiInput,
			output: value.output as unknown as MagiOutput,
			source: typeof value.source === "string" ? value.source : "unknown",
			created_at: typeof value.created_at === "string" ? value.created_at : now(),
		};
	}
	return out;
}
