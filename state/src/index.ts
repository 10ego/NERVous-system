import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface NervousStateInfo {
	root: string;
	project: string;
	context: string;
	component: string;
	filePath: string;
}

const PI_CONFIG_DIR_NAME = ".pi";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const NERVOUS_CONFIG_FILENAME = "nervous.json";

export const NERVOUS_DASHBOARD_RECORD_LIMIT = 100;
export const NERVOUS_DEFAULT_SYNAPSE_TTL_MS = 24 * 60 * 60 * 1000;
export const NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES = 1000;

export const NERVOUS_STATE_COMPONENTS = [
	{ component: "cortex", filename: "cortex.json", env: "CORTEX_PATH", collection: "goals", terminal: ["completed", "cancelled"] },
	{ component: "magi", filename: "history.json", env: "MAGI_HISTORY_PATH", collection: "records", terminal: [] },
	{ component: "axon", filename: "ledger.json", env: "AXON_LEDGER_PATH", collection: "tasks", terminal: ["completed", "failed", "cancelled"] },
	{ component: "synapse", filename: "synapse.json", env: "SYNAPSE_PATH", collection: "notes", terminal: [] },
	{ component: "lion", filename: "runs.json", env: "LION_RUNS_PATH", collection: "runs", terminal: ["completed", "blocked", "failed", "aborted"] },
	{ component: "cerebel", filename: "cerebel.json", env: "CEREBEL_PATH", collection: "waves", terminal: ["completed", "cancelled"] },
	{ component: "ganglion", filename: "ganglion.json", env: "GANGLION_PATH", collection: "ganglions", terminal: ["completed", "cancelled"] },
	{ component: "amygdala", filename: "amygdala.json", env: "AMYGDALA_PATH", collection: "incidents", terminal: ["resolved", "accepted"] },
] as const;

export type NervousStateComponent = (typeof NERVOUS_STATE_COMPONENTS)[number]["component"];

export interface NervousStateFileSnapshot {
	component: NervousStateComponent;
	filePath: string;
	source: "namespace" | "override";
	exists: boolean;
	bytes: number;
	updatedAt?: string;
	recordCount?: number;
	openRecordCount?: number;
	parseError?: string;
}

export interface NervousContextSnapshot {
	root: string;
	project: string;
	context: string;
	projectDir: string;
	contextDir: string;
	files: NervousStateFileSnapshot[];
	totalBytes: number;
	otherContexts: string[];
	archiveCount: number;
	synapseRetention: { ttlMs: number; maxNotes: number };
}

export const NERVOUS_MODEL_KEYS = [
	"lion.default",
	"lion.implementationDefault",
	"lion.reviewDefault",
	"magi.councillorDefault",
	"magi.synthesisDefault",
] as const;
export type NervousModelKey = (typeof NERVOUS_MODEL_KEYS)[number];
export type NervousModelValue = string | null;

export interface NervousModelConfig {
	lion?: {
		default?: NervousModelValue;
		implementationDefault?: NervousModelValue;
		reviewDefault?: NervousModelValue;
	};
	magi?: { councillorDefault?: NervousModelValue; synthesisDefault?: NervousModelValue };
}

export interface NervousConfig {
	version: number;
	models: NervousModelConfig;
}

export interface NervousConfigResolution {
	user: NervousConfig;
	project: NervousConfig;
	effective: NervousConfig;
	userPath: string;
	projectPath: string;
	projectTrusted: boolean;
	projectLoaded: boolean;
}

export interface LoadNervousConfigOptions {
	cwd: string;
	/** Overrides the default ~/.pi/agent lookup; useful in tests. */
	agentDir?: string;
	/** Project config is read only when trusted. Accepts a boolean or a lazy trust check. */
	isProjectTrusted?: boolean | (() => boolean);
}

export function resolveNervousStateFile(
	cwd: string,
	component: string,
	filename: string,
	explicitEnvName?: string,
): string {
	const explicit = explicitEnvName ? process.env[explicitEnvName] : undefined;
	if (explicit && path.isAbsolute(explicit)) return explicit;
	return resolveNervousStateInfo(cwd, component, filename).filePath;
}

export function resolveNervousStateInfo(cwd: string, component: string, filename: string): NervousStateInfo {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const context = resolveContextSlug(cwd);
	const filePath = path.join(root, project, context, component, filename);
	return { root, project, context, component, filePath };
}

export function resolveRoot(): string {
	const configured = process.env.NERVOUS_STATE_ROOT;
	return configured ? path.resolve(configured) : path.join(homedir(), PI_CONFIG_DIR_NAME, "nervous");
}

/**
 * Read-only inventory for the active project/context namespace. This deliberately
 * parses only enough structure to explain retention and volume; component stores
 * remain the semantic validators for their own durable schemas.
 */
