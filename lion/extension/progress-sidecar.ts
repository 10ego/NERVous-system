import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isActiveLionStatus, LION_PROGRESS_EVENTS, MAX_ACTIVE_TOOL_NAME_CHARS, MAX_ACTIVE_TOOL_NAMES, type LionProgressSnapshot, type LionRun } from "./schema.ts";
import type { LionLedger } from "./store.ts";

export const LION_PROGRESS_SIDECAR_VERSION = 1;
export const MAX_PROGRESS_SNAPSHOT_BYTES = 16 * 1024;
export const MAX_PROGRESS_ENVELOPE_BYTES = 24 * 1024;
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 500;
const MAX_QUARANTINE_FILES = 16;
const MAX_QUARANTINE_BYTES = 512 * 1024;
const MAX_SIDECAR_FILES = 8_192;
const MAX_SIDECAR_STORAGE_BYTES = 128 * 1024 * 1024;
const EVENT_SET = new Set<string>(LION_PROGRESS_EVENTS);

export interface LionIoCounters {
	canonical_reads: number;
	canonical_parses: number;
	canonical_backups: number;
	canonical_serializations: number;
	canonical_writes: number;
	canonical_bytes_read: number;
	canonical_bytes_written: number;
	sidecar_reads: number;
	sidecar_writes: number;
	sidecar_backups: number;
	sidecar_bytes_read: number;
	sidecar_bytes_written: number;
}

export function emptyLionIoCounters(): LionIoCounters {
	return {
		canonical_reads: 0, canonical_parses: 0, canonical_backups: 0, canonical_serializations: 0,
		canonical_writes: 0, canonical_bytes_read: 0, canonical_bytes_written: 0,
		sidecar_reads: 0, sidecar_writes: 0, sidecar_backups: 0, sidecar_bytes_read: 0, sidecar_bytes_written: 0,
	};
}

export interface ProgressEnvelope {
	version: typeof LION_PROGRESS_SIDECAR_VERSION;
	namespace: string;
	run_id: string;
	incarnation_id: string;
	state: "open" | "closed";
	sequence: number;
	progress: LionProgressSnapshot | null;
	updated_at: string;
}

interface ExactRef { id: string; incarnation_id: string }
interface Candidate { envelope: ProgressEnvelope; raw: Buffer; filePath: string; kind: "primary" | "backup" }
interface LatestResult { candidate?: Candidate; warnings: string[]; invalid: Array<{ filePath: string; reason: string }> }

export class ProgressSidecarError extends Error {
	constructor(message: string) { super(message); this.name = "ProgressSidecarError"; }
}

function boundedWarning(message: string): string { return message.slice(0, MAX_WARNING_CHARS); }
function pushWarning(warnings: string[], message: string): void { if (warnings.length < MAX_WARNINGS) warnings.push(boundedWarning(message)); }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateProgress(value: unknown): value is LionProgressSnapshot {
	if (!isObject(value) || byteLength(value) > MAX_PROGRESS_SNAPSHOT_BYTES) return false;
	return typeof value.event === "string" && EVENT_SET.has(value.event)
		&& typeof value.activity === "string" && value.activity.length <= 1_000
		&& Array.isArray(value.active_tools) && value.active_tools.length <= MAX_ACTIVE_TOOL_NAMES
		&& value.active_tools.every((tool) => typeof tool === "string" && tool.length <= MAX_ACTIVE_TOOL_NAME_CHARS)
		&& typeof value.tool_uses === "number" && Number.isSafeInteger(value.tool_uses) && value.tool_uses >= 0
		&& typeof value.turn_count === "number" && Number.isSafeInteger(value.turn_count) && value.turn_count >= 0
		&& (value.token_total === null || value.token_total === undefined || (typeof value.token_total === "number" && Number.isSafeInteger(value.token_total) && value.token_total >= 0))
		&& (value.last_text === null || value.last_text === undefined || (typeof value.last_text === "string" && value.last_text.length <= 1_000))
		&& isIsoTimestamp(value.last_event_at);
}

