/** AMYGDALA — pure risk incident ledger. */

import {
	AmygdalaError,
	INCIDENT_STATUSES,
	RECOMMENDATIONS,
	RISK_CATEGORIES,
	SEVERITIES,
	SOURCES,
	type AmygdalaFile,
	type AmygdalaSummary,
	type Incident,
	type IncidentStatus,
	type Recommendation,
	type RiskCategory,
	type Severity,
	type Source,
} from "./schema.ts";

const VERSION = 1;
const STATUS_SET = new Set<string>(INCIDENT_STATUSES);
const SEVERITY_SET = new Set<string>(SEVERITIES);
const CATEGORY_SET = new Set<string>(RISK_CATEGORIES);
const REC_SET = new Set<string>(RECOMMENDATIONS);
const SOURCE_SET = new Set<string>(SOURCES);

const now = () => new Date().toISOString();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const strings = (xs: unknown): string[] => Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [];

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
	if (from === to) return true;
	if (from === "open") return ["acknowledged", "mitigating", "resolved", "accepted", "escalated", "cancelled"].includes(to);
	if (from === "acknowledged") return ["mitigating", "resolved", "accepted", "escalated", "cancelled"].includes(to);
	if (from === "mitigating") return ["resolved", "accepted", "escalated", "cancelled"].includes(to);
	if (from === "escalated") return ["mitigating", "resolved", "accepted", "cancelled"].includes(to);
	return false;
}

export interface AssessInput {
	title?: string;
	description: string;
	source?: Source;
	source_id?: string | null;
	severity?: Severity;
	category?: RiskCategory;
	recommendation?: Recommendation;
	reason?: string;
	mitigation_plan?: string[];
	assigned_to?: string | null;
	related_ids?: string[];
	author?: string | null;
}

export interface UpdateInput {
	title?: string;
	description?: string;
	severity?: Severity;
	category?: RiskCategory;
	recommendation?: Recommendation;
	reason?: string;
	mitigation_plan?: string[];
	assigned_to?: string | null;
	related_ids?: string[];
}

export interface ListFilter {
	status?: IncidentStatus;
	severity?: Severity;
	category?: RiskCategory;
	source?: Source;
	limit?: number;
}

export class AmygdalaLedger {
	readonly project?: string;
	private incidentsById: Map<string, Incident>;

	constructor(project?: string, incidents: Incident[] = []) {
		this.project = project;
		this.incidentsById = new Map(incidents.map((i) => [i.id, clone(i)]));
	}

	assess(input: AssessInput): Incident {
		const desc = (input.description ?? "").trim();
		if (!desc) throw new AmygdalaError("invalid_arg", "assess requires description");
		const assessment = triage(desc, input);
		const id = this.nextId();
		const ts = now();
		const incident: Incident = {
			id,
			title: input.title?.trim() || summarizeTitle(desc),
			description: desc,
			source: input.source ?? "manual",
			source_id: input.source_id ?? null,
			severity: assessment.severity,
			category: assessment.category,
			status: "open",
			recommendation: assessment.recommendation,
			reason: input.reason ?? assessment.reason,
			mitigation_plan: input.mitigation_plan?.length ? [...input.mitigation_plan] : defaultMitigation(assessment.recommendation),
			assigned_to: input.assigned_to ?? null,
			related_ids: input.related_ids ? [...input.related_ids] : [],
			notes: input.author ? [{ ts, author: input.author, text: "incident assessed" }] : [],
			created_at: ts,
			updated_at: ts,
			resolved_at: null,
		};
		this.incidentsById.set(id, incident);
		return clone(incident);
	}

	update(id: string, patch: UpdateInput): Incident {
		const i = this.require(id);
		if (patch.title !== undefined) i.title = patch.title;
		if (patch.description !== undefined) i.description = patch.description;
		if (patch.severity !== undefined) i.severity = patch.severity;
		if (patch.category !== undefined) i.category = patch.category;
		if (patch.recommendation !== undefined) i.recommendation = patch.recommendation;
		if (patch.reason !== undefined) i.reason = patch.reason;
		if (patch.mitigation_plan !== undefined) i.mitigation_plan = [...patch.mitigation_plan];
		if (patch.assigned_to !== undefined) i.assigned_to = patch.assigned_to;
		if (patch.related_ids !== undefined) i.related_ids = [...patch.related_ids];
		i.updated_at = now();
		return clone(i);
	}