export async function inspectNervousContext(cwd: string): Promise<NervousContextSnapshot> {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const context = resolveContextSlug(cwd);
	const projectDir = path.join(root, project);
	const contextDir = path.join(projectDir, context);
	const files = await Promise.all(NERVOUS_STATE_COMPONENTS.map((definition) => inspectStateFile(cwd, definition)));
	const entries = await readDirectoryNames(projectDir);
	const otherContexts = entries
		.filter((entry) => entry !== context && entry !== ".archive")
		.sort();
	const archives = await readDirectoryNames(path.join(projectDir, ".archive"));
	return {
		root,
		project,
		context,
		projectDir,
		contextDir,
		files,
		totalBytes: files.reduce((total, file) => total + file.bytes, 0),
		otherContexts,
		archiveCount: archives.length,
		synapseRetention: {
			ttlMs: nonNegativeEnvNumber("SYNAPSE_TTL_MS", NERVOUS_DEFAULT_SYNAPSE_TTL_MS),
			maxNotes: nonNegativeEnvNumber("SYNAPSE_MAX_NOTES", NERVOUS_DEFAULT_SYNAPSE_MAX_NOTES),
		},
	};
}

export function formatNervousStateReport(snapshot: NervousContextSnapshot): string {
	const ttl = snapshot.synapseRetention.ttlMs === 0 ? "no TTL" : formatDuration(snapshot.synapseRetention.ttlMs);
	const cap = snapshot.synapseRetention.maxNotes === 0 ? "no count cap" : `${snapshot.synapseRetention.maxNotes} notes`;
	const lines = [
		"# NERVous state",
		`- Namespace: \`${snapshot.project}/${snapshot.context}\``,
		`- Active directory: \`${snapshot.contextDir}\``,
		`- Canonical state size: ${formatBytes(snapshot.totalBytes)}`,
		"",
		"## Retention",
		"- CORTEX, MAGI, AXON, LION, CEREBEL, GANGLION, and AMYGDALA are durable: they have no TTL and remain until the whole context is explicitly reset.",
		`- SYNAPSE is transient: ${ttl}, ${cap}; expiry is applied on its next mutation or explicit prune.`,
		`- Dashboard/list limits only display up to ${NERVOUS_DASHBOARD_RECORD_LIMIT} recent records; they do not delete stored data.`,
		"",
		"## Active files",
	];
	for (const file of snapshot.files) {
		if (!file.exists) {
			lines.push(`- ${file.component.toUpperCase()}: empty (${file.source})`);
			continue;
		}
		const records = file.recordCount === undefined ? "records unknown" : `${file.recordCount} record(s)`;
		const open = file.openRecordCount === undefined ? "" : `, ${file.openRecordCount} open`;
		const invalid = file.parseError ? `, unreadable JSON: ${file.parseError}` : "";
		lines.push(`- ${file.component.toUpperCase()}: ${records}${open}, ${formatBytes(file.bytes)}, ${file.source}${file.updatedAt ? `, updated ${file.updatedAt}` : ""}${invalid}`);
	}
	lines.push(
		"",
		`Other work contexts: ${snapshot.otherContexts.length}${snapshot.otherContexts.length ? ` (${snapshot.otherContexts.join(", ")})` : ""}.`,
		`Reset archives: ${snapshot.archiveCount}.`,
		"Use a distinct `NERVOUS_CONTEXT` for concurrently resumable work. Use `/nervous:reset` when this namespace should start clean.",
	);
	return lines.join("\n");
}

export function getPiAgentDir(): string {
	const configured = process.env[PI_AGENT_DIR_ENV];
	return configured ? expandTilde(configured) : path.join(homedir(), PI_CONFIG_DIR_NAME, "agent");
}

export function userNervousConfigPath(agentDir = getPiAgentDir()): string {
	return path.join(agentDir, NERVOUS_CONFIG_FILENAME);
}

export function projectNervousConfigPath(cwd: string): string {
	return path.join(resolveProjectConfigRoot(cwd), PI_CONFIG_DIR_NAME, NERVOUS_CONFIG_FILENAME);
}

export function resolveProjectConfigRoot(cwd: string): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]) ?? canonicalPath(cwd);
}

export function emptyNervousConfig(): NervousConfig {
	return { version: 1, models: { lion: {}, magi: {} } };
}

export function readNervousConfigFile(filePath: string): NervousConfig {
	try {
		if (!existsSync(filePath)) return emptyNervousConfig();
		return normalizeNervousConfig(JSON.parse(readFileSync(filePath, "utf8")));
	} catch {
		return emptyNervousConfig();
	}
}

export function readUserNervousConfig(agentDir?: string): NervousConfig {
	return readNervousConfigFile(userNervousConfigPath(agentDir));
}

