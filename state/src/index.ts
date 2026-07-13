import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	/** User-level root-suite setting. Omitted defaults to enabled and project overlays cannot change it. */
	enabled?: boolean;
	models: NervousModelConfig;
}

export interface NervousEnablement {
	enabled: boolean;
	source: "user" | "default";
	path?: string;
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
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
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

export function getNervousEnabled(config: NervousConfig): boolean | undefined {
	const normalized = normalizeNervousConfig(config);
	return hasEnabledSetting(normalized) ? normalized.enabled : undefined;
}

/**
 * Suite enablement is a user-level installation setting. Unlike model defaults,
 * it never accepts a project overlay because Pi package resources are resolved
 * before project extension code can safely change them.
 */
export function resolveNervousEnabled(resolution: NervousConfigResolution): NervousEnablement {
	if (hasEnabledSetting(resolution.user)) {
		return { enabled: resolution.user.enabled!, source: "user", path: resolution.userPath };
	}
	return { enabled: true, source: "default" };
}

export function applyNervousEnabledPatch(base: NervousConfig, enabled: boolean): NervousConfig {
	const next = normalizeNervousConfig(base);
	next.enabled = enabled;
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

function hasEnabledSetting(config: NervousConfig): boolean {
	return Object.prototype.hasOwnProperty.call(config, "enabled") && typeof config.enabled === "boolean";
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
