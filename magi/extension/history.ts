import * as fs from "node:fs/promises";
import * as path from "node:path";
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
const now = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function resolveMagiHistoryPath(cwd: string): string {
	const env = process.env.MAGI_HISTORY_PATH;
	return env && path.isAbsolute(env) ? env : path.join(cwd, ".pi", "magi", "history.json");
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
		const file = await this.load();
		const id = nextId(Object.keys(file.records));
		const record: MagiRecord = { id, input: clone(input), output: clone(output), source, created_at: now() };
		file.records[id] = record;
		file.updated_at = record.created_at;
		await this.save(file);
		return clone(record);
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

	private async save(file: MagiHistoryFile): Promise<void> {
		await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
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
