/**
 * CEREBEL — data models and tool schemas.
 *
 * CEREBEL is the orchestration controller for a GANGLION of LION workers. It
 * does not execute code itself. It forms assignment waves from AXON tasks,
 * records LION run results, and decides whether orchestration should continue,
 * wait, complete, replan, or escalate.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ASSIGNMENT_STATUSES = ["planned", "dispatched", "completed", "partial", "blocked", "failed", "cancelled"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const WAVE_STATUSES = ["planned", "dispatched", "collecting", "completed", "blocked", "needs_replan", "cancelled"] as const;
export type WaveStatus = (typeof WAVE_STATUSES)[number];

export const ORCHESTRATION_DECISIONS = ["dispatch", "wait", "continue", "complete", "replan", "escalate_to_amygdala", "cancelled"] as const;
export type OrchestrationDecision = (typeof ORCHESTRATION_DECISIONS)[number];

export const CEREBEL_ACTIONS = ["plan_wave", "dispatch", "record", "decide", "complete_wave", "cancel", "run_wave", "get", "list", "summary"] as const;
export type CerebelAction = (typeof CEREBEL_ACTIONS)[number];

export interface AxonTaskBrief {
	id: string;
	title: string;
	description?: string;
	priority?: Priority;
	assigned_to?: string | null;
}

export interface Assignment {
	id: string;
	task_id: string | null;
	agent_id: string;
	objective: string;
	context: string;
	priority: Priority;
	status: AssignmentStatus;
	/** Optional GANGLION allocation lease that should be released when this assignment reaches a terminal outcome. */
	ganglion_id?: string | null;
	ganglion_allocation_id?: string | null;
	lion_run_id?: string | null;
	/** Immutable LION execution generation paired with lion_run_id. Null means a legacy/unverifiable link. */
	lion_run_incarnation_id?: string | null;
	outcome_summary?: string | null;
	changed_files: string[];
	tests_run: string[];
	blockers: string[];
	next_steps: string[];
	created_at: string;
	updated_at: string;
}

export interface Wave {
	id: string;
	goal_id?: string | null;
	status: WaveStatus;
	max_parallel: number;
	assignments: Assignment[];
	decision?: DecisionReport | null;
	created_at: string;
	updated_at: string;
	completed_at?: string | null;
}

export interface DecisionReport {
	decision: OrchestrationDecision;
	reason: string;
	ready_assignment_ids: string[];
	blocked_assignment_ids: string[];
	failed_assignment_ids: string[];
	completed_assignment_ids: string[];
	created_at: string;
}

export interface CerebelFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	current_wave_id?: string;
	waves: Record<string, Wave>;
}

export interface CerebelSummary {
	total: number;
	by_status: Partial<Record<WaveStatus, number>>;
	current_wave_id?: string;
	active: Array<{ id: string; status: WaveStatus; assignments: number }>;
	recent: Wave[];
}

export const PRIORITY_SCHEMA = StringEnum(PRIORITIES);
export const ASSIGNMENT_STATUS_SCHEMA = StringEnum(ASSIGNMENT_STATUSES);
export const WAVE_STATUS_SCHEMA = StringEnum(WAVE_STATUSES);
export const DECISION_SCHEMA = StringEnum(ORCHESTRATION_DECISIONS);

const TaskBriefSchema = Type.Object({
	id: Type.String({ description: "AXON task id." }),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	priority: Type.Optional(PRIORITY_SCHEMA),
	assigned_to: Type.Optional(Type.String()),
});

const AssignmentInputSchema = Type.Object({
	task_id: Type.Optional(Type.String()),
	agent_id: Type.Optional(Type.String()),
	objective: Type.String(),
	context: Type.Optional(Type.String()),
	priority: Type.Optional(PRIORITY_SCHEMA),
	ganglion_id: Type.Optional(Type.String({ description: "GANGLION id that owns this capacity lease." })),
	ganglion_allocation_id: Type.Optional(Type.String({ description: "GANGLION allocation id to record/release when this assignment reaches a terminal outcome." })),
});

