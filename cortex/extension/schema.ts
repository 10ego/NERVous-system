/**
 * CORTEX — data models and schemas.
 *
 * CORTEX is the NERVous System's main reasoning core. It converts a user prompt
 * into a durable Goal: a structured intent analysis, an execution plan (linked
 * to AXON tasks), and a verification report. Because the Goal is persisted, work
 * can resume after compaction/restart without the original context window.
 *
 * CORTEX does NOT import AXON/MAGI/SYNAPSE at runtime — the agent bridges those
 * tools guided by the cortex skill. This keeps each package independently
 * installable.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const COMPLEXITIES = ["low", "medium", "high"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const GOAL_STATUSES = [
	"analyzed", // intent parsed, awaiting planning (and maybe MAGI)
	"planned", // plan stored; AXON tasks may be created
	"executing", // linked to AXON tasks; work in progress
	"verified", // verification report recorded (approve)
	"needs_replan", // verification found problems; plan must change
	"completed", // done + (optionally) MAGI-reviewed
	"cancelled",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const VERIFY_RECOMMENDATIONS = [
	"approve",
	"revise",
	"replan",
	"escalate_to_magi",
] as const;
export type VerifyRecommendation = (typeof VERIFY_RECOMMENDATIONS)[number];

/* -------------------------------------------------------------------------- */
/* Intent analysis                                                             */
/* -------------------------------------------------------------------------- */

export interface Risk {
	description: string;
	severity: Severity;
}

export interface IntentAnalysis {
	/** One-paragraph restatement of what the user wants. */
	intent_summary: string;
	/** Crisp, singular goal statement. */
	goal: string;
	/** Observable conditions that mean the goal is achieved. */
	success_criteria: string[];
	/** Hard constraints (time, compatibility, policy, scope). */
	constraints: string[];
	/** Identified risks with severity. */
	risks: Risk[];
	/** What the user should receive when done. */
	expected_output: string;
	/** How hard/ambiguous/risky overall — drives whether MAGI is warranted. */
	complexity: Complexity;
	/** CORTEX's recommendation on whether to convene MAGI before planning. */
	needs_magi: boolean;
	/** Why MAGI is or isn't needed. */
	magi_rationale?: string;
}

/* -------------------------------------------------------------------------- */
/* Execution plan                                                              */
/* -------------------------------------------------------------------------- */

export interface PlannedSubtask {
	/** Local plan id within the goal, e.g. plan-001. */
	id: string;
	title: string;
	description: string;
	/** Other plan ids this depends on. */
	dependencies: string[];
	priority: Priority;
	assigned_to?: string | null;
	/** AXON task id once created in the ledger (filled by cortex_link). */
	axon_task_id?: string | null;
}

