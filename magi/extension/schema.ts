/**
 * MAGI — schemas and data models.
 *
 * Councillor / council configuration, the deliberation input, and the
 * structured output contract that MAGI returns to CORTEX.
 *
 * This module is dependency-light on purpose: it exports plain TypeScript
 * interfaces (used by the pure deliberation core) and TypeBox schemas (used
 * by the extension for tool-parameter validation and runtime coercion).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export const ConfidenceSchema = StringEnum(CONFIDENCE_VALUES, {
	description: "How confident the council is in the final recommendation.",
});

/* -------------------------------------------------------------------------- */
/* Councillor + Council config                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A single councillor. The deliberation persona is derived from the structured
 * fields (`archetype`, `core_trait`, `role`, `danger_prevented`) unless an
 * explicit `system_prompt` override is provided.
 */
export interface Councillor {
	/** Stable, unique, lowercase id (e.g. "mind"). Used in council_used. */
	id: string;
	/** Human-readable name (e.g. "The Analytical Critic"). */
	name: string;
	/** Symbolic label (e.g. "The Mind"). */
	symbol?: string;
	/** Persona archetype (e.g. "Exacting Realist / Devil's Advocate"). */
	archetype?: string;
	/** Core defining trait. */
	core_trait?: string;
	/** Role in the council. Required. */
	role: string;
	/** The danger this councillor exists to prevent. */
	danger_prevented?: string;
	/** Optional full system-prompt override. Takes precedence over generated text. */
	system_prompt?: string;
	/** Optional model id for this councillor (e.g. "claude-sonnet-4"). */
	model?: string;
	/** Tools the councillor may use. Defaults to read-only codebase access. */
	tools?: string[];
}

export interface CouncilConfig {
	/** Schema version. */
	version?: number;
	/** Display name for this council preset. */
	name?: string;
	/**
	 * Id of the councillor that leads synthesis. Defaults to "hand" if present,
	 * otherwise the last councillor in the list.
	 */
	synthesizer?: string;
	/** Run the cross-critique round before synthesis. Default: true when >= 2 councillors. */
	critique?: boolean;
	/** Optional model used for the synthesis step. */
	synthesis_model?: string;
	councillors: Councillor[];
}

/* -------------------------------------------------------------------------- */
/* Deliberation input                                                          */
/* -------------------------------------------------------------------------- */

export interface MagiInput {
	/** The issue, question, or decision needing deliberation. */
	issue: string;
	/** Background context / current state. */
	context?: string;
	/** Hard constraints that must hold. */
	constraints?: string[];
	/** The specific decision MAGI must recommend. */
	decision_needed?: string;
	/** Candidate options/paths to evaluate. MAGI may propose its own if omitted. */
	options?: string[];
}

export const MagiToolParams = Type.Object({
	issue: Type.String({
		description: "The issue, question, or decision that needs MAGI deliberation.",
	}),
	context: Type.Optional(
		Type.String({ description: "Background context, relevant facts, current state of the work." }),
	),
	constraints: Type.Optional(
		Type.Array(Type.String(), {
			description: "Constraints that must hold (time, budget, compatibility, policy, etc.).",
		}),
	),
	decision_needed: Type.Optional(
		Type.String({ description: "The specific decision MAGI must recommend." }),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "Candidate options/paths to evaluate. If omitted, MAGI may propose its own.",
		}),
	),
	council: Type.Optional(
		Type.String({
			description:
				"Which council to use: a preset name ('default' | 'two' | 'one'), a path to a council JSON file, or inline JSON. Defaults to the resolved config (project → user → bundled default).",
		}),
	),
	critique: Type.Optional(
		Type.Boolean({
			description: "Run the cross-critique round before synthesis (overrides config). Default: true when 2+ councillors.",
		}),
	),
});

export type MagiToolInput = Static<typeof MagiToolParams>;

/* -------------------------------------------------------------------------- */
/* Deliberation output                                                         */
/* -------------------------------------------------------------------------- */

export interface Critique {
	/** Id of the councillor being critiqued. */
	of: string;
	note: string;
}

export interface Opinion {
	/** Councillor id. */
	councillor: string;
	position: string;
	concerns: string[];
	recommendation: string;
	/** Optional critiques of other councillors (added in the critique round). */
	critiques?: Critique[];
}

export interface Synthesis {
	points_of_agreement: string[];
	points_of_disagreement: string[];
	risks: string[];
	rejected_options: string[];
	final_recommendation: string;
	confidence: Confidence;
}

export interface MagiOutput {
	council_used: string[];
	individual_opinions: Opinion[];
	points_of_agreement: string[];
	points_of_disagreement: string[];
	risks: string[];
	rejected_options: string[];
	final_recommendation: string;
	confidence: Confidence;
	meta: {
		critique_used: boolean;
		synthesizer: string;
		rounds: number;
		warnings: string[];
	};
}
