/**
 * GANGLION — data models and tool schemas.
 *
 * A GANGLION is a working group of LION slots. It owns roster/capability and
 * allocation state, not execution. CEREBEL can ask GANGLION which LION should
 * take which AXON task, then dispatch with the LION tool.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const MEMBER_STATUSES = ["available", "busy", "offline", "failed"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const GANGLION_STATUSES = ["forming", "active", "paused", "draining", "completed", "cancelled"] as const;
export type GanglionStatus = (typeof GANGLION_STATUSES)[number];

export const ALLOCATION_STATUSES = ["assigned", "running", "completed", "blocked", "failed", "cancelled"] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const GANGLION_ACTIONS = [
	"create",
	"add_member",
	"update_member",
	"remove_member",
	"set_status",
	"allocate",
	"record",
	"release",
	"get",
	"list",
	"summary",
	"delete",
] as const;
export type GanglionAction = (typeof GANGLION_ACTIONS)[number];

export interface Member {
	id: string;
	role: string;
	capabilities: string[];
	model?: string | null;
	tools?: string[] | null;
	status: MemberStatus;
	current_task_id?: string | null;
	current_allocation_id?: string | null;
	last_run_id?: string | null;
	created_at: string;
	updated_at: string;
}

export interface WorkItemBrief {
	id: string;
	title: string;
	description?: string;
	priority?: Priority;
	required_capabilities?: string[];
}

export interface Allocation {
	id: string;
	task_id: string;
	member_id: string;
	objective: string;
	context: string;
	priority: Priority;
	required_capabilities: string[];
	status: AllocationStatus;
	lion_run_id?: string | null;
	outcome_summary?: string | null;
	reason: string;
	created_at: string;
	updated_at: string;
}

export interface Ganglion {
	id: string;
	name: string;
	goal_id?: string | null;
	status: GanglionStatus;
	max_parallel: number;
	members: Member[];
	allocations: Allocation[];
	created_at: string;
	updated_at: string;
	completed_at?: string | null;
}

export interface GanglionFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	current_ganglion_id?: string;
	ganglions: Record<string, Ganglion>;
}

export interface GanglionSummary {
	total: number;
	by_status: Partial<Record<GanglionStatus, number>>;
	current_ganglion_id?: string;
	active: Array<{ id: string; name: string; status: GanglionStatus; members: number; busy: number }>;
	recent: Ganglion[];
}

export const PRIORITY_SCHEMA = StringEnum(PRIORITIES);
export const MEMBER_STATUS_SCHEMA = StringEnum(MEMBER_STATUSES);
export const GANGLION_STATUS_SCHEMA = StringEnum(GANGLION_STATUSES);
export const ALLOCATION_STATUS_SCHEMA = StringEnum(ALLOCATION_STATUSES);

const MemberInputSchema = Type.Object({
	id: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	capabilities: Type.Optional(Type.Array(Type.String())),
	model: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String())),
	status: Type.Optional(MEMBER_STATUS_SCHEMA),
});

const WorkItemSchema = Type.Object({
	id: Type.String({ description: "AXON task id or external work id." }),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	priority: Type.Optional(PRIORITY_SCHEMA),
	required_capabilities: Type.Optional(Type.Array(Type.String())),
});

export const GanglionToolParams = Type.Object({
	action: StringEnum(GANGLION_ACTIONS, {
		description: "What to do. create/add_member/update_member/remove_member/set_status/allocate/record/release/get/list/summary/delete.",
	}),
	ganglion_id: Type.Optional(Type.String({ description: "Ganglion id. Use current/latest when omitted for most actions." })),
	name: Type.Optional(Type.String({ description: "Ganglion name (create/update)." })),
	goal_id: Type.Optional(Type.String({ description: "Optional CORTEX goal id this group serves." })),
	max_parallel: Type.Optional(Type.Number({ description: "Max concurrent busy members. Default 3." })),
	member_count: Type.Optional(Type.Number({ description: "Create N generic LION members when members omitted." })),
	members: Type.Optional(Type.Array(MemberInputSchema, { description: "Initial roster (create)." })),
	// member ops
	member_id: Type.Optional(Type.String({ description: "Member id for member ops." })),
	role: Type.Optional(Type.String({ description: "Member role." })),
	capabilities: Type.Optional(Type.Array(Type.String(), { description: "Member capabilities or required capabilities." })),
	model: Type.Optional(Type.String({ description: "Preferred LION model for member." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Preferred LION tool allowlist for member." })),
	member_status: Type.Optional(MEMBER_STATUS_SCHEMA),
	// ganglion status
	status: Type.Optional(GANGLION_STATUS_SCHEMA),
	// allocate
	tasks: Type.Optional(Type.Array(WorkItemSchema, { description: "Ready AXON task briefs to allocate to available members." })),
	context: Type.Optional(Type.String({ description: "Shared allocation/LION context." })),
	// record/release
	allocation_id: Type.Optional(Type.String({ description: "Allocation id." })),
	task_id: Type.Optional(Type.String({ description: "Task id if allocation_id omitted." })),
	lion_run_id: Type.Optional(Type.String({ description: "LION run id for record." })),
	allocation_status: Type.Optional(ALLOCATION_STATUS_SCHEMA),
	summary: Type.Optional(Type.String({ description: "Outcome summary for record." })),
	// list filters
	status_filter: Type.Optional(GANGLION_STATUS_SCHEMA),
	limit: Type.Optional(Type.Number({ description: "Max records to return. Default 20." })),
});

export type GanglionToolInput = Static<typeof GanglionToolParams>;

export type GanglionErrorCode = "not_found" | "invalid_arg" | "invalid_transition" | "exists";
export class GanglionError extends Error {
	constructor(
		public code: GanglionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "GanglionError";
	}
}
