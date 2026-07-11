import { loadNervousConfig, resolveNervousModel, type NervousModelKey } from "@nervous-system/state";
import { LION_RUNNER_MODES, type LionModelRole, type LionRunnerMode } from "./schema.ts";

function modelKeyForRole(role: LionModelRole): NervousModelKey {
	if (role === "review") return "lion.reviewDefault";
	if (role === "implementation") return "lion.implementationDefault";
	return "lion.default";
}

export function resolveConfiguredLionModel(cwd: string, isProjectTrusted: () => boolean, role: LionModelRole): string | undefined {
	const config = loadNervousConfig({ cwd, isProjectTrusted });
	const roleModel = resolveNervousModel(config, modelKeyForRole(role)).model;
	if (roleModel) return roleModel;
	if (role !== "default") return resolveNervousModel(config, "lion.default").model;
	return undefined;
}

function isRunnerMode(value: unknown): value is LionRunnerMode {
	return typeof value === "string" && (LION_RUNNER_MODES as readonly string[]).includes(value);
}

export function resolveLionRunnerMode(input?: string, environmentValue = process.env.LION_RUNNER): LionRunnerMode {
	const explicit = input?.trim();
	if (isRunnerMode(explicit)) return explicit;
	const env = environmentValue?.trim();
	return isRunnerMode(env) ? env : "json";
}
