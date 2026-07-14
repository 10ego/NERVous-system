import * as fs from "node:fs";
import * as path from "node:path";
import {
	applyNervousModelPatch as applyBaseNervousModelPatch,
	getPiAgentDir,
	loadNervousConfig as loadBaseNervousConfig,
	normalizeNervousConfig as normalizeBaseNervousConfig,
	readUserNervousConfig as readBaseUserNervousConfig,
	type NervousConfig,
	type NervousConfigResolution as BaseNervousConfigResolution,
	type NervousModelKey,
} from "@nervous-system/state";

/** Root-suite enablement is bundled here so root package 1.x remains usable
 * with the separately published @nervous-system/state@1.0.0 dependency. */
export interface NervousCerebelConfig {
	maxParallel?: number;
}

export type NervousConfigWithEnablement = NervousConfig & {
	enabled?: boolean;
	cerebel?: NervousCerebelConfig;
};
export type NervousConfigResolution = Omit<BaseNervousConfigResolution, "user" | "effective"> & {
	user: NervousConfigWithEnablement;
	effective: NervousConfigWithEnablement;
};

export const DEFAULT_CEREBEL_MAX_PARALLEL = 3;
export const MIN_CEREBEL_MAX_PARALLEL = 1;
export const MAX_CEREBEL_MAX_PARALLEL = 10;

function userConfigPath(agentDir = getPiAgentDir()): string {
	return path.join(agentDir, "nervous.json");
}

function validCerebelMaxParallel(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= MIN_CEREBEL_MAX_PARALLEL && Number(value) <= MAX_CEREBEL_MAX_PARALLEL;
}

function readRawControlConfig(agentDir?: string): Pick<NervousConfigWithEnablement, "enabled" | "cerebel"> {
	try {
		const raw = JSON.parse(fs.readFileSync(userConfigPath(agentDir), "utf8")) as { enabled?: unknown; cerebel?: { maxParallel?: unknown } };
		return {
			...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
			...(validCerebelMaxParallel(raw.cerebel?.maxParallel) ? { cerebel: { maxParallel: raw.cerebel.maxParallel } } : {}),
		};
	} catch {
		return {};
	}
}

export function readUserNervousConfig(agentDir?: string): NervousConfigWithEnablement {
	return { ...readBaseUserNervousConfig(agentDir), ...readRawControlConfig(agentDir) };
}

export function writeUserNervousConfig(config: NervousConfigWithEnablement, agentDir?: string): string {
	const filePath = userConfigPath(agentDir);
	const persisted: Record<string, unknown> = { ...normalizeBaseNervousConfig(config) };
	const enabled = config.enabled;
	const maxParallel = config.cerebel?.maxParallel;
	if (typeof enabled === "boolean") persisted.enabled = enabled;
	if (validCerebelMaxParallel(maxParallel)) persisted.cerebel = { maxParallel };

	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, filePath);
	} finally {
		try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup after failed writes */ }
	}
	return filePath;
}

export function applyNervousEnabledPatch(base: NervousConfigWithEnablement, enabled: boolean): NervousConfigWithEnablement {
	return { ...base, enabled };
}

export function applyNervousModelPatch(
	base: NervousConfigWithEnablement,
	patch: Partial<Record<NervousModelKey, string | null | undefined>>,
): NervousConfigWithEnablement {
	const patched = applyBaseNervousModelPatch(base, patch);
	return {
		...patched,
		...(typeof base.enabled === "boolean" ? { enabled: base.enabled } : {}),
		...(validCerebelMaxParallel(base.cerebel?.maxParallel) ? { cerebel: { maxParallel: base.cerebel.maxParallel } } : {}),
	};
}

export function applyNervousCerebelMaxParallelPatch(base: NervousConfigWithEnablement, maxParallel: number): NervousConfigWithEnablement {
	if (!validCerebelMaxParallel(maxParallel)) {
		throw new RangeError(`CEREBEL max_parallel must be an integer from ${MIN_CEREBEL_MAX_PARALLEL} through ${MAX_CEREBEL_MAX_PARALLEL}`);
	}
	return { ...base, cerebel: { ...base.cerebel, maxParallel } };
}

export function loadNervousConfig(opts: Parameters<typeof loadBaseNervousConfig>[0]): NervousConfigResolution {
	const resolution = loadBaseNervousConfig(opts);
	const user = readUserNervousConfig(opts.agentDir);
	return {
		...resolution,
		user,
		effective: {
			...resolution.effective,
			...(typeof user.enabled === "boolean" ? { enabled: user.enabled } : {}),
			...(validCerebelMaxParallel(user.cerebel?.maxParallel) ? { cerebel: { maxParallel: user.cerebel.maxParallel } } : {}),
		},
	};
}

export function resolveNervousEnabled(resolution: NervousConfigResolution): { enabled: boolean; source: "user" | "default"; path?: string } {
	if (typeof resolution.user.enabled === "boolean") return { enabled: resolution.user.enabled, source: "user", path: resolution.userPath };
	return { enabled: true, source: "default" };
}

export function resolveNervousCerebelMaxParallel(resolution: NervousConfigResolution): { maxParallel: number; source: "user" | "default"; path?: string } {
	const maxParallel = resolution.user.cerebel?.maxParallel;
	if (validCerebelMaxParallel(maxParallel)) return { maxParallel, source: "user", path: resolution.userPath };
	return { maxParallel: DEFAULT_CEREBEL_MAX_PARALLEL, source: "default" };
}
