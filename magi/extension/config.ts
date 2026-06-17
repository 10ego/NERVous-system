/**
 * MAGI — council configuration: defaults, validation, and resolution.
 *
 * The councillor JSON config is the single source of truth for the council.
 * This module is intentionally pure (only `node:fs`/`node:path` + the pi helper
 * `getAgentDir`) so it can be unit-tested without spawning anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CouncilConfig, Councillor } from "./schema.ts";

/* -------------------------------------------------------------------------- */
/* Hard limits                                                                 */
/* -------------------------------------------------------------------------- */

/** MAGI councils may have at most this many councillors. */
export const MAX_COUNCILLORS = 3;
/** MAGI councils must have at least this many councillors. */
export const MIN_COUNCILLORS = 1;

/* -------------------------------------------------------------------------- */
/* Default councillors (Mind, Heart, Hand)                                     */
/* -------------------------------------------------------------------------- */

export const MIND: Councillor = {
	id: "mind",
	name: "The Analytical Critic",
	symbol: "The Mind",
	archetype: "Exacting Realist / Devil's Advocate",
	core_trait: "Uncompromising, hyper-precise, and emotionally detached.",
	role:
		"Strips away emotion to dissect the cold facts of the issue. Anticipates worst-case scenarios, " +
		"identifies logical fallacies, exposes weak assumptions, and rejects subpar or lazy solutions instantly.",
	danger_prevented: "Groupthink, blind optimism, and sloppy execution.",
	tools: ["read", "grep", "find", "ls"],
};

export const HEART: Councillor = {
	id: "heart",
	name: "The Empathetic Sage",
	symbol: "The Heart",
	archetype: "Long-term Thinker",
	core_trait: "Deeply understanding and user-centric.",
	role:
		"Focuses on the human element and long-term impact. Advocates for the end user, maintainability, " +
		"extensibility, future developer experience, and decisions that remain healthy over time.",
	danger_prevented: "Detachment from human reality, short-term thinking, and technically correct but user-hostile decisions.",
	tools: ["read", "grep", "find", "ls"],
};

export const HAND: Councillor = {
	id: "hand",
	name: "The Pragmatic Strategist",
	symbol: "The Hand",
	archetype: "The Architect / The Decisive Realist",
	core_trait: "Action-oriented, resourceful, and highly practical.",
	role:
		"Bridges The Mind and The Heart. Asks 'how do we actually execute this?' Focuses on timing, resources, " +
		"tradeoffs, sequencing, implementation cost, and the middle ground required to move forward. Leads synthesis.",
	danger_prevented: "Endless debate, overengineering, paralysis, and plans that cannot realistically be executed.",
	tools: ["read", "grep", "find", "ls"],
};

export const DEFAULT_COUNCILLORS: Councillor[] = [MIND, HEART, HAND];

export const DEFAULT_CONFIG: CouncilConfig = {
	version: 1,
	name: "default",
	synthesizer: "hand",
	critique: true,
	councillors: DEFAULT_COUNCILLORS,
};

/** A minimal single-councillor council (Mind only). */
export const ONE_CONFIG: CouncilConfig = {
	version: 1,
	name: "one",
	synthesizer: "mind",
	critique: false,
	councillors: [MIND],
};

/** A two-councillor council (Mind + Hand). */
export const TWO_CONFIG: CouncilConfig = {
	version: 1,
	name: "two",
	synthesizer: "hand",
	critique: true,
	councillors: [MIND, HAND],
};