export interface ExecutionPlan {
	subtasks: PlannedSubtask[];
	/** Whether MAGI was convened to produce/refine this plan. */
	magi_used: boolean;
	/** Short reference to the MAGI recommendation used (if any). */
	magi_output_ref?: string;
	created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Verification report                                                         */
/* -------------------------------------------------------------------------- */

export interface VerifyCheck {
	/** The success criterion (or derived check) being evaluated. */
	criterion: string;
	passed: boolean;
	/** Evidence grounding the pass/fail (file, test, AXON task id, etc.). */
	evidence: string;
}

export interface VerificationReport {
	checks: VerifyCheck[];
	/** Whether all linked AXON tasks are completed. */
	all_axon_complete: boolean;
	recommendation: VerifyRecommendation;
	concerns: string[];
	/** True when recommendation is approve and ready for MAGI final review. */
	ready_for_magi_review: boolean;
	created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Goal                                                                        */
/* -------------------------------------------------------------------------- */

export interface Goal {
	id: string;
	/** The original user prompt, preserved verbatim. */
	prompt: string;
	status: GoalStatus;
	intent: IntentAnalysis;
	plan?: ExecutionPlan;
	/** AXON task ids linked to this goal (set by cortex_link). */
	axon_task_ids: string[];
	verification?: VerificationReport;
	created_at: string;
	updated_at: string;
}

/** The on-disk cortex state file shape. */
export interface CortexFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	current_goal_id?: string;
	goals: Record<string, Goal>;
}

/* -------------------------------------------------------------------------- */
/* Tool parameter schemas                                                      */
/* -------------------------------------------------------------------------- */

export const COMPLEXITY_SCHEMA = StringEnum(COMPLEXITIES);
export const SEVERITY_SCHEMA = StringEnum(SEVERITIES);
export const PRIORITY_SCHEMA = StringEnum(PRIORITIES);
export const GOAL_STATUS_SCHEMA = StringEnum(GOAL_STATUSES);

export const CORTEX_ACTIONS = [
	"analyze",
	"plan",
	"link",
	"verify",
	"complete",
	"cancel",
	"get",
	"list",
	"summary",
	"set_current",
] as const;
export type CortexAction = (typeof CORTEX_ACTIONS)[number];

const RiskSchema = Type.Object({
	description: Type.String({ description: "What the risk is." }),
	severity: Type.Optional(SEVERITY_SCHEMA),
});

const PlannedSubtaskInputSchema = Type.Object({
	title: Type.String(),
	description: Type.Optional(Type.String()),
	dependencies: Type.Optional(Type.Array(Type.String(), { description: "Titles or plan ids this depends on." })),
	priority: Type.Optional(PRIORITY_SCHEMA),
	assigned_to: Type.Optional(Type.String()),
});

const VerifyCheckSchema = Type.Object({
	criterion: Type.String(),
	passed: Type.Boolean(),
	evidence: Type.Optional(Type.String()),
});

export const CortexToolParams = Type.Object({
	action: StringEnum(CORTEX_ACTIONS, {
		description:
			"What to do. analyze/plan/link/verify/complete/cancel/get/list/summary/set_current.",
	}),
	// analyze
	prompt: Type.Optional(Type.String({ description: "The user prompt (analyze)." })),
	intent_summary: Type.Optional(Type.String({ description: "One-paragraph restatement of intent (analyze)." })),
	goal: Type.Optional(Type.String({ description: "Crisp goal statement (analyze)." })),
	success_criteria: Type.Optional(Type.Array(Type.String(), { description: "Observable success conditions (analyze)." })),
	constraints: Type.Optional(Type.Array(Type.String(), { description: "Hard constraints (analyze)." })),
	risks: Type.Optional(Type.Array(RiskSchema, { description: "Identified risks (analyze)." })),
	expected_output: Type.Optional(Type.String({ description: "Expected deliverable/output (analyze)." })),
	complexity: Type.Optional(COMPLEXITY_SCHEMA),
	needs_magi: Type.Optional(Type.Boolean({ description: "Whether MAGI should be convened before planning (analyze)." })),
	magi_rationale: Type.Optional(Type.String({ description: "Why MAGI is/isn't needed (analyze)." })),
	// plan
	goal_id: Type.Optional(Type.String({ description: "Goal id (plan/link/verify/complete/cancel/get/set_current)." })),
	subtasks: Type.Optional(
		Type.Array(PlannedSubtaskInputSchema, { description: "Planned subtasks (plan)." }),
	),
	magi_used: Type.Optional(Type.Boolean({ description: "Whether MAGI produced/refined this plan (plan)." })),
	magi_output_ref: Type.Optional(Type.String({ description: "Reference to the MAGI recommendation used (plan)." })),
	// link
	links: Type.Optional(
		Type.Array(
			Type.Object({
				plan_id: Type.Optional(Type.String()),
				axon_task_id: Type.String(),
			}),
			{ description: "AXON task ids created for the plan (link)." },
		),
	),
	// verify
	checks: Type.Optional(Type.Array(VerifyCheckSchema, { description: "Per-criterion verification checks (verify)." })),
	all_axon_complete: Type.Optional(
		Type.Boolean({ description: "Whether all linked AXON tasks are completed (verify)." }),
	),
	recommendation: Type.Optional(StringEnum(VERIFY_RECOMMENDATIONS)),
	concerns: Type.Optional(Type.Array(Type.String(), { description: "Outstanding concerns (verify)." })),
	// common filters
	status_filter: Type.Optional(GOAL_STATUS_SCHEMA),
});

export type CortexToolInput = Static<typeof CortexToolParams>;

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

export interface CortexSummary {
	total: number;
	by_status: Partial<Record<GoalStatus, number>>;
	current_goal_id?: string;
	active: Array<{ id: string; goal: string; status: GoalStatus }>;
	needs_attention: Array<{ id: string; goal: string; reason: string }>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type CortexErrorCode =
	| "not_found"
	| "invalid_transition"
	| "invalid_arg"
	| "exists"
	| "unverified";

export class CortexError extends Error {
	constructor(
		public code: CortexErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CortexError";
	}
}
