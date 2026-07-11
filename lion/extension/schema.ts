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
export type ActiveLionRunStatus = Extract<LionRunStatus, "queued" | "running">;
export type TerminalLionRunStatus = Exclude<LionRunStatus, ActiveLionRunStatus>;

export function isActiveLionStatus(status: LionRunStatus): status is ActiveLionRunStatus {
	return status === "queued" || status === "running";
}

export function isTerminalLionStatus(status: LionRunStatus): status is TerminalLionRunStatus {
	return !isActiveLionStatus(status);
}

export const LION_OUTCOMES = ["completed", "blocked", "failed", "partial"] as const;
export type LionOutcome = (typeof LION_OUTCOMES)[number];

export const MAX_ACTIVE_TOOL_NAMES = 32;
export const MAX_ACTIVE_TOOL_NAME_CHARS = 128;

export const LION_PROGRESS_EVENTS = [
	"started",
	"heartbeat",
	"tool_start",
	"tool_end",
	"message",
	"message_end",
	"turn_end",
] as const;
export type LionProgressEvent = (typeof LION_PROGRESS_EVENTS)[number];

export const LION_ACTIONS = ["run", "start", "cancel", "steer", "get", "list", "summary", "delete"] as const;
export type LionAction = (typeof LION_ACTIONS)[number];

export const LION_MODEL_ROLES = ["implementation", "review", "default"] as const;
export type LionModelRole = (typeof LION_MODEL_ROLES)[number];

export const LION_RUNNER_MODES = ["json", "rpc"] as const;
export type LionRunnerMode = (typeof LION_RUNNER_MODES)[number];

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

/**
 * Opportunistic live progress snapshot from a LION subprocess.
 *
 * The snapshot itself is fully shaped, while LionRun.progress is optional/additive
 * at the ledger level so older ledgers remain valid. The text tail is intentionally bounded by the
 * writer to avoid turning progress into an unbounded transcript.
 */
export interface LionProgressSnapshot {
	event: LionProgressEvent;
	activity: string;
	active_tools: string[];
	tool_uses: number;
	turn_count: number;
	token_total?: number | null;
	last_text?: string | null;
	last_event_at: string;
}

export const LION_CANCEL_DELIVERY_STATUSES = [
	"requested",
	"not_needed",
	"delivered",
	"not_attached",
	"owner_replaced",
	"already_exited",
	"not_alive",
	"no_cancel_handle",
	"not_signaled",
	"delivery_failed",
] as const;
export type LionCancelDeliveryStatus = (typeof LION_CANCEL_DELIVERY_STATUSES)[number];

export interface LionCleanupPendingObservation {
	/** Exact durable observation only; never process-control or signaling authority. */
	observed_at: string;
	incarnation_id: string | null;
	pid: number;
	pgid: number | null;
	process_identity: string | null;
}

export interface LionControlState {
	pid?: number | null;
	pgid?: number | null;
	/** Observational OS process-birth identity; never signaling authority. */
	process_identity?: string | null;
	started_at?: string | null;
	last_seen_at?: string | null;
	cancel_requested_at?: string | null;
	cancel_reason?: string | null;
	cancel_signal?: string | null;
	cancel_delivery_status?: LionCancelDeliveryStatus | null;
	cancel_delivered_at?: string | null;
	cancel_delivery_error?: string | null;
	reconciled_at?: string | null;
	/** Persisted before cleanup handoff so restart reconciliation fails closed. */
	cleanup_pending?: LionCleanupPendingObservation | null;
}

export const LION_STEERING_STATUSES = [
	"queued",
	"applied",
	"pending_delivery",
	"delivering",
	"delivered",
	"delivery_failed",
	"rejected_running",
	"rejected_terminal",
] as const;
export type LionSteeringStatus = (typeof LION_STEERING_STATUSES)[number];

export interface LionSteeringMessage {
	id: string;
	message: string;
	status: LionSteeringStatus;
	created_at: string;
	applied_at?: string | null;
	delivery_attempted_at?: string | null;
	delivered_at?: string | null;
	rejected_at?: string | null;
	reason?: string | null;
}

export interface LionRun {
	id: string;
	/** Immutable fencing token for asynchronous lifecycle writes. */
	incarnation_id?: string | null;
	agent_id: string;
	status: LionRunStatus;
	/** Optional AXON task id this worker was assigned to. */
	task_id: string | null;
	objective: string;
	context: string;
	model?: string | null;
	/** Which configured LION model default was used when model was omitted. */
	model_role?: LionModelRole | null;
	/** Execution backend. json preserves legacy one-shot subprocess behavior; rpc enables live steering. */
	runner_mode?: LionRunnerMode | null;
	tools?: string[] | null;
	started_at: string;
	updated_at: string;
	finished_at?: string | null;
	duration_ms?: number | null;
	/** Raw final assistant text from the subprocess. */
	output?: string | null;
	/** Parsed WORKER_REPORT JSON if present. */
	report?: LionReport | null;
	/** Latest bounded live progress snapshot, when the subprocess emitted usable events. Raw assistant text is redacted unless explicitly enabled per run. */
	progress?: LionProgressSnapshot | null;
	/** Best-effort subprocess control metadata for cancellation/reconciliation. */
	control?: LionControlState | null;
	/** Pre-start steering messages and RPC live steering delivery records. */
	steering_messages?: LionSteeringMessage[];
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
export const LION_RUNNER_MODE_SCHEMA = StringEnum(LION_RUNNER_MODES);

export const LionToolParams = Type.Object({
	action: StringEnum(LION_ACTIONS, {
		description: "What to do. run/start/cancel/steer/get/list/summary/delete.",
	}),
	// run
	task_id: Type.Optional(Type.String({ description: "AXON task id assigned to this worker (run/get/delete)." })),
	objective: Type.Optional(Type.String({ description: "Concrete worker assignment. Required for run unless task_id is sufficient." })),
	context: Type.Optional(Type.String({ description: "Extra context, constraints, or acceptance criteria for the worker." })),
	agent_id: Type.Optional(Type.String({ description: "Worker id, e.g. lion-1. Defaults to auto id." })),
	model: Type.Optional(Type.String({ description: "Explicit model for the subprocess worker. Overrides configured LION model defaults." })),
	model_role: Type.Optional(LION_MODEL_ROLE_SCHEMA),
	runner_mode: Type.Optional(LION_RUNNER_MODE_SCHEMA),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional pi tool allow-list for the worker subprocess." })),
	timeout_ms: Type.Optional(Type.Number({ description: "Subprocess timeout in milliseconds. Default 10 minutes." })),
	include_progress_text: Type.Optional(Type.Boolean({ description: "Opt in to persisting raw assistant text tails in progress.last_text/activity. Default false/redacted." })),
	dry_run: Type.Optional(Type.Boolean({ description: "Create a run record without spawning a subprocess." })),
	// start/cancel/steer/query/list
	id: Type.Optional(Type.String({ description: "LION run id (start/cancel/steer/get/delete)." })),
	message: Type.Optional(Type.String({ description: "Steering message for action=steer. Accepted pre-start for queued runs and live only for running rpc-backed runs." })),
	reason: Type.Optional(Type.String({ description: "Cancellation reason for action=cancel." })),
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
