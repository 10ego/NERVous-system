/** CEREBEL — pi extension entry point. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CerebelStore } from "./backend.ts";
import { CerebelError, CerebelToolParams, type Assignment, type AssignmentStatus, type CerebelToolInput, type CerebelSummary, type Wave, type WaveStatus } from "./schema.ts";
import { renderCerebelCall, renderCerebelResult, summarizeList, summarizeSummary, summarizeWave } from "./render.ts";

interface CerebelDetails { action: string; wave?: Wave; waves?: Wave[]; summary?: CerebelSummary; error?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: CerebelDetails; isError?: boolean };

function ok(action: string, text: string, details: Omit<CerebelDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, error: message }, isError: true };
}
async function runOp(store: CerebelStore, action: string, op: (l: import("./store.ts").CerebelLedger) => ToolResult): Promise<ToolResult> {
	try { const { result } = await store.mutate(op); return result; }
	catch (e) { return e instanceof CerebelError ? fail(action, `cerebel ${action} failed (${e.code}): ${e.message}`) : fail(action, `cerebel ${action} failed: ${e instanceof Error ? e.message : String(e)}`); }
}
async function runQuery(store: CerebelStore, action: string, op: (l: import("./store.ts").CerebelLedger) => ToolResult): Promise<ToolResult> {
	try { const { result } = await store.query(op); return result; }
	catch (e) { return fail(action, `cerebel ${action} failed: ${e instanceof Error ? e.message : String(e)}`); }
}
function waveId(l: import("./store.ts").CerebelLedger, id?: string): string | undefined {
	if (!id || id === "current" || id === "latest") return l.current_wave_id ?? l.current()?.id;
	return id;
}

function isTerminalAssignment(status: AssignmentStatus): boolean { return ["completed", "partial", "blocked", "failed", "cancelled"].includes(status); }
function ganglionStatusFromAssignment(status: AssignmentStatus): "completed" | "blocked" | "failed" | "cancelled" { return status === "blocked" ? "blocked" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed"; }
function findRecordedAssignment(wave: Wave, p: CerebelToolInput): Assignment | undefined {
	return wave.assignments.find((a) => (p.assignment_id && a.id === p.assignment_id) || (p.task_id && a.task_id === p.task_id) || (p.lion_run_id && a.lion_run_id === p.lion_run_id));
}
async function recordLinkedGanglion(cwd: string, assignment: Assignment | undefined, p: CerebelToolInput, outcome: AssignmentStatus): Promise<string | null> {
	if (!assignment || !isTerminalAssignment(outcome)) return null;
	const ganglionId = p.ganglion_id ?? assignment.ganglion_id;
	const allocationId = p.ganglion_allocation_id ?? assignment.ganglion_allocation_id;
	if (!allocationId) return null;
	if (!ganglionId) return `GANGLION release skipped: assignment ${assignment.id} has allocation ${allocationId} but no ganglion_id.`;
	try {
		const { GanglionStore } = await import("../../ganglion/extension/backend.ts");
		await GanglionStore.fromCwd(cwd).mutate((l) => l.record(ganglionId, { allocation_id: allocationId, lion_run_id: p.lion_run_id ?? assignment.lion_run_id ?? undefined, status: ganglionStatusFromAssignment(outcome), summary: p.summary }));
		return `GANGLION ${ganglionId}/${allocationId} recorded and capacity released.`;
	} catch (e) {
		return `GANGLION release failed for ${ganglionId}/${allocationId}: ${e instanceof Error ? e.message : String(e)}`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cerebel",
		label: "CEREBEL",
		description: [
			"Orchestration controller for LION worker waves. Forms assignments from ready AXON tasks,",
			"records LION run outcomes, and decides whether to dispatch, wait, complete, replan, or escalate.",
			"State persists in the active NERVous project/context namespace. Actions: plan_wave, dispatch, record, decide, complete_wave, cancel, get, list, summary.",
		].join(" "),
		promptSnippet: "Orchestrate ready AXON tasks into LION worker waves and record outcomes",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use cerebel after CORTEX has planned work into AXON and ready AXON tasks exist.",
			"First read axon list/summary, then pass ready task briefs into cerebel plan_wave.",
			"For each ready assignment, call lion run with task_id/objective/context/agent_id, then cerebel dispatch/record the LION run id and outcome.",
			"When assignments come from GANGLION, include ganglion_id and ganglion_allocation_id on the CEREBEL assignment/dispatch/record so CEREBEL releases member capacity on terminal outcomes.",
			"After blocked/failed results: cerebel record/decide, update AXON, post a SYNAPSE risk/blocker note, then use AMYGDALA or replan; never silently continue.",
		],
		parameters: CerebelToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = CerebelStore.fromCwd(ctx.cwd);
			const p = params as CerebelToolInput;
			const action = p.action;
			switch (action) {
				case "plan_wave": {
					return runOp(store, action, (l) => {
						const wave = l.planWave({ goal_id: p.goal_id, tasks: p.tasks, assignments: p.assignments, context: p.context, max_parallel: p.max_parallel });
						return ok(action, `Planned ${wave.id}: ${wave.assignments.length} assignment(s). Next: run LION for ready assignments, then cerebel dispatch/record.`, { wave });
					});
				}
				case "dispatch": {
					return runOp(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						if (!id) return fail(action, "dispatch requires wave_id or current wave.");
						const wave = l.dispatch(id, { links: p.links });
						return ok(action, `Dispatched ${wave.id}. Decision: ${wave.decision?.decision ?? "—"}.`, { wave });
					});
				}
				case "record": {
					const outcome = p.outcome;
					if (!outcome) return fail(action, "record requires `outcome`.");
					const result = await runOp(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						if (!id) return fail(action, "record requires wave_id or current wave.");
						const wave = l.record(id, { assignment_id: p.assignment_id, task_id: p.task_id, lion_run_id: p.lion_run_id, ganglion_id: p.ganglion_id, ganglion_allocation_id: p.ganglion_allocation_id, outcome, summary: p.summary, changed_files: p.changed_files, tests_run: p.tests_run, blockers: p.blockers, next_steps: p.next_steps });
						return ok(action, `Recorded result in ${wave.id}. Decision: ${wave.decision?.decision ?? "—"}.`, { wave });
					});
					const assignment = result.details.wave ? findRecordedAssignment(result.details.wave, p) : undefined;
					const ganglionMessage = await recordLinkedGanglion(ctx.cwd, assignment, p, outcome as AssignmentStatus);
					if (ganglionMessage) result.content[0]!.text += ` ${ganglionMessage}`;
					return result;
				}
				case "decide": {
					return runOp(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						if (!id) return fail(action, "decide requires wave_id or current wave.");
						const decision = l.decide(id);
						const wave = l.get(id)!;
						return ok(action, `Decision for ${id}: ${decision.decision} — ${decision.reason}`, { wave });
					});
				}
				case "complete_wave": {
					return runOp(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						if (!id) return fail(action, "complete_wave requires wave_id or current wave.");
						const wave = l.complete(id);
						return ok(action, `Completed ${wave.id}.`, { wave });
					});
				}
				case "cancel": {
					return runOp(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						if (!id) return fail(action, "cancel requires wave_id or current wave.");
						const wave = l.cancel(id);
						return ok(action, `Cancelled ${wave.id}.`, { wave });
					});
				}
				case "get": {
					return runQuery(store, action, (l) => {
						const id = waveId(l, p.wave_id);
						const wave = id ? l.get(id) : l.current();
						if (!wave) return fail(action, "No CEREBEL wave found.");
						return ok(action, summarizeWave(wave), { wave });
					});
				}
				case "list": {
					return runQuery(store, action, (l) => {
						const waves = l.list({ status: p.status_filter as WaveStatus | undefined, limit: p.limit });
						return ok(action, summarizeList(waves), { waves });
					});
				}
				case "summary": {
					return runQuery(store, action, (l) => {
						const summary = l.summary(p.limit ?? 10);
						return ok(action, summarizeSummary(summary), { summary });
					});
				}
				default:
					return fail(action, `Unknown action: ${action as string}`);
			}
		},
		renderCall(args, theme) { return renderCerebelCall(args as { action: string; wave_id?: string }, theme as never); },
		renderResult(result, options, theme) { return renderCerebelResult(result as Parameters<typeof renderCerebelResult>[0], options as Parameters<typeof renderCerebelResult>[1], theme as never); },
	});

	pi.registerCommand("cerebel", { description: "Show CEREBEL orchestration summary", handler: async (_args, ctx) => {
		const store = CerebelStore.fromCwd(ctx.cwd);
		const { result } = await store.query((l) => l.summary(10));
		post(ctx, pi, summarizeSummary(result), { summary: result });
	} });
	pi.registerCommand("cerebel:waves", { description: "List recent CEREBEL waves", handler: async (_args, ctx) => {
		const store = CerebelStore.fromCwd(ctx.cwd);
		const { result } = await store.query((l) => l.list({ limit: 20 }));
		post(ctx, pi, summarizeList(result), { waves: result });
	} });
}

function post(ctx: ExtensionContext, pi: ExtensionAPI, markdown: string, details: Record<string, unknown>): void {
	if (ctx.hasUI) pi.sendMessage({ customType: "cerebel", content: markdown, display: true, details }, { triggerTurn: false });
	else ctx.ui.notify(markdown, "info");
}
