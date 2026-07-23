import { loadNervousConfig, resolveNervousModel } from "@nervous-system/state";
import { LION_RUNNER_MODES, type LionModelRole, type LionRunnerMode } from "./schema.ts";

/** All LION roles share one configured default; fallback is used only when it is unset. */
export function resolveConfiguredLionModel(cwd: string, isProjectTrusted: () => boolean, _role: LionModelRole): string | undefined {
	const config = loadNervousConfig({ cwd, isProjectTrusted });
	return resolveNervousModel(config, "lion.default").model
		?? resolveNervousModel(config, "lion.fallback").model;
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