const DispatchLinkSchema = Type.Object({
	assignment_id: Type.String(),
	lion_run_id: Type.Optional(Type.String()),
	lion_run_incarnation_id: Type.Optional(Type.String({ description: "Immutable incarnation id returned by the linked LION run." })),
	ganglion_id: Type.Optional(Type.String({ description: "GANGLION id that owns this capacity lease." })),
	ganglion_allocation_id: Type.Optional(Type.String({ description: "GANGLION allocation id to record/release when this assignment reaches a terminal outcome." })),
});

export const CerebelToolParams = Type.Object({
	action: StringEnum(CEREBEL_ACTIONS, { description: "What to do. plan_wave/dispatch/record/decide/complete_wave/cancel/run_wave/get/list/summary." }),
	wave_id: Type.Optional(Type.String({ description: "Wave id. Use current/latest when omitted for most actions." })),
	goal_id: Type.Optional(Type.String({ description: "Optional CORTEX goal id this wave serves." })),
	max_parallel: Type.Optional(Type.Number({ description: "Max LION assignments to run concurrently. Default 3." })),
	// plan_wave input: either AXON task briefs or direct assignments
	tasks: Type.Optional(Type.Array(TaskBriefSchema, { description: "Ready AXON task briefs to turn into LION assignments." })),
	assignments: Type.Optional(Type.Array(AssignmentInputSchema, { description: "Direct assignments to add to a wave." })),
	context: Type.Optional(Type.String({ description: "Shared wave context / acceptance criteria." })),
	// dispatch
	links: Type.Optional(Type.Array(DispatchLinkSchema, { description: "Assignment→LION run links after calling lion run." })),
	// record
	assignment_id: Type.Optional(Type.String({ description: "Assignment id to record." })),
	task_id: Type.Optional(Type.String({ description: "AXON task id to record if assignment_id omitted." })),
	lion_run_id: Type.Optional(Type.String({ description: "LION run id that handled the assignment." })),
	lion_run_incarnation_id: Type.Optional(Type.String({ description: "Immutable incarnation id of the LION run that handled the assignment." })),
	ganglion_id: Type.Optional(Type.String({ description: "GANGLION id for a linked capacity lease if not already stored on the assignment." })),
	ganglion_allocation_id: Type.Optional(Type.String({ description: "GANGLION allocation id to record/release for this terminal assignment if not already stored on the assignment." })),
	outcome: Type.Optional(ASSIGNMENT_STATUS_SCHEMA),
	summary: Type.Optional(Type.String({ description: "LION outcome summary." })),
	changed_files: Type.Optional(Type.Array(Type.String())),
	tests_run: Type.Optional(Type.Array(Type.String())),
	blockers: Type.Optional(Type.Array(Type.String())),
	next_steps: Type.Optional(Type.Array(Type.String())),
	// run_wave optional LION subprocess controls
	timeout_ms: Type.Optional(Type.Number({ description: "Per-LION subprocess timeout for run_wave in milliseconds." })),
	model: Type.Optional(Type.String({ description: "Explicit model for LION subprocesses launched by run_wave." })),
	model_role: Type.Optional(StringEnum(["implementation", "review", "default"] as const)),
	runner_mode: Type.Optional(StringEnum(["json", "rpc"] as const, { description: "LION runner backend for run_wave. json is default; rpc enables live steering." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional pi tool allow-list for run_wave LION subprocesses." })),
	// list/summary filters
	status_filter: Type.Optional(WAVE_STATUS_SCHEMA),
	limit: Type.Optional(Type.Number({ description: "Max records to return. Default 20." })),
});

export type CerebelToolInput = Static<typeof CerebelToolParams>;

export type CerebelErrorCode = "not_found" | "invalid_arg" | "invalid_transition";

export class CerebelError extends Error {
	constructor(
		public code: CerebelErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CerebelError";
	}
}