export function writeUserNervousConfig(config: NervousConfig, agentDir?: string): string {
	const filePath = userNervousConfigPath(agentDir);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(normalizeNervousConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return filePath;
}

export function loadNervousConfig(opts: LoadNervousConfigOptions): NervousConfigResolution {
	const userPath = userNervousConfigPath(opts.agentDir);
	const projectPath = projectNervousConfigPath(opts.cwd);
	const user = readNervousConfigFile(userPath);
	const projectTrusted = trusted(opts.isProjectTrusted);
	const projectLoaded = projectTrusted && existsSync(projectPath);
	const project = projectLoaded ? readNervousConfigFile(projectPath) : emptyNervousConfig();
	return {
		user,
		project,
		effective: mergeNervousConfigs(user, projectLoaded ? project : emptyNervousConfig()),
		userPath,
		projectPath,
		projectTrusted,
		projectLoaded,
	};
}

export function normalizeNervousConfig(raw: unknown): NervousConfig {
	const out = emptyNervousConfig();
	if (!isPlainObject(raw)) return out;
	if (typeof raw.version === "number" && Number.isFinite(raw.version)) out.version = Math.floor(raw.version);
	const models = isPlainObject(raw.models) ? raw.models : {};
	for (const key of NERVOUS_MODEL_KEYS) {
		const value = readModelValue(models, key);
		if (value !== undefined) setModelValue(out.models, key, value);
	}
	return out;
}

export function mergeNervousConfigs(base: NervousConfig, overlay: NervousConfig): NervousConfig {
	const next = normalizeNervousConfig(base);
	const o = normalizeNervousConfig(overlay);
	for (const key of NERVOUS_MODEL_KEYS) {
		if (!hasModelKey(o.models, key)) continue;
		const value = readModelValue(o.models, key);
		if (typeof value === "string") setModelValue(next.models, key, value);
		else clearModelValue(next.models, key);
	}
	return next;
}

export function getNervousModel(config: NervousConfig, key: NervousModelKey): string | undefined {
	const value = readModelValue(normalizeNervousConfig(config).models, key);
	return typeof value === "string" ? value : undefined;
}

export function resolveNervousModel(resolution: NervousConfigResolution, key: NervousModelKey): { model?: string; source: "project" | "user" | "default"; path?: string } {
	const projectModel = resolution.projectLoaded ? getNervousModel(resolution.project, key) : undefined;
	if (projectModel) return { model: projectModel, source: "project", path: resolution.projectPath };
	const userModel = getNervousModel(resolution.user, key);
	if (userModel && !projectExplicitlyUnsets(resolution, key)) return { model: userModel, source: "user", path: resolution.userPath };
	return { source: "default" };
}

export function applyNervousModelPatch(
	base: NervousConfig,
	patch: Partial<Record<NervousModelKey, string | null | undefined>>,
): NervousConfig {
	const next = normalizeNervousConfig(base);
	for (const key of NERVOUS_MODEL_KEYS) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (typeof value === "string" && value.trim()) setModelValue(next.models, key, value.trim());
		else clearModelValue(next.models, key);
	}
	return next;
}

export function resolveProjectSlug(cwd: string): string {
	const configured = process.env.NERVOUS_PROJECT;
	if (configured?.trim()) return slug(configured, "project");
	const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? canonicalPath(cwd);
	const name = path.basename(root) || "project";
	return `${slug(name, "project")}-${hash(root)}`;
}

export function resolveContextSlug(cwd: string): string {
	const configured = process.env.NERVOUS_CONTEXT;
	if (configured?.trim()) return slug(configured, "default");
	const branch = git(cwd, ["branch", "--show-current"]);
	if (branch?.trim()) return slug(branch, "default");
	const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
	if (sha?.trim()) return `detached-${slug(sha, "head")}`;
	return "default";
}

export function slug(input: string, fallback: string): string {
	const s = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return s || fallback;
}

