import * as fs from "node:fs";
import * as path from "node:path";
import { getPiAgentDir } from "@nervous-system/state";

export const DEFAULT_CEREBEL_MAX_PARALLEL = 3;
export const MIN_CEREBEL_MAX_PARALLEL = 1;
export const MAX_CEREBEL_MAX_PARALLEL = 10;

function isConfiguredMaxParallel(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= MIN_CEREBEL_MAX_PARALLEL && Number(value) <= MAX_CEREBEL_MAX_PARALLEL;
}

/** Read the user-level default written by /nervous:config.
 *
 * This intentionally reads the compatibility field directly because the root
 * NERVous 1.x package remains compatible with @nervous-system/state@1.0.0,
 * whose normalizer knows only about model defaults.
 */
export function resolveConfiguredCerebelMaxParallel(agentDir = getPiAgentDir()): number {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "nervous.json"), "utf8")) as {
			cerebel?: { maxParallel?: unknown };
		};
		return isConfiguredMaxParallel(raw.cerebel?.maxParallel)
			? raw.cerebel.maxParallel
			: DEFAULT_CEREBEL_MAX_PARALLEL;
	} catch {
		return DEFAULT_CEREBEL_MAX_PARALLEL;
	}
}
