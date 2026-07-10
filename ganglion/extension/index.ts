/** GANGLION — pi extension entry point. */

import * as fs from "node:fs/promises";
import { resolveNervousStateFile } from "@nervous-system/state";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GanglionStore } from "./backend.ts";
import { GanglionError, GanglionToolParams, type AllocationStatus, type Ganglion, type GanglionReconcileReport, type GanglionStatus, type GanglionSummary, type GanglionToolInput, type MemberStatus } from "./schema.ts";
import type { GanglionRecordResult, LionRunBrief } from "./store.ts";
import { renderGanglionCall, renderGanglionResult, summarizeGanglion, summarizeList, summarizeSummary } from "./render.ts";

interface GanglionDetails { action: string; ganglion?: Ganglion; ganglions?: Ganglion[]; summary?: GanglionSummary; reconcile?: GanglionReconcileReport; record?: GanglionRecordResult; error?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: GanglionDetails; isError?: boolean };
const ok = (action: string, text: string, details: Omit<GanglionDetails, "action"> = {}): ToolResult => ({ content: [{ type: "text", text }], details: { action, ...details } });
const fail = (action: string, message: string): ToolResult => ({ content: [{ type: "text", text: message }], details: { action, error: message }, isError: true });
async function runOp(store: GanglionStore, action: string, op: (l: import("./store.ts").GanglionLedger) => ToolResult): Promise<ToolResult> { try { const { result } = await store.mutate(op); return result; } catch (e) { return e instanceof GanglionError ? fail(action, `ganglion ${action} failed (${e.code}): ${e.message}`) : fail(action, `ganglion ${action} failed: ${e instanceof Error ? e.message : String(e)}`); } }
async function runQuery(store: GanglionStore, action: string, op: (l: import("./store.ts").GanglionLedger) => ToolResult): Promise<ToolResult> { try { const { result } = await store.query(op); return result; } catch (e) { return fail(action, `ganglion ${action} failed: ${e instanceof Error ? e.message : String(e)}`); } }
function gid(l: import("./store.ts").GanglionLedger, id?: string): string | undefined { if (!id || id === "current" || id === "latest") return l.current_ganglion_id ?? l.current()?.id; return id; }