function canonicalPath(cwd: string): string {
	const resolved = path.resolve(cwd);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function trusted(check: boolean | (() => boolean) | undefined): boolean {
	try {
		return typeof check === "function" ? Boolean(check()) : Boolean(check);
	} catch {
		return false;
	}
}

function expandTilde(input: string): string {
	return input === "~" || input.startsWith(`~${path.sep}`) ? path.join(homedir(), input.slice(2)) : path.resolve(input);
}

function modelValue(raw: unknown): NervousModelValue | undefined {
	if (raw === null) return null;
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed ? trimmed : null;
}

function readModelValue(models: NervousModelConfig | Record<string, unknown>, key: NervousModelKey): NervousModelValue | undefined {
	switch (key) {
		case "lion.default":
			return modelValue(isPlainObject(models.lion) ? models.lion.default : undefined);
		case "lion.implementationDefault":
			return modelValue(isPlainObject(models.lion) ? models.lion.implementationDefault : undefined);
		case "lion.reviewDefault":
			return modelValue(isPlainObject(models.lion) ? models.lion.reviewDefault : undefined);
		case "magi.councillorDefault":
			return modelValue(isPlainObject(models.magi) ? models.magi.councillorDefault : undefined);
		case "magi.synthesisDefault":
			return modelValue(isPlainObject(models.magi) ? models.magi.synthesisDefault : undefined);
	}
}

function hasModelKey(models: NervousModelConfig, key: NervousModelKey): boolean {
	switch (key) {
		case "lion.default":
			return Object.prototype.hasOwnProperty.call(models.lion ?? {}, "default");
		case "lion.implementationDefault":
			return Object.prototype.hasOwnProperty.call(models.lion ?? {}, "implementationDefault");
		case "lion.reviewDefault":
			return Object.prototype.hasOwnProperty.call(models.lion ?? {}, "reviewDefault");
		case "magi.councillorDefault":
			return Object.prototype.hasOwnProperty.call(models.magi ?? {}, "councillorDefault");
		case "magi.synthesisDefault":
			return Object.prototype.hasOwnProperty.call(models.magi ?? {}, "synthesisDefault");
	}
}

function setModelValue(models: NervousModelConfig, key: NervousModelKey, value: NervousModelValue): void {
	switch (key) {
		case "lion.default":
			models.lion ??= {};
			models.lion.default = value;
			return;
		case "lion.implementationDefault":
			models.lion ??= {};
			models.lion.implementationDefault = value;
			return;
		case "lion.reviewDefault":
			models.lion ??= {};
			models.lion.reviewDefault = value;
			return;
		case "magi.councillorDefault":
			models.magi ??= {};
			models.magi.councillorDefault = value;
			return;
		case "magi.synthesisDefault":
			models.magi ??= {};
			models.magi.synthesisDefault = value;
			return;
	}
}

function clearModelValue(models: NervousModelConfig, key: NervousModelKey): void {
	switch (key) {
		case "lion.default":
			if (models.lion) delete models.lion.default;
			return;
		case "lion.implementationDefault":
			if (models.lion) delete models.lion.implementationDefault;
			return;
		case "lion.reviewDefault":
			if (models.lion) delete models.lion.reviewDefault;
			return;
		case "magi.councillorDefault":
			if (models.magi) delete models.magi.councillorDefault;
			return;
		case "magi.synthesisDefault":
			if (models.magi) delete models.magi.synthesisDefault;
			return;
	}
}

function projectExplicitlyUnsets(resolution: NervousConfigResolution, key: NervousModelKey): boolean {
	return resolution.projectLoaded && hasModelKey(resolution.project.models, key) && !getNervousModel(resolution.project, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectStateFile(
	cwd: string,
	definition: (typeof NERVOUS_STATE_COMPONENTS)[number],
): Promise<NervousStateFileSnapshot> {
	const override = process.env[definition.env];
	const filePath = resolveNervousStateFile(cwd, definition.component, definition.filename, definition.env);
	const source = override && path.isAbsolute(override) ? "override" as const : "namespace" as const;
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { component: definition.component, filePath, source, exists: false, bytes: 0 };
		return { component: definition.component, filePath, source, exists: true, bytes: 0, parseError: boundedError(error) };
	}
	const snapshot: NervousStateFileSnapshot = { component: definition.component, filePath, source, exists: true, bytes: stat.size };
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
		if (!isPlainObject(parsed)) throw new Error("top-level value is not an object");
		const meta = isPlainObject(parsed.meta) ? parsed.meta : undefined;
		const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : typeof meta?.updated_at === "string" ? meta.updated_at : undefined;
		if (updatedAt) snapshot.updatedAt = updatedAt;
		const collection = parsed[definition.collection];
		const records = Array.isArray(collection) ? collection : isPlainObject(collection) ? Object.values(collection) : undefined;
		if (records) {
			snapshot.recordCount = records.length;
			if (definition.terminal.length > 0) {
				const terminal = new Set<string>(definition.terminal);
				snapshot.openRecordCount = records.filter((record) => !isPlainObject(record) || typeof record.status !== "string" || !terminal.has(record.status)).length;
			}
		}
	} catch (error) {
		snapshot.parseError = boundedError(error);
	}
	return snapshot;
}

async function readDirectoryNames(dir: string): Promise<string[]> {
	try {
		return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
}

function nonNegativeEnvNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || !Number.isFinite(Number(raw))) return fallback;
	return Math.max(0, Number(raw));
}

function boundedError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(ms: number): string {
	if (ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)}d TTL`;
	if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h TTL`;
	if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m TTL`;
	return `${ms}ms TTL`;
}

function hash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}
