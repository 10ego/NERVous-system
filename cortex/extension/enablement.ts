import * as fs from "node:fs";
import * as path from "node:path";
import {
	applyNervousModelPatch as applyBaseNervousModelPatch,
	getPiAgentDir,
	loadNervousConfig as loadBaseNervousConfig,
	readUserNervousConfig as readBaseUserNervousConfig,
	writeUserNervousConfig as writeBaseUserNervousConfig,
	type NervousConfig,
	type NervousConfigResolution as BaseNervousConfigResolution,
	type NervousModelKey,
} from "@nervous-system/state";

/** Root-suite enablement is bundled here so root package 1.x remains usable
 * with the separately published @nervous-system/state@1.0.0 dependency. */
export type NervousConfigWithEnablement = NervousConfig & { enabled?: boolean };
export type NervousConfigResolution = Omit<BaseNervousConfigResolution, "user" | "effective"> & {
	user: NervousConfigWithEnablement;
	effective: NervousConfigWithEnablement;
};

function userConfigPath(agentDir = getPiAgentDir()): string {
	return path.join(agentDir, "nervous.json");
}

function readRawEnabled(agentDir?: string): boolean | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(userConfigPath(agentDir), "utf8")) as { enabled?: unknown };
		return typeof raw.enabled === "boolean" ? raw.enabled : undefined;
	} catch {
		return undefined;
	}
}

export function readUserNervousConfig(agentDir?: string): NervousConfigWithEnablement {
	const config = readBaseUserNervousConfig(agentDir);
	const enabled = readRawEnabled(agentDir);
	return enabled === undefined ? config : { ...config, enabled };
}

export function writeUserNervousConfig(config: NervousConfigWithEnablement, agentDir?: string): string {
	const filePath = writeBaseUserNervousConfig(config, agentDir);
	const enabled = config.enabled;
	if (typeof enabled !== "boolean") return filePath;
	const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
	persisted.enabled = enabled;
	fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
	return typeof base.enabled === "boolean" ? { ...patched, enabled: base.enabled } : patched;
}

export function loadNervousConfig(opts: Parameters<typeof loadBaseNervousConfig>[0]): NervousConfigResolution {
	const resolution = loadBaseNervousConfig(opts);
	const user = readUserNervousConfig(opts.agentDir);
	return { ...resolution, user, effective: { ...resolution.effective, ...(typeof user.enabled === "boolean" ? { enabled: user.enabled } : {}) } };
}

export function resolveNervousEnabled(resolution: NervousConfigResolution): { enabled: boolean; source: "user" | "default"; path?: string } {
	if (typeof resolution.user.enabled === "boolean") return { enabled: resolution.user.enabled, source: "user", path: resolution.userPath };
	return { enabled: true, source: "default" };
}
