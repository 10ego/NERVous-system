/** CEREBEL — pi extension entry point. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadNervousConfig, resolveNervousModel, type NervousModelKey } from "@nervous-system/state";
import { CerebelStore } from "./backend.ts";
import { CerebelError, CerebelToolParams, type Assignment, type AssignmentStatus, type CerebelToolInput, type CerebelSummary, type Wave, type WaveStatus } from "./schema.ts";
import { renderCerebelCall, renderCerebelResult, RUN_WAVE_DASHBOARD_HINT, summarizeList, summarizeSummary, summarizeWave } from "./render.ts";
import { runWave, type RunWaveLionAdapter } from "./run-wave.ts";
import type { LionModelRole, LionProgressSnapshot, LionRun, LionRunnerMode } from "../../lion/extension/schema.ts";

interface CerebelDetails { action: string; wave?: Wave; waves?: Wave[]; summary?: CerebelSummary; run_wave?: import("./run-wave.ts").RunWaveResult; error?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: CerebelDetails; isError?: boolean };

type LionRunner = (req: import("../../lion/extension/subprocess.ts").LionRunRequest) => Promise<{ text: string; report: import("../../lion/extension/schema.ts").LionReport | null }>;
interface LionAdapterDeps {
	lionStore?: { namespaceId: string; mutate<T>(fn: (ledger: import("../../lion/extension/store.ts").LionLedger) => T): Promise<{ result: T }>; query<T>(fn: (ledger: import("../../lion/extension/store.ts").LionLedger) => T): Promise<{ result: T }> };
	createLionRunner?: (opts: { cwd: string }) => LionRunner;
	createLionRpcRunner?: (opts: { cwd: string; store: unknown }) => LionRunner;
	activeRuns?: typeof import("../../lion/extension/active-runs.ts");
}

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

const DEFAULT_RUN_WAVE_TIMEOUT_MS = 10 * 60_000;

function modelKeyForRole(role: LionModelRole): NervousModelKey {
	if (role === "review") return "lion.reviewDefault";
	if (role === "implementation") return "lion.implementationDefault";
	return "lion.default";
}

function resolveConfiguredLionModel(ctx: ExtensionContext, role: LionModelRole): string | undefined {
	const config = loadNervousConfig({ cwd: ctx.cwd, isProjectTrusted: () => ctx.isProjectTrusted?.() ?? false });
	const roleModel = resolveNervousModel(config, modelKeyForRole(role)).model;
	if (roleModel) return roleModel;
	if (role !== "default") return resolveNervousModel(config, "lion.default").model;
	return undefined;
}

const RUNNER_MODES = new Set<string>(["json", "rpc"]);
function isRunnerMode(value: unknown): value is LionRunnerMode {
	return typeof value === "string" && RUNNER_MODES.has(value);
}

function resolveRunnerMode(input?: string): LionRunnerMode {
	const explicit = input?.trim();
	if (isRunnerMode(explicit)) return explicit;
	const env = process.env.LION_RUNNER?.trim();
	return isRunnerMode(env) ? env : "json";
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

export async function createLionAdapter(ctx: ExtensionContext, p: CerebelToolInput, signal: AbortSignal | undefined, onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined, deps: LionAdapterDeps = {}): Promise<RunWaveLionAdapter> {
	try {
		const [{ LionStore }, jsonRunnerMod, rpcRunnerMod, activeRunsMod] = await Promise.all([
			deps.lionStore ? Promise.resolve({ LionStore: { fromCwd: () => deps.lionStore! as never } }) : import("../../lion/extension/backend.ts"),
			deps.createLionRunner ? Promise.resolve({ createLionRunner: deps.createLionRunner }) : import("../../lion/extension/subprocess.ts"),
			deps.createLionRpcRunner ? Promise.resolve({ createLionRpcRunner: deps.createLionRpcRunner }) : import("../../lion/extension/rpc-runner.ts"),
			deps.activeRuns ? Promise.resolve(deps.activeRuns) : import("../../lion/extension/active-runs.ts"),
		]);
		const { createLionRunner } = jsonRunnerMod;
		const { createLionRpcRunner } = rpcRunnerMod;
		const activeRuns = activeRunsMod;
		const lionStore = LionStore.fromCwd(ctx.cwd);
		const modelRole = (p.model_role as LionModelRole | undefined) ?? "implementation";
		const model = p.model?.trim() || resolveConfiguredLionModel(ctx, modelRole);
		const runnerMode = resolveRunnerMode(p.runner_mode);
		const runner = runnerMode === "rpc" ? createLionRpcRunner({ cwd: ctx.cwd, store: lionStore }) : createLionRunner({ cwd: ctx.cwd });
		const activeOwners = new Map<string, ReturnType<typeof activeRuns.beginActiveRun>>();
		return {
			async createRun(assignment) {
				const { result } = await lionStore.mutate((l) => l.create({
					agent_id: assignment.agent_id,
					task_id: assignment.task_id,
					objective: assignment.objective,
					context: assignment.context,
					model,
					model_role: modelRole,
					runner_mode: runnerMode,
					tools: p.tools,
					start: true,
				}));
				return result;
			},
			async run(run: LionRun, _assignment, onProgress) {
				const activeOwner = activeRuns.beginActiveRun({ namespaceId: lionStore.namespaceId, runId: run.id }, runnerMode);
				activeOwners.set(run.id, activeOwner);
				return runner({
					run,
					signal,
					timeout_ms: p.timeout_ms ?? DEFAULT_RUN_WAVE_TIMEOUT_MS,
					onProcessStart: (info) => {
						activeRuns.attachActiveRunProcess(activeOwner, info);
						void lionStore.mutate((l) => l.updateControl(run.id, { pid: info.pid, pgid: info.pgid, started_at: new Date().toISOString() })).catch(() => undefined).finally(() => activeRuns.replayPendingCancellation(activeOwner, lionStore).catch(() => undefined));
					},
					onControlClosed: () => activeRuns.markActiveRunExited(activeOwner),
					onProcessExit: () => activeRuns.markActiveRunExited(activeOwner),
					onProgress: (progress: LionProgressSnapshot) => {
						try { onUpdate?.({ content: [{ type: "text", text: `${run.id}/${run.agent_id}: ${progress.activity}` }], details: { action: "run_wave", run } }); } catch { /* progress display is best-effort */ }
						onProgress(progress);
					},
				});
			},
			async finishRun(runId, result) {
				try {
					return (await lionStore.mutate((l) => l.finish(runId, result))).result;
				} finally {
					const owner = activeOwners.get(runId);
					if (owner) activeRuns.finishActiveRun(owner);
					activeOwners.delete(runId);
				}
			},
			async getRun(runId) {
				return (await lionStore.query((l) => l.get(runId))).result;
			},
			async updateProgress(runId, progress) {
				await lionStore.mutate((l) => l.updateProgress(runId, progress));
			},
		};
	} catch (e) {
		throw new Error(`cerebel run_wave requires the LION package/runtime: ${e instanceof Error ? e.message : String(e)}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cerebel",
		label: "CEREBEL",
		description: [
			"Orchestration controller for LION worker waves. Forms assignments from ready AXON tasks,",
			"records LION run outcomes, can run planned waves through LION with run_wave, and decides whether to dispatch, wait, complete, replan, or escalate.",
			"State persists in the active NERVous project/context namespace. Actions: plan_wave, dispatch, record, decide, complete_wave, cancel, run_wave, get, list, summary.",
		].join(" "),
		promptSnippet: "Orchestrate ready AXON tasks into LION worker waves and record outcomes",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use cerebel after CORTEX has planned work into AXON and ready AXON tasks exist.",
			"First read axon list/summary, then pass ready task briefs into cerebel plan_wave.",
			"For manual control, call lion run with task_id/objective/context/agent_id, then cerebel dispatch/record the LION run id and outcome. For bounded active execution, use cerebel run_wave on an already planned wave.",
			"When assignments come from GANGLION, include ganglion_id and ganglion_allocation_id on the CEREBEL assignment/dispatch/record so CEREBEL releases member capacity on terminal outcomes.",
			"After blocked/failed results: cerebel record/decide, update AXON, post a SYNAPSE risk/blocker note, then use AMYGDALA or replan; never silently continue.",
		],
		parameters: CerebelToolParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
				case "run_wave": {
					try {
						const adapter = await createLionAdapter(ctx, p, signal, onUpdate);
						try { onUpdate?.({ content: [{ type: "text", text: RUN_WAVE_DASHBOARD_HINT.replace(/`/g, "") }], details: { action: "run_wave", hint: "dashboard" } }); } catch { /* dashboard hint is best-effort */ }
						const result = await runWave(store, adapter, { wave_id: p.wave_id, max_parallel: p.max_parallel, signal });
						const ganglionMessages: string[] = [];
						for (const r of result.assignment_results) {
							if (r.outcome === "skipped") continue;
							const assignment = result.wave.assignments.find((a) => a.id === r.assignment_id);
							if (!assignment) continue;
							const msg = await recordLinkedGanglion(ctx.cwd, assignment, { action: "record", lion_run_id: r.lion_run_id, summary: r.summary } as CerebelToolInput, r.outcome as AssignmentStatus);
							if (msg) ganglionMessages.push(msg);
						}
						const suffix = ganglionMessages.length ? ` ${ganglionMessages.join(" ")}` : "";
						return ok(action, `Ran ${result.summary}.${suffix}`, { wave: result.wave, run_wave: result });
					} catch (e) {
						return fail(action, `cerebel run_wave failed: ${e instanceof Error ? e.message : String(e)}`);
					}
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
