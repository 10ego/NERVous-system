/**
 * AMYGDALA — risk/escalation data models and tool schemas.
 *
 * AMYGDALA is the NERVous System's risk escalation layer. It captures blockers,
 * unsafe operations, failed orchestration, and uncertainty as durable incidents,
 * then recommends pause/continue/retry/replan/MAGI/human escalation.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RISK_CATEGORIES = [
	"blocker",
	"security",
	"data_loss",
	"regression",
	"dependency",
	"scope",
	"policy",
	"uncertainty",
	"unknown",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const INCIDENT_STATUSES = ["open", "acknowledged", "mitigating", "resolved", "accepted", "escalated", "cancelled"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const RECOMMENDATIONS = ["continue", "retry", "pause", "replan", "convene_magi", "human_review", "stop"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const SOURCES = ["manual", "axon", "cortex", "cerebel", "ganglion", "lion", "synapse", "magi"] as const;
export type Source = (typeof SOURCES)[number];

export const AMYGDALA_ACTIONS = ["assess", "update", "set_status", "add_note", "resolve", "accept", "get", "list", "summary", "delete"] as const;
export type AmygdalaAction = (typeof AMYGDALA_ACTIONS)[number];

export interface IncidentNote {
	ts: string;
	author?: string | null;
	text: string;
}

export interface Incident {
	id: string;
	title: string;
	description: string;
	source: Source;
	source_id: string | null;
	severity: Severity;
	category: RiskCategory;
	status: IncidentStatus;
	recommendation: Recommendation;
	reason: string;
	mitigation_plan: string[];
	assigned_to?: string | null;
	related_ids: string[];
	notes: IncidentNote[];
	created_at: string;
	updated_at: string;
	resolved_at?: string | null;
}

export interface AmygdalaFile {
	version: number;
	project?: string;
	created_at?: string;
	updated_at: string;
	incidents: Record<string, Incident>;
}

export interface AmygdalaSummary {
	total: number;
	by_status: Partial<Record<IncidentStatus, number>>;
	by_severity: Partial<Record<Severity, number>>;
	open_critical: string[];
	needs_attention: Array<{ id: string; title: string; severity: Severity; recommendation: Recommendation }>;
	recent: Incident[];
}

export const SEVERITY_SCHEMA = StringEnum(SEVERITIES);
export const CATEGORY_SCHEMA = StringEnum(RISK_CATEGORIES);
export const STATUS_SCHEMA = StringEnum(INCIDENT_STATUSES);
export const RECOMMENDATION_SCHEMA = StringEnum(RECOMMENDATIONS);
export const SOURCE_SCHEMA = StringEnum(SOURCES);

export const AmygdalaToolParams = Type.Object({
	action: StringEnum(AMYGDALA_ACTIONS, { description: "What to do. assess/update/set_status/add_note/resolve/accept/get/list/summary/delete." }),
	id: Type.Optional(Type.String({ description: "Incident id." })),
	// assess/update
	title: Type.Optional(Type.String({ description: "Short risk title." })),
	description: Type.Optional(Type.String({ description: "Risk/blocker description." })),
	source: Type.Optional(SOURCE_SCHEMA),
	source_id: Type.Optional(Type.String({ description: "Related AXON/CORTEX/CEREBEL/GANGLION/LION id." })),
	severity: Type.Optional(SEVERITY_SCHEMA),
	category: Type.Optional(CATEGORY_SCHEMA),
	recommendation: Type.Optional(RECOMMENDATION_SCHEMA),
	reason: Type.Optional(Type.String({ description: "Why this triage/recommendation was chosen." })),
	mitigation_plan: Type.Optional(Type.Array(Type.String(), { description: "Ordered mitigation steps." })),
	assigned_to: Type.Optional(Type.String({ description: "Owner/agent for mitigation." })),
	related_ids: Type.Optional(Type.Array(Type.String(), { description: "Related task/run/wave/goal ids." })),
	// status/note
	status: Type.Optional(STATUS_SCHEMA),
	note: Type.Optional(Type.String({ description: "Progress note or resolution note." })),
	author: Type.Optional(Type.String({ description: "Note author." })),
	// list filters
	status_filter: Type.Optional(STATUS_SCHEMA),
	severity_filter: Type.Optional(SEVERITY_SCHEMA),
	category_filter: Type.Optional(CATEGORY_SCHEMA),
	source_filter: Type.Optional(SOURCE_SCHEMA),
	limit: Type.Optional(Type.Number({ description: "Max incidents to return. Default 20." })),
});

export type AmygdalaToolInput = Static<typeof AmygdalaToolParams>;

export type AmygdalaErrorCode = "not_found" | "invalid_arg" | "invalid_transition";
export class AmygdalaError extends Error {
	constructor(
		public code: AmygdalaErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AmygdalaError";
	}
}
