/**
 * LION — data models and schemas.
 *
 * A LION (Local Intelligence Operations Node) is an isolated coding subagent:
 * one pi subprocess, one assignment, one final worker report. LION owns a
 * durable run ledger so CEREBEL/GANGLION can later inspect worker outcomes.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const LION_RUN_STATUSES = [
	"queued",
	"running",
	"completed",
	"blocked",
	"failed",
	"aborted",
] as const;
export type LionRunStatus = (typeof LION_RUN_STATUSES)[number];

export const LION_OUTCOMES = ["completed", "blocked", "failed", "partial"] as const;
export type LionOutcome = (typeof LION_OUTCOMES)[number];

export const LION_ACTIONS = ["run", "get", "list", "summary", "delete"] as const;
export type LionAction = (typeof LION_ACTIONS)[number];

export const LION_MODEL_ROLES = ["implementation", "review", "default"] as const;
export type LionModelRole = (typeof LION_MODEL_ROLES)[number];

/* -------------------------------------------------------------------------- */
/* Worker report and run ledger                                                */
/* -------------------------------------------------------------------------- */

export interface LionReport {
	outcome: LionOutcome;
	summary: string;
	changed_files: string[];
	tests_run: string[];
	blockers: string[];
	next_steps: string[];
	notes?: string;
}

export interface LionRun {
	id: string;
	agent_id: string;
	status: LionRunStatus;
	/** Optional AXON task id this worker was assigned to. */
	task_id: string | null;
	objective: string;
	context: string;
	model?: string | null;
	/** Which configured LION model default was used when model was omitted. */
	model_role?: LionModelRole | null;
	tools?: string[] | null;
	started_at: string;
	updated_at: string;
	finished_at?: string | null;
	duration_ms?: number | null;
	/** Raw final assistant text from the subprocess. */
	output?: string | null;
	/** Parsed WORKER_REPORT JSON if present. */
	report?: LionReport | null;
	error?: string | null;
}

export interface LionFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	runs: Record<string, LionRun>;
}

export interface LionSummary {
	total: number;
	by_status: Partial<Record<LionRunStatus, number>>;
	running: LionRun[];
	recent: LionRun[];
}

/* -------------------------------------------------------------------------- */
/* Tool parameter schemas                                                      */
/* -------------------------------------------------------------------------- */

export const LION_RUN_STATUS_SCHEMA = StringEnum(LION_RUN_STATUSES);
export const LION_OUTCOME_SCHEMA = StringEnum(LION_OUTCOMES);
export const LION_MODEL_ROLE_SCHEMA = StringEnum(LION_MODEL_ROLES);

export const LionToolParams = Type.Object({
	action: StringEnum(LION_ACTIONS, {
		description: "What to do. run/get/list/summary/delete.",
	}),
	// run
	task_id: Type.Optional(Type.String({ description: "AXON task id assigned to this worker (run/get/delete)." })),
	objective: Type.Optional(Type.String({ description: "Concrete worker assignment. Required for run unless task_id is sufficient." })),
	context: Type.Optional(Type.String({ description: "Extra context, constraints, or acceptance criteria for the worker." })),
	agent_id: Type.Optional(Type.String({ description: "Worker id, e.g. lion-1. Defaults to auto id." })),
	model: Type.Optional(Type.String({ description: "Explicit model for the subprocess worker. Overrides configured LION model defaults." })),
	model_role: Type.Optional(LION_MODEL_ROLE_SCHEMA),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional pi tool allow-list for the worker subprocess." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Subprocess timeout in milliseconds. Default 10 minutes." })),
	dry_run: Type.Optional(Type.Boolean({ description: "Create a run record without spawning a subprocess." })),
	// query/list
	id: Type.Optional(Type.String({ description: "LION run id (get/delete)." })),
	status_filter: Type.Optional(LION_RUN_STATUS_SCHEMA),
	agent_filter: Type.Optional(Type.String({ description: "Filter list by agent_id." })),
	limit: Type.Optional(Type.Number({ description: "Max runs to return for list/summary. Default 20." })),
});

export type LionToolInput = Static<typeof LionToolParams>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type LionErrorCode = "not_found" | "invalid_arg" | "invalid_transition";

export class LionError extends Error {
	constructor(
		public code: LionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "LionError";
	}
}