async function loadLionRunBriefs(cwd: string): Promise<LionRunBrief[]> {
	const runsPath = resolveNervousStateFile(cwd, "lion", "runs.json", "LION_RUNS_PATH");
	let raw: string;
	try { raw = await fs.readFile(runsPath, "utf8"); }
	catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
	const parsed = JSON.parse(raw) as { runs?: Record<string, unknown> };
	return Object.values(parsed.runs ?? {}).flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const r = value as Record<string, unknown>;
		if (typeof r.id !== "string" || typeof r.agent_id !== "string" || typeof r.status !== "string") return [];
		const report = typeof r.report === "object" && r.report !== null ? r.report as { summary?: unknown } : undefined;
		return [{ id: r.id, agent_id: r.agent_id, status: r.status, task_id: typeof r.task_id === "string" ? r.task_id : null, summary: typeof report?.summary === "string" ? report.summary : typeof r.error === "string" ? r.error : null, updated_at: typeof r.updated_at === "string" ? r.updated_at : undefined }];
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ganglion",
		label: "GANGLION",
		description: [
			"Working-group roster and capability allocator for LION agents. Create LION slots, track availability,",
			"allocate ready AXON tasks to suitable members, record/release member capacity, and reconcile stale capacity from LION runs. It does not execute work.",
			"Actions: create, add_member, update_member, remove_member, set_status, allocate, record, release, reconcile, get, list, summary, delete.",
		].join(" "),
		promptSnippet: "Manage a GANGLION working group of LION slots and allocate ready tasks by capability/capacity",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use ganglion to define or inspect the LION roster before CEREBEL dispatches worker waves.",
			"Use ganglion allocate on ready AXON task briefs to choose member ids/objectives for CEREBEL/LION.",
			"After LION runs finish, use CEREBEL record for linked assignments or ganglion record/release so capacity is available for later waves.",
			"Use ganglion reconcile if dashboard or summaries show busy members whose linked LION runs are terminal.",
			"Do not use ganglion to execute work; CEREBEL orchestrates and LION executes.",
		],
		parameters: GanglionToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = GanglionStore.fromCwd(ctx.cwd);
			const p = params as GanglionToolInput;
			const action = p.action;
			switch (action) {
				case "create": return runOp(store, action, (l) => { const g = l.create({ name: p.name, goal_id: p.goal_id, max_parallel: p.max_parallel, member_count: p.member_count, members: p.members?.map((m) => ({ id: m.id, role: m.role, capabilities: m.capabilities, model: m.model, tools: m.tools, status: m.status as MemberStatus | undefined })) }); return ok(action, `Created ${g.id}: ${g.name} with ${g.members.length} member(s).`, { ganglion: g }); });
				case "add_member": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id) return fail(action, "add_member requires ganglion_id or current ganglion."); const g = l.addMember(id, { id: p.member_id, role: p.role, capabilities: p.capabilities, model: p.model, tools: p.tools }); return ok(action, `Added member to ${g.id}.`, { ganglion: g }); });
				case "update_member": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id || !p.member_id) return fail(action, "update_member requires ganglion_id/current and member_id."); const g = l.updateMember(id, p.member_id, { role: p.role, capabilities: p.capabilities, model: p.model, tools: p.tools, status: p.member_status as MemberStatus | undefined }); return ok(action, `Updated ${p.member_id}.`, { ganglion: g }); });
				case "remove_member": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id || !p.member_id) return fail(action, "remove_member requires ganglion_id/current and member_id."); const g = l.removeMember(id, p.member_id); return ok(action, `Removed ${p.member_id}.`, { ganglion: g }); });
				case "set_status": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id || !p.status) return fail(action, "set_status requires ganglion_id/current and status."); const g = l.setStatus(id, p.status as GanglionStatus); return ok(action, `${g.id} → ${g.status}.`, { ganglion: g }); });
				case "allocate": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id) return fail(action, "allocate requires ganglion_id or current ganglion."); if (!p.tasks?.length) return fail(action, "allocate requires tasks."); const g = l.allocate(id, { tasks: p.tasks, context: p.context }); const latest = g.allocations.slice(-p.tasks.length); return ok(action, `Allocated ${latest.length} task(s) in ${g.id}.`, { ganglion: g }); });
				case "record": return runOp(store, action, (l) => {
					const id = gid(l, p.ganglion_id); const status = p.allocation_status;
					if (!id || !status) return fail(action, "record requires ganglion_id/current and allocation_status.");
					const record = l.recordWithResult(id, { allocation_id: p.allocation_id, task_id: p.task_id, lion_run_id: p.lion_run_id, status: status as AllocationStatus, summary: p.summary });
					const disposition = record.release_disposition === "released" ? "capacity released"
						: record.release_disposition === "already_free" ? "capacity already free"
						: record.release_disposition === "member_unavailable" ? "member has no active lease but remains unavailable"
						: record.release_disposition === "retained_by_newer_allocation" ? "capacity retained by newer allocation"
						: "no terminal capacity release";
					return ok(action, `Recorded allocation result in ${record.ganglion.id}; ${disposition}.`, { ganglion: record.ganglion, record });
				});
				case "release": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); const target = p.allocation_id ?? p.member_id; if (!id || !target) return fail(action, "release requires ganglion_id/current and allocation_id or member_id."); const g = l.release(id, target); return ok(action, `Released ${target} in ${g.id}.`, { ganglion: g }); });
				case "reconcile": {
					let runs: LionRunBrief[];
					try { runs = await loadLionRunBriefs(ctx.cwd); }
					catch (e) { return fail(action, `reconcile failed reading LION runs: ${e instanceof Error ? e.message : String(e)}`); }
					return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id) return fail(action, "reconcile requires ganglion_id or current ganglion."); const reconcile = l.reconcile(id, runs); const extra = reconcile.inconsistencies.length ? ` (${reconcile.inconsistencies.length} inconsistency warning(s))` : ""; return ok(action, `Reconciled ${id}: released ${reconcile.released.length} member(s)${extra}.`, { ganglion: reconcile.ganglion, reconcile }); });
				}
				case "get": return runQuery(store, action, (l) => { const id = gid(l, p.ganglion_id); const g = id ? l.get(id) : l.current(); if (!g) return fail(action, "No GANGLION found."); return ok(action, summarizeGanglion(g), { ganglion: g }); });
				case "list": return runQuery(store, action, (l) => { const ganglions = l.list({ status: p.status_filter as GanglionStatus | undefined, limit: p.limit }); return ok(action, summarizeList(ganglions), { ganglions }); });
				case "summary": return runQuery(store, action, (l) => { const summary = l.summary(p.limit ?? 10); return ok(action, summarizeSummary(summary), { summary }); });
				case "delete": return runOp(store, action, (l) => { const id = gid(l, p.ganglion_id); if (!id) return fail(action, "delete requires ganglion_id/current."); const g = l.delete(id); return ok(action, `Deleted ${g.id}.`, { ganglion: g }); });
				default: return fail(action, `Unknown action: ${action as string}`);
			}
		},
		renderCall(args, theme) { return renderGanglionCall(args as { action: string; ganglion_id?: string; name?: string }, theme as never); },
		renderResult(result, options, theme) { return renderGanglionResult(result as Parameters<typeof renderGanglionResult>[0], options as Parameters<typeof renderGanglionResult>[1], theme as never); },
	});

	pi.registerCommand("ganglion", { description: "Show GANGLION summary", handler: async (_args, ctx) => { const store = GanglionStore.fromCwd(ctx.cwd); const { result } = await store.query((l) => l.summary(10)); post(ctx, pi, summarizeSummary(result), { summary: result }); } });
	pi.registerCommand("ganglion:groups", { description: "List GANGLION groups", handler: async (_args, ctx) => { const store = GanglionStore.fromCwd(ctx.cwd); const { result } = await store.query((l) => l.list({ limit: 20 })); post(ctx, pi, summarizeList(result), { ganglions: result }); } });
}

function post(ctx: ExtensionContext, pi: ExtensionAPI, markdown: string, details: Record<string, unknown>): void {
	if (ctx.hasUI) pi.sendMessage({ customType: "ganglion", content: markdown, display: true, details }, { triggerTurn: false });
	else ctx.ui.notify(markdown, "info");
}