function parseEnvelope(raw: Buffer, namespace: string, ref?: ExactRef): ProgressEnvelope {
	if (raw.byteLength > MAX_PROGRESS_ENVELOPE_BYTES) throw new Error(`envelope exceeds ${MAX_PROGRESS_ENVELOPE_BYTES} bytes`);
	const value = JSON.parse(raw.toString("utf8")) as unknown;
	if (!isObject(value)) throw new Error("envelope is not an object");
	if (value.version !== LION_PROGRESS_SIDECAR_VERSION) throw new Error(`unsupported envelope version ${String(value.version)}`);
	if (value.namespace !== namespace) throw new Error("namespace identity mismatch");
	if (typeof value.run_id !== "string" || typeof value.incarnation_id !== "string" || !value.incarnation_id) throw new Error("missing exact run identity");
	if (ref && (value.run_id !== ref.id || value.incarnation_id !== ref.incarnation_id)) throw new Error("exact run identity mismatch");
	if (value.state !== "open" && value.state !== "closed") throw new Error("invalid authority state");
	if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("invalid sequence");
	if (value.progress !== null && !validateProgress(value.progress)) throw new Error("invalid or oversized progress snapshot");
	if (!isIsoTimestamp(value.updated_at)) throw new Error("invalid updated_at");
	return value as unknown as ProgressEnvelope;
}

