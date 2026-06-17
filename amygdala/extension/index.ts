/** AMYGDALA — pi extension entry point. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AmygdalaStore } from "./backend.ts";
import { AmygdalaError, AmygdalaToolParams, type AmygdalaSummary, type AmygdalaToolInput, type Incident, type IncidentStatus, type Recommendation, type RiskCategory, type Severity, type Source } from "./schema.ts";
import { renderAmygdalaCall, renderAmygdalaResult, summarizeIncident, summarizeList, summarizeSummary } from "./render.ts";

interface Details { action: string; incident?: Incident; incidents?: Incident[]; summary?: AmygdalaSummary; error?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Details; isError?: boolean };
const ok = (action: string, text: string, details: Omit<Details, "action"> = {}): ToolResult => ({ content: [{ type: "text", text }], details: { action, ...details } });
const fail = (action: string, message: string): ToolResult => ({ content: [{ type: "text", text: message }], details: { action, error: message }, isError: true });
async function runOp(store: AmygdalaStore, action: string, op: (l: import("./store.ts").AmygdalaLedger) => ToolResult): Promise<ToolResult> { try { const { result } = await store.mutate(op); return result; } catch (e) { return e instanceof AmygdalaError ? fail(action, `amygdala ${action} failed (${e.code}): ${e.message}`) : fail(action, `amygdala ${action} failed: ${e instanceof Error ? e.message : String(e)}`); } }
async function runQuery(store: AmygdalaStore, action: string, op: (l: import("./store.ts").AmygdalaLedger) => ToolResult): Promise<ToolResult> { try { const { result } = await store.query(op); return result; } catch (e) { return fail(action, `amygdala ${action} failed: ${e instanceof Error ? e.message : String(e)}`); } }

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "amygdala",
		label: "AMYGDALA",
		description: ["Risk escalation and safety triage. Capture blockers, unsafe operations, failed orchestration, and uncertainty as durable incidents.", "Returns severity/category/recommendation and mitigation plan. Actions: assess, update, set_status, add_note, resolve, accept, get, list, summary, delete."].join(" "),
		promptSnippet: "Assess and persist a risk/blocker incident with severity, recommendation, and mitigation plan",
		promptGuidelines: [
			"Use amygdala assess when AXON tasks are needs_amygdala/blocked, CEREBEL waves are blocked, or work risks security/data loss/regression.",
			"Critical/security/data-loss risks should pause affected work and request human review unless explicitly accepted.",
			"For blocker/risk workflows, also post a short SYNAPSE risk/blocker coordination note so other agents know work is paused.",
			"Describe destructive hazards as data-loss risk; avoid recommending or normalizing unsafe action unless explicitly human-approved.",
			"Record mitigation notes and resolve/accept incidents before CORTEX final verification.",
		],
		parameters: AmygdalaToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = AmygdalaStore.fromCwd(ctx.cwd);
			const p = params as AmygdalaToolInput;
			const action = p.action;
			switch (action) {
				case "assess": return runOp(store, action, (l) => { if (!p.description) return fail(action, "assess requires description."); const i = l.assess({ title: p.title, description: p.description, source: p.source as Source | undefined, source_id: p.source_id, severity: p.severity as Severity | undefined, category: p.category as RiskCategory | undefined, recommendation: p.recommendation as Recommendation | undefined, reason: p.reason, mitigation_plan: p.mitigation_plan, assigned_to: p.assigned_to, related_ids: p.related_ids, author: p.author }); return ok(action, `Assessed ${i.id}: ${i.severity}/${i.category} → ${i.recommendation}.`, { incident: i }); });
				case "update": return runOp(store, action, (l) => { if (!p.id) return fail(action, "update requires id."); const i = l.update(p.id, { title: p.title, description: p.description, severity: p.severity as Severity | undefined, category: p.category as RiskCategory | undefined, recommendation: p.recommendation as Recommendation | undefined, reason: p.reason, mitigation_plan: p.mitigation_plan, assigned_to: p.assigned_to, related_ids: p.related_ids }); return ok(action, `Updated ${i.id}.`, { incident: i }); });
				case "set_status": return runOp(store, action, (l) => { if (!p.id || !p.status) return fail(action, "set_status requires id and status."); const i = l.setStatus(p.id, p.status as IncidentStatus, p.note, p.author); return ok(action, `${i.id} → ${i.status}.`, { incident: i }); });
				case "add_note": return runOp(store, action, (l) => { if (!p.id || !p.note) return fail(action, "add_note requires id and note."); const i = l.addNote(p.id, p.note, p.author); return ok(action, `Added note to ${i.id}.`, { incident: i }); });
				case "resolve": return runOp(store, action, (l) => { if (!p.id) return fail(action, "resolve requires id."); const i = l.resolve(p.id, p.note, p.author); return ok(action, `Resolved ${i.id}.`, { incident: i }); });
				case "accept": return runOp(store, action, (l) => { if (!p.id) return fail(action, "accept requires id."); const i = l.accept(p.id, p.note, p.author); return ok(action, `Accepted ${i.id}.`, { incident: i }); });
				case "get": return runQuery(store, action, (l) => { if (!p.id) return fail(action, "get requires id."); const i = l.get(p.id); if (!i) return fail(action, `Incident ${p.id} not found.`); return ok(action, summarizeIncident(i), { incident: i }); });
				case "list": return runQuery(store, action, (l) => { const incidents = l.list({ status: p.status_filter as IncidentStatus | undefined, severity: p.severity_filter as Severity | undefined, category: p.category_filter as RiskCategory | undefined, source: p.source_filter as Source | undefined, limit: p.limit }); return ok(action, summarizeList(incidents), { incidents }); });
				case "summary": return runQuery(store, action, (l) => { const summary = l.summary(p.limit ?? 10); return ok(action, summarizeSummary(summary), { summary }); });
				case "delete": return runOp(store, action, (l) => { if (!p.id) return fail(action, "delete requires id."); const i = l.delete(p.id); return ok(action, `Deleted ${i.id}.`, { incident: i }); });
				default: return fail(action, `Unknown action: ${action as string}`);
			}
		},
		renderCall(args, theme) { return renderAmygdalaCall(args as { action: string; id?: string; title?: string }, theme as never); },
		renderResult(result, options, theme) { return renderAmygdalaResult(result as Parameters<typeof renderAmygdalaResult>[0], options as Parameters<typeof renderAmygdalaResult>[1], theme as never); },
	});
	pi.registerCommand("amygdala", { description: "Show AMYGDALA risk summary", handler: async (_args, ctx) => { const store = AmygdalaStore.fromCwd(ctx.cwd); const { result } = await store.query((l) => l.summary(10)); post(ctx, pi, summarizeSummary(result), { summary: result }); } });
	pi.registerCommand("amygdala:risks", { description: "List AMYGDALA incidents", handler: async (_args, ctx) => { const store = AmygdalaStore.fromCwd(ctx.cwd); const { result } = await store.query((l) => l.list({ limit: 20 })); post(ctx, pi, summarizeList(result), { incidents: result }); } });
}
function post(ctx: ExtensionContext, pi: ExtensionAPI, markdown: string, details: Record<string, unknown>): void { if (ctx.hasUI) pi.sendMessage({ customType: "amygdala", content: markdown, display: true, details }, { triggerTurn: false }); else ctx.ui.notify(markdown, "info"); }
