/**
 * SYNAPSE — data models and schemas.
 *
 * SYNAPSE is the *transient* shared coordination scratchpad. Notes are short,
 * coordination-focused, and bounded by retention (TTL + max count) so they do
 * not accumulate into long-term memory. AXON holds durable state; SYNAPSE holds
 * ephemeral coordination chatter.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

/* -------------------------------------------------------------------------- */
/* Note model                                                                  */
/* -------------------------------------------------------------------------- */

export const NOTE_TYPES = [
	"started",
	"completed",
	"blocker",
	"risk",
	"decision",
	"info",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface Note {
	id: string;
	/** AXON task id this note pertains to, or null for the general channel. */
	task_id: string | null;
	/** Authoring agent id (e.g. "lion-1"), or null for anonymous/system. */
	agent_id: string | null;
	type: NoteType;
	message: string;
	created_at: string;
}

/** The on-disk scratchpad file shape. */
export interface SynapseFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	/** Retention config snapshot at last write (informational). */
	retention?: { ttl_ms: number; max_notes: number };
	notes: Note[];
}

/* -------------------------------------------------------------------------- */
/* Tool parameter schemas                                                      */
/* -------------------------------------------------------------------------- */

export const NOTE_TYPE_SCHEMA = StringEnum(NOTE_TYPES);

export const SYNAPSE_ACTIONS = [
	"post",
	"list",
	"get",
	"summary",
	"prune",
	"clear",
] as const;
export type SynapseAction = (typeof SYNAPSE_ACTIONS)[number];

export const SynapseToolParams = Type.Object({
	action: StringEnum(SYNAPSE_ACTIONS, {
		description: "What to do. post/list/get/summary/prune/clear.",
	}),
	// post
	message: Type.Optional(
		Type.String({ description: "Note text — short and coordination-focused (post)." }),
	),
	task_id: Type.Optional(
		Type.String({ description: "AXON task id this note pertains to. Omit/null for the general channel." }),
	),
	agent_id: Type.Optional(
		Type.String({ description: "Authoring agent id, e.g. 'lion-1' (post)." }),
	),
	type: Type.Optional(NOTE_TYPE_SCHEMA),
	// get
	id: Type.Optional(Type.String({ description: "Note id (get)." })),
	// list filters
	task_filter: Type.Optional(Type.String({ description: "Filter list by task_id (use 'general' for null)." })),
	agent_filter: Type.Optional(Type.String({ description: "Filter list by agent_id." })),
	type_filter: Type.Optional(NOTE_TYPE_SCHEMA),
	limit: Type.Optional(
		Type.Number({ description: "Max notes to return (list/summary recent). Default 50.", default: 50 }),
	),
	// clear
	all: Type.Optional(
		Type.Boolean({ description: "clear: remove ALL notes (otherwise only the filtered set). Default false." }),
	),
});

export type SynapseToolInput = Static<typeof SynapseToolParams>;

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

export interface SynapseSummary {
	total: number;
	by_type: Partial<Record<NoteType, number>>;
	by_task: Array<{ task_id: string | null; count: number }>;
	recent: Note[];
	oldest_age_ms: number | null;
	retention: { ttl_ms: number; max_notes: number };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type SynapseErrorCode = "not_found" | "invalid_arg";

export class SynapseError extends Error {
	constructor(
		public code: SynapseErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SynapseError";
	}
}
