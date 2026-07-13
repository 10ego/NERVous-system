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
interface SettingsLocation {
	scope: "user" | "project";
	configDir: string;
	configPath: string;
	settings: Settings;
}
interface SnapshotEntry {
	scope: "user" | "project";
	configPath: string;
	index: number;
	source: PackageSource;
}
interface Snapshot { version: 2; packages: SnapshotEntry[] }

function settingsPath(configDir: string): string {
	return path.join(configDir, "settings.json");
}

function snapshotPath(agentDir: string): string {
	return path.join(agentDir, "nervous.package-resources.json");
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

function isDisabledSource(entry: PackageSource): boolean {
	return typeof entry === "object"
		&& entry.extensions?.length === 1
		&& entry.extensions[0] === CONTROL_EXTENSION
		&& entry.skills?.length === 0
		&& entry.prompts?.length === 0;
}

function validSnapshot(value: unknown): value is Snapshot {
	return typeof value === "object" && value !== null
		&& (value as { version?: unknown }).version === 2
		&& Array.isArray((value as { packages?: unknown }).packages)
		&& (value as { packages: unknown[] }).packages.every((item) =>
			typeof item === "object" && item !== null
			&& ((item as { scope?: unknown }).scope === "user" || (item as { scope?: unknown }).scope === "project")
			&& typeof (item as { configPath?: unknown }).configPath === "string"
			&& Number.isInteger((item as { index?: unknown }).index)
			&& (typeof (item as { source?: unknown }).source === "string" || typeof (item as { source?: unknown }).source === "object"),
		);
}

function configuredSettings(agentDir: string, cwd: string | undefined, projectTrusted: boolean): SettingsLocation[] {
	const userDir = agentDir;
	const user = { scope: "user" as const, configDir: userDir, configPath: settingsPath(userDir), settings: readJson<Settings>(settingsPath(userDir), {}) };
	if (!cwd || !projectTrusted) return [user];
	const projectDir = path.join(cwd, ".pi");
	return [
		user,
		{ scope: "project" as const, configDir: projectDir, configPath: settingsPath(projectDir), settings: readJson<Settings>(settingsPath(projectDir), {}) },
	];
}

function packageEntries(locations: SettingsLocation[]): Array<{ location: SettingsLocation; index: number; source: PackageSource }> {
	return locations.flatMap((location) => (location.settings.packages ?? [])
		.map((source, index) => ({ location, index, source }))
		.filter(({ source }) => isNervousPackage(source, location.configDir)));
}

function snapshotKey(configPath: string, index: number): string {
	return `${configPath}\u0000${index}`;
}

function writeLocations(locations: Iterable<SettingsLocation>): void {
	for (const location of locations) writeJson(location.configPath, location.settings);
}

function isDisabledSavedSource(candidate: PackageSource | undefined, saved: PackageSource): boolean {
	return candidate !== undefined && isDisabledSource(candidate) && sourceOf(candidate) === sourceOf(saved);
}

function restoreEntry(entry: SnapshotEntry, cwd: string | undefined, projectTrusted: boolean): boolean {
	if (entry.scope === "project" && (!cwd || !projectTrusted || path.resolve(path.dirname(entry.configPath)) !== path.resolve(path.join(cwd, ".pi")))) return false;
	const settings = readJson<Settings>(entry.configPath, {});
	const packages = settings.packages ?? [];
	const atSavedIndex = entry.index >= 0 && entry.index < packages.length ? packages[entry.index] : undefined;
	if (isDisabledSavedSource(atSavedIndex, entry.source)) {
		packages[entry.index] = entry.source;
	} else {
		const disabledIndex = packages.findIndex((candidate) => isDisabledSavedSource(candidate, entry.source));
		if (disabledIndex >= 0) {
			packages[disabledIndex] = entry.source;
		} else if (packages.some((candidate) => sourceOf(candidate) === sourceOf(entry.source))) {
			// Pi config changed this source while disabled; preserve the newer selection.
			return false;
		} else {
			packages.push(entry.source);
		}
	}
	settings.packages = packages;
	writeJson(entry.configPath, settings);
	return true;
}

/**
 * Restrict every Pi package source that can load the root NERVous suite, then
 * restore each source's exact prior resource selection when re-enabled. Only
 * trusted project settings participate, matching Pi's resource loader.
 */
export function setRootPackageEnabled(
	enabled: boolean,
	agentDir = getPiAgentDir(),
	cwd?: string,
	projectTrusted = false,
): boolean {
	const snapshotFile = snapshotPath(agentDir);
	const saved = readJson<unknown>(snapshotFile, undefined);
	const snapshot: Snapshot = validSnapshot(saved) ? saved : { version: 2, packages: [] };

	if (!enabled) {
		const locations = configuredSettings(agentDir, cwd, projectTrusted);
		const selected = packageEntries(locations);
		if (!selected.length) throw new Error("Could not find the installed nervous-system root package in active Pi settings.");

		const savedKeys = new Set(snapshot.packages.map((entry) => snapshotKey(entry.configPath, entry.index)));
		const changedLocations = new Set<SettingsLocation>();
		for (const { location, index, source } of selected) {
			const key = snapshotKey(location.configPath, index);
			if (!savedKeys.has(key)) snapshot.packages.push({ scope: location.scope, configPath: location.configPath, index, source });
			if (!isDisabledSource(source)) {
				(location.settings.packages ?? [])[index] = disabledSource(source);
				changedLocations.add(location);
			}
		}
		if (!changedLocations.size && validSnapshot(saved)) return false;
		writeJson(snapshotFile, snapshot);
		writeLocations(changedLocations);
		return true;
	}

	if (!validSnapshot(saved)) return false;
	const remaining: SnapshotEntry[] = [];
	let changed = false;
	for (const entry of snapshot.packages) {
		if (restoreEntry(entry, cwd, projectTrusted)) changed = true;
		else remaining.push(entry);
	}
	if (remaining.length) writeJson(snapshotFile, { version: 2, packages: remaining });
	else fs.unlinkSync(snapshotFile);
	return changed;
}