async function assertNotSymlink(filePath: string): Promise<void> {
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) throw new ProgressSidecarError(`lion progress sidecar rejects symlink ${filePath}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function fsyncDirectory(dir: string): Promise<void> {
	const handle = await fs.open(dir, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
	const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	await assertNotSymlink(filePath);
	let renamed = false;
	try {
		const handle = await fs.open(tmp, "wx", 0o600);
		try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
		await fs.rename(tmp, filePath);
		renamed = true;
		await fs.chmod(filePath, 0o600);
		await fsyncDirectory(path.dirname(filePath));
	} finally {
		if (!renamed) await fs.unlink(tmp).catch(() => undefined);
	}
}

export function progressSidecarHash(namespace: string, runId: string, incarnationId: string): string {
	return createHash("sha256").update(namespace).update("\0").update(runId).update("\0").update(incarnationId).digest("hex");
}

export class ProgressSnapshotStore {
	readonly root: string;
	private readonly quarantineRoot: string;

	constructor(
		readonly namespace: string,
		private readonly lockPath: string,
		private readonly withLock: <T>(lockPath: string, fn: () => Promise<T>) => Promise<T>,
		private readonly counters: LionIoCounters,
	) {
		this.root = `${namespace}.progress`;
		this.quarantineRoot = path.join(this.root, "quarantine");
	}

	paths(ref: ExactRef): { primary: string; backup: string } {
		const base = path.join(this.root, progressSidecarHash(this.namespace, ref.id, ref.incarnation_id));
		return { primary: `${base}.json`, backup: `${base}.bak` };
	}

	async flush(ref: Pick<LionRun, "id" | "incarnation_id">, progress: LionProgressSnapshot): Promise<LionProgressSnapshot | undefined> {
		if (!ref.incarnation_id) return undefined;
		if (!validateProgress(progress)) throw new ProgressSidecarError(`progress snapshot exceeds the ${MAX_PROGRESS_SNAPSHOT_BYTES}-byte bounded schema`);
		return this.withLock(this.lockPath, async () => {
			const exact = { id: ref.id, incarnation_id: ref.incarnation_id! };
			const latest = await this.readLatestExactUnlocked(exact);
			await this.quarantineInvalidUnlocked(latest.invalid);
			if (!latest.candidate) {
				if (latest.invalid.length) throw new ProgressSidecarError(`no valid progress authority for ${ref.id}/${ref.incarnation_id}; malformed artifacts were quarantined`);
				return undefined;
			}
			if (latest.candidate.envelope.state !== "open") return undefined;
			if (latest.candidate.envelope.sequence >= Number.MAX_SAFE_INTEGER) throw new ProgressSidecarError(`progress sequence exhausted for ${ref.id}/${ref.incarnation_id}`);
			const next: ProgressEnvelope = { ...latest.candidate.envelope, state: "open", sequence: latest.candidate.envelope.sequence + 1, progress, updated_at: new Date().toISOString() };
			await this.replaceUnlocked(exact, next, latest.candidate);
			return progress;
		});
	}

	async openUnlocked(ref: ExactRef): Promise<void> {
		await this.ensureRootUnlocked();
		await this.assertCapacityUnlocked();
		const latest = await this.readLatestExactUnlocked(ref);
		await this.quarantineInvalidUnlocked(latest.invalid);
		if (latest.candidate) {
			if (latest.candidate.envelope.state === "open") return;
			throw new ProgressSidecarError(`progress authority is already closed for ${ref.id}/${ref.incarnation_id}`);
		}
		const envelope: ProgressEnvelope = {
			version: LION_PROGRESS_SIDECAR_VERSION, namespace: this.namespace, run_id: ref.id, incarnation_id: ref.incarnation_id,
			state: "open", sequence: 0, progress: null, updated_at: new Date().toISOString(),
		};
		const { primary, backup } = this.paths(ref);
		await fs.unlink(backup).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		await this.writePrimaryUnlocked(primary, Buffer.from(JSON.stringify(envelope)));
	}

	async closeUnlocked(ref: ExactRef): Promise<{ progress: LionProgressSnapshot | null; warnings: string[] }> {
		const latest = await this.readLatestExactUnlocked(ref);
		await this.quarantineInvalidUnlocked(latest.invalid);
		if (!latest.candidate) return { progress: null, warnings: latest.warnings };
		if (latest.candidate.envelope.state === "closed") return { progress: latest.candidate.envelope.progress, warnings: latest.warnings };
		if (latest.candidate.envelope.sequence >= Number.MAX_SAFE_INTEGER) throw new ProgressSidecarError(`progress sequence exhausted for ${ref.id}/${ref.incarnation_id}`);
		const closed: ProgressEnvelope = { ...latest.candidate.envelope, state: "closed", sequence: latest.candidate.envelope.sequence + 1, updated_at: new Date().toISOString() };
		await this.replaceUnlocked(ref, closed, latest.candidate);
		return { progress: closed.progress, warnings: latest.warnings };
	}

	async overlayUnlocked(ledger: LionLedger): Promise<string[]> {
		const warnings: string[] = [];
		for (const run of ledger.all()) {
			if (!isActiveLionStatus(run.status) || !run.incarnation_id) continue;
			const latest = await this.readLatestExactUnlocked({ id: run.id, incarnation_id: run.incarnation_id });
			for (const warning of latest.warnings) pushWarning(warnings, warning);
			if (latest.candidate?.envelope.progress) ledger.foldProgressIfCurrent(run.id, run.incarnation_id, latest.candidate.envelope.progress);
		}
		return warnings;
	}

	async removeExactUnlocked(ref: ExactRef): Promise<void> {
		if (!await this.assertSafeRootUnlocked()) return;
		const { primary, backup } = this.paths(ref);
		// The backup may contain the previous open envelope while the primary is
		// closed. Remove it first so an interrupted cleanup can only leave the
		// closed fence behind; a stale writer must never regain open authority.
		for (const filePath of [backup, primary]) {
			await this.assertSafeRootUnlocked();
			await this.unlinkArtifactUnlocked(filePath);
		}
		await fsyncDirectory(this.root);
	}

	private async unlinkArtifactUnlocked(filePath: string): Promise<void> {
		await assertNotSymlink(filePath);
		await fs.unlink(filePath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
	}

	async cleanupUnlocked(ledger: LionLedger, canonicalCertain = true): Promise<string[]> {
		if (!canonicalCertain) return ["lion progress cleanup skipped because canonical run classification is uncertain"];
		if (!await this.assertSafeRootUnlocked()) return [];
		const names = await fs.readdir(this.root);
		const warnings: string[] = [];
		for (const name of names) {
			if (!/^[a-f0-9]{64}\.(json|bak)$/.test(name)) continue;
			const filePath = path.join(this.root, name);
			let candidate: Candidate | undefined;
			try { candidate = await this.readCandidate(filePath, name.endsWith(".json") ? "primary" : "backup"); }
			catch (error) {
				pushWarning(warnings, `malformed LION progress sidecar ${name}: ${error instanceof Error ? error.message : String(error)}`);
				await this.quarantineInvalidUnlocked([{ filePath, reason: "malformed during cleanup" }]);
				continue;
			}
			if (!candidate) continue;
			const expectedHash = progressSidecarHash(this.namespace, candidate.envelope.run_id, candidate.envelope.incarnation_id);
			if (!name.startsWith(`${expectedHash}.`)) {
				pushWarning(warnings, `misplaced LION progress sidecar ${name} did not match its envelope identity`);
				await this.quarantineInvalidUnlocked([{ filePath, reason: "filename/envelope identity mismatch" }]);
				continue;
			}
			const run = ledger.get(candidate.envelope.run_id);
			const exactActive = run && isActiveLionStatus(run.status) && run.incarnation_id === candidate.envelope.incarnation_id;
			if (exactActive) continue;
			await this.assertSafeRootUnlocked();
			await fs.unlink(filePath).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
		}
		await this.boundQuarantineUnlocked();
		await fsyncDirectory(this.root).catch(() => undefined);
		return warnings;
	}

	private async ensureRootUnlocked(): Promise<void> {
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		if (!await this.assertSafeRootUnlocked()) throw new ProgressSidecarError(`progress sidecar root disappeared: ${this.root}`);
		await fs.chmod(this.root, 0o700);
	}

	private async assertSafeRootUnlocked(): Promise<boolean> {
		try {
			const stat = await fs.lstat(this.root);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProgressSidecarError(`lion progress sidecar rejects unsafe root ${this.root}`);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async readLatestExactUnlocked(ref: ExactRef): Promise<LatestResult> {
		if (!await this.assertSafeRootUnlocked()) return { warnings: [], invalid: [] };
		const { primary, backup } = this.paths(ref);
		const candidates: Candidate[] = [];
		const invalid: Array<{ filePath: string; reason: string }> = [];
		const warnings: string[] = [];
		for (const [filePath, kind] of [[primary, "primary"], [backup, "backup"]] as const) {
			try {
				const candidate = await this.readCandidate(filePath, kind, ref);
				if (candidate) candidates.push(candidate);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				invalid.push({ filePath, reason });
				pushWarning(warnings, `ignored malformed LION progress ${kind} for ${ref.id}/${ref.incarnation_id}: ${reason}`);
			}
		}
		candidates.sort((a, b) => b.envelope.sequence - a.envelope.sequence || (a.kind === "primary" ? -1 : 1));
		return { candidate: candidates[0], warnings, invalid };
	}

	private async readCandidate(filePath: string, kind: "primary" | "backup", ref?: ExactRef): Promise<Candidate | undefined> {
		let handle: fs.FileHandle;
		try { handle = await fs.open(filePath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		let raw: Buffer;
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new ProgressSidecarError(`sidecar artifact is not a regular file: ${filePath}`);
			if (stat.size > MAX_PROGRESS_ENVELOPE_BYTES) throw new ProgressSidecarError(`envelope exceeds ${MAX_PROGRESS_ENVELOPE_BYTES} bytes`);
			const bounded = Buffer.alloc(MAX_PROGRESS_ENVELOPE_BYTES + 1);
			const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
			if (bytesRead > MAX_PROGRESS_ENVELOPE_BYTES) throw new ProgressSidecarError(`envelope exceeds ${MAX_PROGRESS_ENVELOPE_BYTES} bytes`);
			raw = Buffer.from(bounded.subarray(0, bytesRead));
		} finally { await handle.close(); }
		this.counters.sidecar_reads++;
		this.counters.sidecar_bytes_read += raw.byteLength;
		return { envelope: parseEnvelope(raw, this.namespace, ref), raw, filePath, kind };
	}

	private async replaceUnlocked(ref: ExactRef, envelope: ProgressEnvelope, previous: Candidate): Promise<void> {
		const raw = Buffer.from(JSON.stringify(envelope));
		if (raw.byteLength > MAX_PROGRESS_ENVELOPE_BYTES) throw new ProgressSidecarError(`progress envelope exceeds ${MAX_PROGRESS_ENVELOPE_BYTES} bytes`);
		await this.ensureRootUnlocked();
		const { primary, backup } = this.paths(ref);
		await this.assertReplacementCapacityUnlocked(primary, backup, raw.byteLength, previous.raw.byteLength);
		await atomicWrite(backup, previous.raw);
		this.counters.sidecar_backups++;
		this.counters.sidecar_bytes_written += previous.raw.byteLength;
		await this.writePrimaryUnlocked(primary, raw);
	}

	private async writePrimaryUnlocked(primary: string, raw: Buffer): Promise<void> {
		await atomicWrite(primary, raw);
		this.counters.sidecar_writes++;
		this.counters.sidecar_bytes_written += raw.byteLength;
	}

	private async quarantineInvalidUnlocked(entries: Array<{ filePath: string; reason: string }>): Promise<void> {
		if (!entries.length) return;
		await this.ensureRootUnlocked();
		await fs.mkdir(this.quarantineRoot, { recursive: true, mode: 0o700 });
		await assertNotSymlink(this.quarantineRoot);
		for (const entry of entries) {
			try {
				const stat = await fs.lstat(entry.filePath);
				if (stat.isSymbolicLink()) { await fs.unlink(entry.filePath); continue; }
				const target = path.join(this.quarantineRoot, `${path.basename(entry.filePath)}-${Date.now()}-${randomUUID()}.bad`);
				await fs.rename(entry.filePath, target);
				await fs.chmod(target, 0o600);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		await this.boundQuarantineUnlocked();
		await fsyncDirectory(this.quarantineRoot).catch(() => undefined);
	}

	private async boundQuarantineUnlocked(): Promise<void> {
		let quarantineStat: Awaited<ReturnType<typeof fs.lstat>>;
		try { quarantineStat = await fs.lstat(this.quarantineRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) throw new ProgressSidecarError(`lion progress sidecar rejects unsafe quarantine ${this.quarantineRoot}`);
		const names = await fs.readdir(this.quarantineRoot);
		const entries = (await Promise.all(names.map(async (name) => {
			const filePath = path.join(this.quarantineRoot, name);
			try { const stat = await fs.lstat(filePath); return { filePath, mtime: stat.mtimeMs, size: stat.isFile() ? stat.size : 0 }; } catch { return null; }
		}))).filter((entry): entry is { filePath: string; mtime: number; size: number } => Boolean(entry)).sort((a, b) => b.mtime - a.mtime);
		let bytes = 0;
		for (let index = 0; index < entries.length; index++) {
			bytes += entries[index]!.size;
			if (index >= MAX_QUARANTINE_FILES || bytes > MAX_QUARANTINE_BYTES) await fs.unlink(entries[index]!.filePath).catch(() => undefined);
		}
	}

	private async assertReplacementCapacityUnlocked(primary: string, backup: string, primaryBytes: number, backupBytes: number): Promise<void> {
		const names = await fs.readdir(this.root);
		let files = 0;
		let bytes = 0;
		let oldPrimary = 0;
		let oldBackup = 0;
		for (const name of names) {
			const filePath = path.join(this.root, name);
			try {
				const stat = await fs.lstat(filePath);
				if (!stat.isFile()) continue;
				files++;
				bytes += stat.size;
				if (filePath === primary) oldPrimary = stat.size;
				if (filePath === backup) oldBackup = stat.size;
			} catch { /* capacity checks fail conservatively below when classified bytes are already full */ }
		}
		const projectedFiles = files + (oldPrimary ? 0 : 1) + (oldBackup ? 0 : 1);
		const projectedBytes = bytes - oldPrimary - oldBackup + primaryBytes + backupBytes;
		if (projectedFiles > MAX_SIDECAR_FILES || projectedBytes > MAX_SIDECAR_STORAGE_BYTES) {
			throw new ProgressSidecarError("progress sidecar capacity reached; classification cleanup is required before accepting more progress");
		}
	}

	private async assertCapacityUnlocked(): Promise<void> {
		let names: string[];
		try { names = await fs.readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (names.length >= MAX_SIDECAR_FILES) throw new ProgressSidecarError("progress sidecar capacity reached; cleanup is required before admitting another execution");
		let bytes = 0;
		for (const name of names) {
			try { const stat = await fs.lstat(path.join(this.root, name)); if (stat.isFile()) bytes += stat.size; } catch { /* classification remains conservative */ }
			if (bytes >= MAX_SIDECAR_STORAGE_BYTES) throw new ProgressSidecarError("progress sidecar byte capacity reached; cleanup is required before admitting another execution");
		}
	}
}