/** Built-in presets resolvable by name. */
export const PRESETS: Record<string, CouncilConfig> = {
	default: DEFAULT_CONFIG,
	three: DEFAULT_CONFIG,
	two: TWO_CONFIG,
	one: ONE_CONFIG,
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	/** Normalized config (defaults applied, e.g. synthesizer/critique). */
	config: CouncilConfig;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate a council config.
 *
 * Enforces the core MAGI invariant: between 1 and 3 councillors. Configurations
 * with more than 3 councillors are rejected.
 */
export function validateCouncilConfig(input: CouncilConfig): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!Array.isArray(input.councillors)) {
		return {
			valid: false,
			errors: ["`councillors` must be an array."],
			warnings,
			config: { ...input, councillors: [] },
		};
	}

	const count = input.councillors.length;
	if (count < MIN_COUNCILLORS) {
		errors.push(`MAGI requires at least ${MIN_COUNCILLORS} councillor.`);
	}
	if (count > MAX_COUNCILLORS) {
		errors.push(
			`MAGI rejects configurations with more than ${MAX_COUNCILLORS} councillors ` +
				`(got ${count}). Reduce the council to at most ${MAX_COUNCILLORS}.`,
		);
	}

	// Per-councillor + uniqueness checks.
	const seen = new Set<string>();
	for (let i = 0; i < input.councillors.length; i++) {
		const c = input.councillors[i];
		if (!c) continue;
		const where = `councillors[${i}]`;
		if (!c.id || typeof c.id !== "string") {
			errors.push(`${where}: missing required string \`id\`.`);
		} else if (!ID_RE.test(c.id)) {
			errors.push(`${where}: id "${c.id}" must be lowercase letters/numbers/hyphens/underscores.`);
		} else if (seen.has(c.id)) {
			errors.push(`${where}: duplicate councillor id "${c.id}".`);
		} else {
			seen.add(c.id);
		}
		if (!c.name || !String(c.name).trim()) errors.push(`${where}: missing required \`name\`.`);
		if (!c.role || !String(c.role).trim()) errors.push(`${where}: missing required \`role\`.`);
	}

	// Synthesizer defaulting + existence check.
	const ids = input.councillors.map((c) => c?.id).filter((id): id is string => typeof id === "string");
	let synthesizer = input.synthesizer;
	if (!synthesizer) {
		synthesizer = ids.includes("hand") ? "hand" : (ids[ids.length - 1] ?? "");
	}
	if (synthesizer && ids.length > 0 && !ids.includes(synthesizer)) {
		errors.push(
			`synthesizer "${synthesizer}" is not a member of the council (available: ${ids.join(", ") || "none"}).`,
		);
	}

	// Critique defaulting: on when >= 2 councillors, off for a solo council.
	const critique = input.critique ?? ids.length >= 2;
	if (input.critique === true && ids.length < 2) {
		warnings.push("critique was enabled but there is only one councillor; critique round will be skipped.");
	}

	const config: CouncilConfig = {
		...input,
		synthesizer,
		critique,
		councillors: input.councillors,
	};

	return { valid: errors.length === 0, errors, warnings, config };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolveOptions {
	cwd: string;
	/** Directory containing the bundled default configs (the package's config/). */
	bundledConfigDir: string;
}

export interface ResolvedCouncil {
	config: CouncilConfig;
	source: string;
	warnings: string[];
}

function readJsonFile(filePath: string): unknown | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asCouncilConfig(v: unknown): CouncilConfig | null {
	if (!isObject(v) || !Array.isArray(v.councillors)) return null;
	return v as unknown as CouncilConfig;
}

/**
 * Resolve a council config from a "spec" string, with this precedence:
 *   1. Preset name ('default' | 'three' | 'two' | 'one')
 *   2. Inline JSON (starts with '{')
 *   3. Path to a council JSON file
 *   4. Project config: <cwd>/.pi/magi/council.json
 *   5. User config:    ~/.pi/agent/magi/council.json
 *   6. Bundled default config
 *
 * The result is always validated; invalid configs throw.
 */
export function resolveCouncil(spec: string | undefined, opts: ResolveOptions): ResolvedCouncil {
	const candidates: Array<{ config: CouncilConfig; source: string }> = [];

	const preset = spec ? PRESETS[spec.toLowerCase()] : undefined;
	if (preset) candidates.push({ config: preset, source: `preset:${spec!.toLowerCase()}` });

	if (spec && spec.trim().startsWith("{")) {
		const parsed = asCouncilConfig(JSON.parse(spec));
		if (parsed) candidates.push({ config: parsed, source: "inline-json" });
	}

	if (spec && !preset && !spec.trim().startsWith("{")) {
		// Treat as a path (absolute, or relative to cwd).
		const resolved = path.isAbsolute(spec) ? spec : path.resolve(opts.cwd, spec);
		const fromFile = readJsonFile(resolved);
		const parsed = asCouncilConfig(fromFile);
		if (parsed) candidates.push({ config: parsed, source: `file:${resolved}` });
	}

	// Project config.
	const projectPath = path.join(opts.cwd, ".pi", "magi", "council.json");
	const projectParsed = asCouncilConfig(readJsonFile(projectPath));
	if (projectParsed) candidates.push({ config: projectParsed, source: `project:${projectPath}` });

	// User config.
	const userPath = path.join(getAgentDir(), "magi", "council.json");
	const userParsed = asCouncilConfig(readJsonFile(userPath));
	if (userParsed) candidates.push({ config: userParsed, source: `user:${userPath}` });

	// Bundled default.
	const bundledParsed = asCouncilConfig(
		readJsonFile(path.join(opts.bundledConfigDir, "council.default.json")),
	);
	const bundled = bundledParsed ?? DEFAULT_CONFIG;
	candidates.push({ config: bundled, source: "bundled:default" });

	const chosen = candidates[0];
	if (!chosen) {
		throw new Error("MAGI could not resolve any council configuration.");
	}

	const result = validateCouncilConfig(chosen.config);
	if (!result.valid) {
		throw new Error(`Invalid MAGI council config (${chosen.source}): ${result.errors.join(" ")}`);
	}

	return { config: result.config, source: chosen.source, warnings: result.warnings };
}