	setStatus(id: string, status: IncidentStatus, note?: string, author?: string | null): Incident {
		const i = this.require(id);
		if (!canTransition(i.status, status)) throw new AmygdalaError("invalid_transition", `cannot transition ${id} from ${i.status} to ${status}`);
		i.status = status;
		if (["resolved", "accepted", "cancelled"].includes(status)) i.resolved_at = now();
		if (note) i.notes.push({ ts: now(), author: author ?? null, text: note });
		i.updated_at = now();
		return clone(i);
	}

	addNote(id: string, text: string, author?: string | null): Incident {
		if (!text.trim()) throw new AmygdalaError("invalid_arg", "add_note requires note");
		const i = this.require(id);
		i.notes.push({ ts: now(), author: author ?? null, text });
		i.updated_at = now();
		return clone(i);
	}

	resolve(id: string, note?: string, author?: string | null): Incident { return this.setStatus(id, "resolved", note, author); }
	accept(id: string, note?: string, author?: string | null): Incident { return this.setStatus(id, "accepted", note, author); }
	delete(id: string): Incident { const i = this.require(id); this.incidentsById.delete(id); return clone(i); }
	get(id: string): Incident | undefined { const i = this.incidentsById.get(id); return i ? clone(i) : undefined; }
	all(): Incident[] { return Array.from(this.incidentsById.values()).map(clone).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
	list(filter: ListFilter = {}): Incident[] {
		let xs = this.all();
		if (filter.status) xs = xs.filter((i) => i.status === filter.status);
		if (filter.severity) xs = xs.filter((i) => i.severity === filter.severity);
		if (filter.category) xs = xs.filter((i) => i.category === filter.category);
		if (filter.source) xs = xs.filter((i) => i.source === filter.source);
		const limit = filter.limit ?? 20;
		return limit > 0 ? xs.slice(0, limit) : xs;
	}
	summary(limit = 10): AmygdalaSummary {
		const all = this.all();
		const by_status: Partial<Record<IncidentStatus, number>> = {};
		const by_severity: Partial<Record<Severity, number>> = {};
		for (const i of all) { by_status[i.status] = (by_status[i.status] ?? 0) + 1; by_severity[i.severity] = (by_severity[i.severity] ?? 0) + 1; }
		const active = all.filter((i) => !["resolved", "accepted", "cancelled"].includes(i.status));
		return {
			total: all.length,
			by_status,
			by_severity,
			open_critical: active.filter((i) => i.severity === "critical").map((i) => i.id),
			needs_attention: active.filter((i) => ["high", "critical"].includes(i.severity) || ["pause", "stop", "human_review", "convene_magi"].includes(i.recommendation)).map((i) => ({ id: i.id, title: i.title, severity: i.severity, recommendation: i.recommendation })),
			recent: limit > 0 ? all.slice(0, limit) : all,
		};
	}
	toJSON(): AmygdalaFile { const incidents: Record<string, Incident> = {}; for (const i of this.incidentsById.values()) incidents[i.id] = clone(i); return { version: VERSION, project: this.project, updated_at: now(), incidents }; }
	static fromJSON(raw: unknown): AmygdalaLedger {
		const obj = isObject(raw) ? raw : {};
		const incidentsObj = isObject(obj.incidents) ? obj.incidents : {};
		const incidents: Incident[] = [];
		for (const [id, value] of Object.entries(incidentsObj)) { const i = coerceIncident(id, value); if (i) incidents.push(i); }
		return new AmygdalaLedger(typeof obj.project === "string" ? obj.project : undefined, incidents);
	}
	private require(id: string): Incident { const i = this.incidentsById.get(id); if (!i) throw new AmygdalaError("not_found", `incident ${id} not found`); return i; }
	private nextId(): string { let max = 0; for (const id of this.incidentsById.keys()) { const m = /^risk-(\d+)$/.exec(id); if (m) max = Math.max(max, Number(m[1])); } return `risk-${String(max + 1).padStart(3, "0")}`; }
}

function triage(text: string, input: Partial<AssessInput>): { severity: Severity; category: RiskCategory; recommendation: Recommendation; reason: string } {
	const lower = text.toLowerCase();
	const category = input.category ?? inferCategory(lower);
	const severity = input.severity ?? inferSeverity(lower, category);
	const recommendation = input.recommendation ?? inferRecommendation(severity, category, lower);
	return { severity, category, recommendation, reason: `heuristic triage: ${severity}/${category} → ${recommendation}` };
}
function inferCategory(s: string): RiskCategory {
	if (/secret|credential|token|auth|permission|vulnerab|security/.test(s)) return "security";
	if (/delete|data loss|drop|truncate|destructive|overwrite/.test(s)) return "data_loss";
	if (/regression|break|failing test|test fail/.test(s)) return "regression";
	if (/dependency|missing package|version|install/.test(s)) return "dependency";
	if (/blocked|blocker|cannot proceed|stuck/.test(s)) return "blocker";
	if (/scope|ambiguous|unclear|requirements/.test(s)) return "scope";
	if (/policy|legal|privacy|pii/.test(s)) return "policy";
	if (/unknown|uncertain|not sure|risk/.test(s)) return "uncertainty";
	return "unknown";
}
function inferSeverity(s: string, c: RiskCategory): Severity {
	if (/critical|production|prod|data loss|secret|credential|security|irreversible/.test(s) || c === "data_loss" || c === "security") return "critical";
	if (/blocked|cannot proceed|failing test|regression|high/.test(s) || c === "blocker" || c === "regression") return "high";
	if (/unclear|dependency|medium|scope/.test(s) || c === "dependency" || c === "scope") return "medium";
	return "low";
}
function inferRecommendation(sev: Severity, cat: RiskCategory, s: string): Recommendation {
	if (sev === "critical" || cat === "security" || cat === "data_loss" || cat === "policy") return "human_review";
	if (cat === "blocker") return "pause";
	if (cat === "scope" || cat === "uncertainty" || /architect|decision|tradeoff/.test(s)) return "convene_magi";
	if (cat === "regression") return "replan";
	if (cat === "dependency") return "retry";
	return "continue";
}
function defaultMitigation(r: Recommendation): string[] {
	switch (r) {
		case "human_review": return ["pause affected work", "capture evidence", "request human review before continuing"];
		case "convene_magi": return ["pause broad changes", "convene MAGI for tradeoff review", "update CORTEX/AXON plan"];
		case "pause": return ["mark related AXON task blocked", "identify unblock condition", "resume only after blocker cleared"];
		case "replan": return ["record failure evidence", "return to CORTEX/CEREBEL replan", "create revised AXON tasks"];
		case "retry": return ["retry with bounded attempt", "record result", "escalate if repeated"];
		case "stop": return ["stop work", "preserve state", "await explicit approval"];
		default: return ["continue with caution", "monitor for recurrence"];
	}
}
function summarizeTitle(s: string): string { const flat = s.replace(/\s+/g, " ").trim(); return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat; }
function coerceIncident(id: string, value: unknown): Incident | null {
	if (!isObject(value)) return null; const created = typeof value.created_at === "string" ? value.created_at : now();
	return { id: typeof value.id === "string" ? value.id : id, title: typeof value.title === "string" ? value.title : id, description: typeof value.description === "string" ? value.description : "", source: enumVal(value.source, SOURCE_SET, "manual") as Source, source_id: typeof value.source_id === "string" ? value.source_id : null, severity: enumVal(value.severity, SEVERITY_SET, "medium") as Severity, category: enumVal(value.category, CATEGORY_SET, "unknown") as RiskCategory, status: enumVal(value.status, STATUS_SET, "open") as IncidentStatus, recommendation: enumVal(value.recommendation, REC_SET, "pause") as Recommendation, reason: typeof value.reason === "string" ? value.reason : "", mitigation_plan: strings(value.mitigation_plan), assigned_to: typeof value.assigned_to === "string" ? value.assigned_to : null, related_ids: strings(value.related_ids), notes: Array.isArray(value.notes) ? value.notes.filter(isObject).map((n) => ({ ts: typeof n.ts === "string" ? n.ts : now(), author: typeof n.author === "string" ? n.author : null, text: typeof n.text === "string" ? n.text : "" })) : [], created_at: created, updated_at: typeof value.updated_at === "string" ? value.updated_at : created, resolved_at: typeof value.resolved_at === "string" ? value.resolved_at : null };
}
function enumVal(v: unknown, set: Set<string>, fallback: string): string { return typeof v === "string" && set.has(v) ? v : fallback; }
function isObject(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null; }
