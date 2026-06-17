/**
 * AXON — data models and schemas.
 *
 * The task ledger schema. Mirrors the NERVous spec's AXON Task model, plus the
 * supporting enums (status, priority, review). Internal types are plain TS
 * interfaces; TypeBox schemas are exported for the `axon` tool's parameter
 * validation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const TASK_STATUSES = [
	"pending",
	"ready",
	"in_progress",
	"blocked",
	"needs_amygdala",
	"needs_review",
	"completed",
	"failed",
	"cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REVIEW_STATUSES = [
	"not_reviewed",
	"under_review",
	"approved",
	"changes_requested",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Non-terminal statuses (work may still continue). */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"pending",
	"ready",
	"in_progress",
	"blocked",
	"needs_amygdala",
	"needs_review",
]);

/** Terminal statuses (no further transitions out). */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

/* -------------------------------------------------------------------------- */
/* Task model                                                                  */
/* -------------------------------------------------------------------------- */

export interface ProgressNote {
	ts: string;
	author?: string;
	text: string;
}

export interface Artifact {
	path: string;
	kind?: string;
	ts: string;
}

export interface Blocker {
	text: string;
	ts: string;
	resolved: boolean;
}

export interface Task {
	id: string;
	title: string;
	description: string;
	parent_id: string | null;
	dependencies: string[];
	assigned_to: string | null;
	status: TaskStatus;
	priority: Priority;
	progress_notes: ProgressNote[];
	artifacts: Artifact[];
	blockers: Blocker[];
	review_status: ReviewStatus;
	created_at: string;
	updated_at: string;
}

/** The on-disk ledger file shape. */
export interface LedgerFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	tasks: Record<string, Task>;
}

/* -------------------------------------------------------------------------- */
/* Tool parameter schemas                                                      */
/* -------------------------------------------------------------------------- */

export const TASK_STATUS_SCHEMA = StringEnum(TASK_STATUSES);
export const PRIORITY_SCHEMA = StringEnum(PRIORITIES);
export const REVIEW_STATUS_SCHEMA = StringEnum(REVIEW_STATUSES);

export const AXON_ACTIONS = [
	"create",
	"get",
	"list",
	"update",
	"set_status",
	"add_note",
	"add_blocker",
	"resolve_blocker",
	"add_artifact",
	"set_review",
	"assign",
	"delete",
	"recompute",
	"summary",
] as const;
export type AxonAction = (typeof AXON_ACTIONS)[number];

/**
 * Single-tool surface with an `action` discriminator. All fields are optional
 * because different actions use different subsets; `execute` validates the
 * required fields per action and returns a clear error otherwise.
 */
export const AxonToolParams = Type.Object({
	action: StringEnum(AXON_ACTIONS, {
		description:
			"What to do. create/get/list/update/set_status/add_note/add_blocker/resolve_blocker/" +
			"add_artifact/set_review/assign/delete/recompute/summary.",
	}),
	id: Type.Optional(Type.String({ description: "Task id (e.g. task-001)." })),
	title: Type.Optional(Type.String({ description: "Task title (create/update)." })),
	description: Type.Optional(Type.String({ description: "Task description (create/update)." })),
	parent_id: Type.Optional(
		Type.String({ description: "Parent task id for subtask relationships (create/update)." }),
	),
	dependencies: Type.Optional(
		Type.Array(Type.String(), { description: "Task ids this task depends on (create/update)." }),
	),
	assigned_to: Type.Optional(
		Type.String({ description: "LION/GANGLION id to assign to (assign/create/update)." }),
	),
	status: Type.Optional(TASK_STATUS_SCHEMA),
	priority: Type.Optional(PRIORITY_SCHEMA),
	review_status: Type.Optional(REVIEW_STATUS_SCHEMA),
	note: Type.Optional(Type.String({ description: "Progress note text (add_note) or note on set_status." })),
	author: Type.Optional(Type.String({ description: "Author/agent id for progress notes." })),
	blocker: Type.Optional(Type.String({ description: "Blocker text (add_blocker)." })),
	blocker_index: Type.Optional(
		Type.Number({ description: "Index into task.blockers to resolve (resolve_blocker)." }),
	),
	artifact: Type.Optional(
		Type.Object({
			path: Type.String({ description: "Path or URL of the produced artifact." }),
			kind: Type.Optional(Type.String({ description: "e.g. file, test, doc, command." })),
		}),
	),
	// Filters for `list`
	status_filter: Type.Optional(TASK_STATUS_SCHEMA),
	assigned_filter: Type.Optional(Type.String({ description: "Filter list by assigned_to." })),
	parent_filter: Type.Optional(Type.String({ description: "Filter list by parent_id." })),
	ready_only: Type.Optional(Type.Boolean({ description: "List only ready tasks." })),
	blocked_only: Type.Optional(Type.Boolean({ description: "List only blocked tasks." })),
});

export type AxonToolInput = Static<typeof AxonToolParams>;

/* -------------------------------------------------------------------------- */
/* Board summary                                                               */
/* -------------------------------------------------------------------------- */

export interface BoardSummary {
	total: number;
	by_status: Partial<Record<TaskStatus, number>>;
	by_priority: Partial<Record<Priority, number>>;
	ready: string[];
	in_progress: string[];
	blocked: string[];
	needs_amygdala: string[];
	needs_review: string[];
	terminal: number;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type AxonErrorCode =
	| "not_found"
	| "invalid_transition"
	| "deps_not_satisfied"
	| "cycle"
	| "self_dep"
	| "invalid_arg"
	| "exists";

export class AxonError extends Error {
	constructor(
		public code: AxonErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AxonError";
	}
}
