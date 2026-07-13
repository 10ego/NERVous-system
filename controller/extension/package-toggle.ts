import * as fs from "node:fs";
import * as path from "node:path";
import { getPiAgentDir } from "@nervous-system/state";

export const CONTROL_EXTENSION = "controller/extension/index.ts";
export const ROOT_EXTENSIONS = [
	CONTROL_EXTENSION,
	"magi/extension/index.ts",
	"axon/extension/index.ts",
	"synapse/extension/index.ts",
	"cortex/extension/index.ts",
	"lion/extension/index.ts",
	"cerebel/extension/index.ts",
	"ganglion/extension/index.ts",
	"amygdala/extension/index.ts",
	"dashboard/extension/index.ts",
] as const;
export const ROOT_SKILLS = [
	"magi/skills/magi",
	"axon/skills/axon",
	"synapse/skills/synapse",
	"cortex/skills/cortex",
	"lion/skills/lion",
	"cerebel/skills/cerebel",
	"ganglion/skills/ganglion",
	"amygdala/skills/amygdala",
] as const;
export const ROOT_PROMPTS = [
	"magi/prompts",
	"cortex/prompts",
	"lion/prompts",
	"cerebel/prompts",
	"ganglion/prompts",
	"amygdala/prompts",
] as const;

interface PackageFilter {
	source: string;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}
type PackageSource = string | PackageFilter;
interface Settings { packages?: PackageSource[]; [key: string]: unknown }
interface Snapshot { version: 1; packages: Array<{ index: number; source: PackageSource }> }

function settingsPath(configDir: string): string {
	return path.join(configDir, "settings.json");
}

function snapshotPath(configDir: string): string {
	return path.join(configDir, "nervous.package-resources.json");
}

function readJson<T>(filePath: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, filePath);
}

function sourceOf(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

function isNervousPackage(entry: PackageSource, configDir: string): boolean {
	const source = sourceOf(entry).toLowerCase();
	if (/(?:^|[/:])nervous-system(?:@|$|[?#])/.test(source) || source.includes("/nervous-system.git")) return true;
	if (/^(?:npm:|git:|https?:|ssh:)/.test(source)) return false;
	try {
		const candidate = path.resolve(configDir, source);
		const packageJson = readJson<{ name?: unknown }>(path.join(candidate, "package.json"), {});
		return packageJson.name === "nervous-system";
	} catch {
		return false;
	}
}

function disabledSource(entry: PackageSource): PackageFilter {
	return { source: sourceOf(entry), extensions: [CONTROL_EXTENSION], skills: [], prompts: [] };
}

function validSnapshot(value: unknown): value is Snapshot {
	return typeof value === "object" && value !== null
		&& (value as { version?: unknown }).version === 1
		&& Array.isArray((value as { packages?: unknown }).packages)
		&& (value as { packages: unknown[] }).packages.every((item) =>
			typeof item === "object" && item !== null
			&& Number.isInteger((item as { index?: unknown }).index)
			&& (typeof (item as { source?: unknown }).source === "string" || typeof (item as { source?: unknown }).source === "object"),
		);
}

function findSettingsWithNervousPackage(agentDir: string, cwd?: string): { configDir: string; settings: Settings } | undefined {
	const candidates = [...(cwd ? [path.join(cwd, ".pi")] : []), agentDir];
	for (const configDir of candidates) {
		const settings = readJson<Settings>(settingsPath(configDir), {});
		if ((settings.packages ?? []).some((entry) => isNervousPackage(entry, configDir))) return { configDir, settings };
	}
	return undefined;
}

/**
 * Temporarily restrict the root package to the always-loaded control extension
 * and later restore its exact prior Pi package-resource selection. Returns true
 * only when settings changed and Pi must reload resources.
 */
export function setRootPackageEnabled(enabled: boolean, agentDir = getPiAgentDir(), cwd?: string): boolean {
	const target = findSettingsWithNervousPackage(agentDir, cwd);
	if (!target) {
		if (enabled) return false;
		throw new Error("Could not find the installed nervous-system package in Pi settings.");
	}
	const { configDir, settings } = target;
	const configPath = settingsPath(configDir);
	const packages = settings.packages ?? [];
	const snapshotFile = snapshotPath(configDir);
	const snapshot = readJson<unknown>(snapshotFile, undefined);

	if (!enabled) {
		if (validSnapshot(snapshot)) return false;
		const selected = packages
			.map((source, index) => ({ source, index }))
			.filter(({ source }) => isNervousPackage(source, configDir));
		writeJson(snapshotFile, { version: 1, packages: selected });
		for (const { index, source } of selected) packages[index] = disabledSource(source);
		settings.packages = packages;
		writeJson(configPath, settings);
		return true;
	}

	if (!validSnapshot(snapshot)) return false;
	for (const { index, source } of snapshot.packages) {
		if (index >= 0 && index < packages.length) packages[index] = source;
		else packages.push(source);
	}
	settings.packages = packages;
	writeJson(configPath, settings);
	fs.unlinkSync(snapshotFile);
	return true;
}
