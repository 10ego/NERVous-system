/** CEREBEL — pi extension entry point. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CerebelStore } from "./backend.ts";
import { CerebelError, CerebelToolParams, type Assignment, type AssignmentStatus, type CerebelToolInput, type CerebelSummary, type Wave, type WaveStatus } from "./schema.ts";
import { renderCerebelCall, renderCerebelResult, RUN_WAVE_DASHBOARD_HINT, summarizeList, summarizeSummary, summarizeWave } from "./render.ts";
import { RunWaveBatchError, runWave, type RunWaveLionAdapter, type RunWaveResult } from "./run-wave.ts";
import type { LionModelRole, LionProgressSnapshot, LionRun } from "../../lion/extension/schema.ts";

interface CerebelDetails { action: string; wave?: Wave; waves?: Wave[]; summary?: CerebelSummary; run_wave?: import("./run-wave.ts").RunWaveResult; error?: string }
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: CerebelDetails; isError?: boolean };

type LionRunner = (req: import("../../lion/extension/subprocess.ts").LionRunRequest) => Promise<{ text: string; report: import("../../lion/extension/schema.ts").LionReport | null }>;
interface LionAdapterDeps {
	lionStore?: { namespaceId: string; mutate<T>(fn: (ledger: import("../../lion/extension/store.ts").LionLedger) => T): Promise<{ result: T }>; query<T>(fn: (ledger: import("../../lion/extension/store.ts").LionLedger) => T): Promise<{ result: T }> };
	createLionRunner?: (opts: { cwd: string }) => LionRunner;
	createLionRpcRunner?: (opts: { cwd: string; store: unknown }) => LionRunner;
	activeRuns?: typeof import("../../lion/extension/active-runs.ts");
	lifecycle?: typeof import("../../lion/extension/lifecycle.ts");
	options?: typeof import("../../lion/extension/options.ts");
}

function ok(action: string, text: string, details: Omit<CerebelDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string, details: Omit<CerebelDetails, "action" | "error"> = {}): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, ...details, error: message }, isError: true };
}

export function runWaveBatchFailureResult(error: RunWaveBatchError, suffix = ""): ToolResult {
	return fail("run_wave", `cerebel ${error.message}${suffix ? ` ${suffix.trim()}` : ""}`, { wave: error.result.wave, run_wave: error.result });
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

function isTerminalAssignment(status: AssignmentStatus): boolean { return ["completed", "partial", "blocked", "failed", "cancelled"].includes(status); }
function ganglionStatusFromAssignment(status: AssignmentStatus): "completed" | "blocked" | "failed" | "cancelled" { return status === "blocked" ? "blocked" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed"; }
function findRecordedAssignment(wave: Wave, p: CerebelToolInput): Assignment | undefined {
	return wave.assignments.find((a) => (p.assignment_id && a.id === p.assignment_id)
		|| (p.task_id && a.task_id === p.task_id)
		|| (p.lion_run_id && a.lion_run_id === p.lion_run_id && (!p.lion_run_incarnation_id || a.lion_run_incarnation_id === p.lion_run_incarnation_id)));
}
function formatGanglionRecordMessage(ganglionId: string, allocationId: string, disposition: import("../../ganglion/extension/store.ts").AllocationReleaseDisposition): string {
	if (disposition === "released") return `GANGLION ${ganglionId}/${allocationId} recorded and capacity released.`;
	if (disposition === "already_free") return `GANGLION ${ganglionId}/${allocationId} recorded; capacity was already free.`;
	if (disposition === "member_unavailable") return `GANGLION ${ganglionId}/${allocationId} recorded; member has no active lease but remains unavailable.`;
	if (disposition === "retained_by_newer_allocation") return `GANGLION ${ganglionId}/${allocationId} recorded; capacity retained by a newer allocation.`;
	return `GANGLION ${ganglionId}/${allocationId} recorded without a terminal capacity release.`;
}

async function recordLinkedGanglion(cwd: string, assignment: Assignment | undefined, p: CerebelToolInput, outcome: AssignmentStatus): Promise<string | null> {
	if (!assignment || !isTerminalAssignment(outcome)) return null;
	const ganglionId = p.ganglion_id ?? assignment.ganglion_id;
	const allocationId = p.ganglion_allocation_id ?? assignment.ganglion_allocation_id;
	if (!allocationId) return null;
	if (!ganglionId) return `GANGLION release skipped: assignment ${assignment.id} has allocation ${allocationId} but no ganglion_id.`;
	try {
		const { GanglionStore } = await import("../../ganglion/extension/backend.ts");
		const { result } = await GanglionStore.fromCwd(cwd).mutate((l) => l.recordWithResult(ganglionId, { allocation_id: allocationId, lion_run_id: p.lion_run_id ?? assignment.lion_run_id ?? undefined, status: ganglionStatusFromAssignment(outcome), summary: p.summary }));
		return formatGanglionRecordMessage(ganglionId, allocationId, result.release_disposition);
	} catch (e) {
		return `GANGLION release failed for ${ganglionId}/${allocationId}: ${e instanceof Error ? e.message : String(e)}`;
	}
}

export async function recordRunWaveGanglion(cwd: string, result: RunWaveResult): Promise<string[]> {
	const messages: string[] = [];
	const assignments = new Map(result.wave.assignments.map((assignment) => [assignment.id, assignment]));
	const grouped = new Map<string, Array<{ assignment: Assignment; allocationId: string; lionRunId?: string; outcome: AssignmentStatus; summary: string }>>();
	for (const assignmentResult of result.assignment_results) {
		if (assignmentResult.outcome === "skipped") continue;
		const assignment = assignments.get(assignmentResult.assignment_id);
		if (!assignment || !assignment.ganglion_allocation_id) continue;
		if (!assignment.ganglion_id) {
			messages.push(`GANGLION release skipped: assignment ${assignment.id} has allocation ${assignment.ganglion_allocation_id} but no ganglion_id.`);
			continue;
		}
		const group = grouped.get(assignment.ganglion_id) ?? [];
		group.push({ assignment, allocationId: assignment.ganglion_allocation_id, lionRunId: assignmentResult.lion_run_id, outcome: assignmentResult.outcome as AssignmentStatus, summary: assignmentResult.summary });
		grouped.set(assignment.ganglion_id, group);
	}
	if (!grouped.size) return messages;
	try {
		const { GanglionStore } = await import("../../ganglion/extension/backend.ts");
		for (const [ganglionId, entries] of grouped) {
			try {
				const { result: records } = await GanglionStore.fromCwd(cwd).mutate((ledger) => entries.map((entry) => ({
					entry,
					record: ledger.recordWithResult(ganglionId, { allocation_id: entry.allocationId, lion_run_id: entry.lionRunId, status: ganglionStatusFromAssignment(entry.outcome), summary: entry.summary }),
				})));
				for (const { entry, record } of records) messages.push(formatGanglionRecordMessage(ganglionId, entry.allocationId, record.release_disposition));
			} catch (error) {
				for (const entry of entries) messages.push(`GANGLION release failed for ${ganglionId}/${entry.allocationId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch (error) {
		for (const [ganglionId, entries] of grouped) for (const entry of entries) messages.push(`GANGLION release failed for ${ganglionId}/${entry.allocationId}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return messages;
}

export interface LinkedLionSettlement {
	assignment: Assignment;
	settled: boolean;
	run_status?: string;
	error?: string;
}

const DEFAULT_CANCEL_SETTLE_TIMEOUT_MS = 15_000;
const MAX_CANCEL_SETTLE_TIMEOUT_MS = 120_000;

function lionRunRefKey(runId: string, incarnationId: string | null | undefined): string {
	return JSON.stringify([runId, incarnationId ?? null]);
}

export function resolveCancelSettlementTimeout(value = process.env.CEREBEL_CANCEL_SETTLE_TIMEOUT_MS): number {
	if (value === undefined || value.trim() === "") return DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_CANCEL_SETTLE_TIMEOUT_MS
		? parsed
		: DEFAULT_CANCEL_SETTLE_TIMEOUT_MS;
}

export async function settleLinkedLionsBeforeCancel(
	cwd: string,
	wave: Wave,
	reason: string,
	timeoutMs = resolveCancelSettlementTimeout(),
	loadRuntime = () => Promise.all([import("../../lion/extension/backend.ts"), import("../../lion/extension/active-runs.ts")]),
): Promise<LinkedLionSettlement[]> {
	const assignments = wave.assignments.filter((assignment) => assignment.lion_run_id && !["completed", "partial", "blocked", "failed", "cancelled"].includes(assignment.status));
	if (!assignments.length) return [];
	const results = new Map<string, LinkedLionSettlement>();
	const verifiable = assignments.filter((assignment) => {
		if (assignment.lion_run_incarnation_id) return true;
		results.set(assignment.id, { assignment, settled: false, error: `LION ${assignment.lion_run_id} link is legacy/unverifiable because it has no incarnation id` });
		return false;
	});
	if (!verifiable.length) return assignments.map((assignment) => results.get(assignment.id)!);

	const [{ LionStore }, controls] = await loadRuntime();
	const lionStore = LionStore.fromCwd(cwd);
	const pending: Array<{ assignment: Assignment; run: NonNullable<Awaited<ReturnType<typeof controls.requestRunCancellation>>["run"]> }> = [];
	// One LION ledger owns every linked run, so serialize the short admission
	// mutations instead of racing many advisory-lock acquisitions.
	for (const assignment of verifiable) {
		try {
			const cancellation = await controls.requestRunCancellation(lionStore, assignment.lion_run_id!, reason, { expectedIncarnationId: assignment.lion_run_incarnation_id });
			if (cancellation.settled) {
				results.set(assignment.id, { assignment, settled: true, run_status: cancellation.run?.status });
			} else if (cancellation.run) {
				pending.push({ assignment, run: cancellation.run });
			} else {
				results.set(assignment.id, { assignment, settled: cancellation.superseded, error: cancellation.superseded ? undefined : "LION run disappeared during cancellation" });
			}
		} catch (error) {
			results.set(assignment.id, { assignment, settled: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (pending.length) {
		const settlements = await controls.waitForRunSettlements(lionStore, pending.map((entry) => entry.run), timeoutMs);
		settlements.forEach((settlement, index) => {
			const assignment = pending[index]!.assignment;
			results.set(assignment.id, {
				assignment,
				settled: settlement.settled,
				run_status: settlement.run?.status,
				error: settlement.settled ? undefined : `LION ${assignment.lion_run_id} remained ${settlement.run?.status ?? "unknown"}`,
			});
		});
	}
	return assignments.map((assignment) => results.get(assignment.id)!);
}

export async function createLionAdapter(ctx: ExtensionContext, p: CerebelToolInput, signal: AbortSignal | undefined, onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined, deps: LionAdapterDeps = {}, pi?: ExtensionAPI): Promise<RunWaveLionAdapter> {
	try {
		const [{ LionStore }, jsonRunnerMod, rpcRunnerMod, activeRunsMod, lifecycleMod, optionsMod] = await Promise.all([
			deps.lionStore ? Promise.resolve({ LionStore: { fromCwd: () => deps.lionStore! as never } }) : import("../../lion/extension/backend.ts"),
			deps.createLionRunner ? Promise.resolve({ createLionRunner: deps.createLionRunner }) : import("../../lion/extension/subprocess.ts"),
			deps.createLionRpcRunner ? Promise.resolve({ createLionRpcRunner: deps.createLionRpcRunner }) : import("../../lion/extension/rpc-runner.ts"),
			deps.activeRuns ? Promise.resolve(deps.activeRuns) : import("../../lion/extension/active-runs.ts"),
			deps.lifecycle ? Promise.resolve(deps.lifecycle) : import("../../lion/extension/lifecycle.ts"),
			deps.options ? Promise.resolve(deps.options) : import("../../lion/extension/options.ts"),
		]);
		const { createLionRunner } = jsonRunnerMod;
		const { createLionRpcRunner } = rpcRunnerMod;
		const activeRuns = activeRunsMod;
		const lifecycle = lifecycleMod;
		const lionStore = LionStore.fromCwd(ctx.cwd);
		const modelRole = (p.model_role as LionModelRole | undefined) ?? "implementation";
		const model = p.model?.trim() || optionsMod.resolveConfiguredLionModel(ctx.cwd, () => ctx.isProjectTrusted?.() ?? false, modelRole);
		const runnerMode = optionsMod.resolveLionRunnerMode(p.runner_mode);
		const runner = runnerMode === "rpc" ? createLionRpcRunner({ cwd: ctx.cwd, store: lionStore }) : createLionRunner({ cwd: ctx.cwd });
		const activeOwners = new Map<string, ReturnType<typeof activeRuns.beginActiveRun>>();
		return {
			async createRun(assignment) {
				let activeOwner: ReturnType<typeof activeRuns.beginActiveRun> | undefined;
				try {
					const initialProgress = lifecycle.startedProgress();
					const { result } = await lionStore.mutate((l) => {
						const queued = l.create({
							agent_id: assignment.agent_id,
							task_id: assignment.task_id,
							objective: assignment.objective,
							context: assignment.context,
							model,
							model_role: modelRole,
							runner_mode: runnerMode,
							tools: p.tools,
							start: false,
						});
						activeOwner = activeRuns.beginActiveRun({ namespaceId: lionStore.namespaceId, runId: queued.id, incarnationId: queued.incarnation_id ?? null }, runnerMode);
						const started = l.start(queued.id);
						return l.updateProgress(started.id, initialProgress);
					});
					activeOwners.set(result.id, activeOwner!);
					lifecycle.emitLionEvent(pi, "started", result, initialProgress);
					try { onUpdate?.({ content: [{ type: "text", text: `${result.id}/${result.agent_id}: ${initialProgress.activity}` }], details: { action: "run_wave", run: result } }); } catch { /* progress display is best-effort */ }
					return result;
				} catch (err) {
					if (activeOwner) activeRuns.finishActiveRun(activeOwner);
					throw err;
				}
			},
			async run(run: LionRun, _assignment, onProgress, runSignal) {
				const activeOwner = activeOwners.get(run.id);
				if (!activeOwner) throw new Error(`active LION ownership missing for ${run.id}`);
				return runner({
					run,
					signal: runSignal ?? signal,
					timeout_ms: p.timeout_ms ?? DEFAULT_RUN_WAVE_TIMEOUT_MS,
					onProcessStart: (info) => {
						activeRuns.attachActiveRunProcess(activeOwner, info);
						void lionStore.mutate((l) => activeRuns.isActiveRunOwner(activeOwner)
							? l.updateControl(run.id, { pid: info.pid, pgid: info.pgid, process_identity: info.process_identity ?? null, started_at: new Date().toISOString() })
							: l.get(run.id)).catch(() => undefined).finally(() => activeRuns.replayPendingCancellation(activeOwner, lionStore).catch(() => undefined));
					},
					onControlClosed: () => activeRuns.markActiveRunControlClosed(activeOwner),
					onProcessExit: () => activeRuns.markActiveRunExited(activeOwner),
					onProgress: (progress: LionProgressSnapshot) => {
						try { onUpdate?.({ content: [{ type: "text", text: `${run.id}/${run.agent_id}: ${progress.activity}` }], details: { action: "run_wave", run } }); } catch { /* progress display is best-effort */ }
						onProgress(progress);
					},
				});
			},
			async finishRun(runId, result) {
				try {
					const finished = (await lionStore.mutate((l) => l.finish(runId, result))).result;
					lifecycle.emitLionEvent(pi, lifecycle.terminalEventKind(finished.status), finished);
					return finished;
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
				const updated = (await lionStore.mutate((l) => l.updateProgress(runId, progress))).result;
				lifecycle.emitLionEvent(pi, "progress", updated, progress);
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
			"For manual control, call lion run with task_id/objective/context/agent_id, then cerebel dispatch the returned LION run id and incarnation id before recording its outcome. For bounded active execution, use cerebel run_wave on an already planned wave.",
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
						const wave = l.record(id, { assignment_id: p.assignment_id, task_id: p.task_id, lion_run_id: p.lion_run_id, lion_run_incarnation_id: p.lion_run_incarnation_id, ganglion_id: p.ganglion_id, ganglion_allocation_id: p.ganglion_allocation_id, outcome, summary: p.summary, changed_files: p.changed_files, tests_run: p.tests_run, blockers: p.blockers, next_steps: p.next_steps });
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
					try {
						const initial = (await store.query((l) => {
							const id = waveId(l, p.wave_id);
							return id ? l.get(id) : undefined;
						})).result;
						if (!initial) return fail(action, "cancel requires wave_id or current wave.");
						const settledRunRefs = new Set<string>();
						let cancelledWave: Wave | undefined;
						for (let pass = 0; pass < 10 && !cancelledWave; pass++) {
							const latest = (await store.query((l) => l.get(initial.id))).result ?? initial;
							const outstandingWave: Wave = {
								...latest,
								assignments: latest.assignments.filter((assignment) => assignment.lion_run_id && !settledRunRefs.has(lionRunRefKey(assignment.lion_run_id, assignment.lion_run_incarnation_id))),
							};
							const settlements = await settleLinkedLionsBeforeCancel(ctx.cwd, outstandingWave, p.reason ?? "CEREBEL wave cancelled");
							const failures = settlements.filter((settlement) => !settlement.settled);
							if (failures.length) {
								const message = failures.map((failure) => `${failure.assignment.id}: ${failure.error ?? "LION did not settle"}`).join("; ");
								return fail(action, `cerebel cancel retained wave/capacity because linked LIONs did not settle: ${message}`, { wave: latest });
							}
							for (const settlement of settlements) if (settlement.assignment.lion_run_id) {
								settledRunRefs.add(lionRunRefKey(settlement.assignment.lion_run_id, settlement.assignment.lion_run_incarnation_id));
							}
							const attempt = await store.mutate((l) => {
								const current = l.get(initial.id);
								if (!current) throw new CerebelError("not_found", `wave ${initial.id} not found`);
								const pending = current.assignments.some((assignment) => assignment.lion_run_id
									&& !["completed", "partial", "blocked", "failed", "cancelled"].includes(assignment.status)
									&& !settledRunRefs.has(lionRunRefKey(assignment.lion_run_id, assignment.lion_run_incarnation_id)));
								return pending ? undefined : l.cancel(initial.id);
							});
							cancelledWave = attempt.result;
						}
						if (!cancelledWave) return fail(action, "cerebel cancel could not obtain a stable settled assignment set; no capacity was released", { wave: (await store.query((l) => l.get(initial.id))).result });
						const result = ok(action, `Cancelled ${cancelledWave.id}.`, { wave: cancelledWave });
						const releaseMessages: string[] = [];
						for (const assignment of cancelledWave.assignments.filter((candidate) => candidate.status === "cancelled")) {
							const message = await recordLinkedGanglion(ctx.cwd, assignment, { action: "record", lion_run_id: assignment.lion_run_id ?? undefined, lion_run_incarnation_id: assignment.lion_run_incarnation_id ?? undefined, summary: "CEREBEL wave cancelled" } as CerebelToolInput, "cancelled");
							if (message) releaseMessages.push(message);
						}
						if (releaseMessages.length) result.content[0]!.text += ` ${releaseMessages.join(" ")}`;
						return result;
					} catch (e) {
						return e instanceof CerebelError
							? fail(action, `cerebel cancel failed (${e.code}): ${e.message}`)
							: fail(action, `cerebel cancel failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				case "run_wave": {
					try {
						const adapter = await createLionAdapter(ctx, p, signal, onUpdate, {}, pi);
						try { onUpdate?.({ content: [{ type: "text", text: RUN_WAVE_DASHBOARD_HINT.replace(/`/g, "") }], details: { action: "run_wave", hint: "dashboard" } }); } catch { /* dashboard hint is best-effort */ }
						const result = await runWave(store, adapter, { wave_id: p.wave_id, max_parallel: p.max_parallel, signal });
						const ganglionMessages = await recordRunWaveGanglion(ctx.cwd, result);
						const suffix = ganglionMessages.length ? ` ${ganglionMessages.join(" ")}` : "";
						return ok(action, `Ran ${result.summary}.${suffix}`, { wave: result.wave, run_wave: result });
					} catch (e) {
						if (e instanceof RunWaveBatchError) {
							const ganglionMessages = await recordRunWaveGanglion(ctx.cwd, e.result);
							const suffix = ganglionMessages.length ? ` ${ganglionMessages.join(" ")}` : "";
							return runWaveBatchFailureResult(e, suffix);
						}
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
