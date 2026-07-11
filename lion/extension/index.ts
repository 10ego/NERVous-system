/**
 * LION — pi extension entry point.
 *
 * Registers the `lion` tool. A LION run launches one isolated pi subprocess
 * worker and persists the final worker report in the active NERVous state namespace.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LionStore } from "./backend.ts";
import { LionError, LionToolParams, isActiveLionStatus, type LionModelRole, type LionProgressSnapshot, type LionRun, type LionRunStatus, type LionSummary, type LionToolInput } from "./schema.ts";
import { renderLionCall, renderLionResult, summarizeList, summarizeRun, summarizeSummary } from "./render.ts";
import { createProgressUpdater, emitLionEvent, startedProgress, terminalEventKind } from "./lifecycle.ts";
import { resolveConfiguredLionModel, resolveLionRunnerMode } from "./options.ts";
import { createLionRunner, getProcessIdentity, isPidAlive } from "./subprocess.ts";
import { createLionRpcRunner } from "./rpc-runner.ts";
import { finalizeExactLionRun, persistCleanupPendingObservation, registerLionCleanupSupervisor, type LionTerminalIntent } from "./cleanup-supervisor.ts";
import { persistBatchedProgress } from "./progress-batcher.ts";
import { attachActiveRunProcess, beginActiveRun, finishActiveRun, getActiveRunRefs, isActiveRunAttached, isActiveRunOwner, markActiveRunControlClosed, markActiveRunExited, replayPendingCancellation, requestRunCancellation, type ActiveRunOwner, type ActiveRunScope } from "./active-runs.ts";

interface LionDetails {
	action: string;
	run?: LionRun;
	runs?: LionRun[];
	summary?: LionSummary;
	deleted?: boolean;
	error?: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: LionDetails; isError?: boolean };

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export { lionEventPayload } from "./lifecycle.ts";
export type { LionEventKind } from "./lifecycle.ts";

function ok(action: string, text: string, details: Omit<LionDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string, details: Omit<LionDetails, "action" | "error"> = {}): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, ...details, error: message }, isError: true };
}

function modelVisibleRunRef(run: Pick<LionRun, "id" | "incarnation_id">): string {
	return `run_id=${run.id} incarnation_id=${run.incarnation_id}`;
}

async function runQuery(store: LionStore, action: string, op: (l: import("./store.ts").LionLedger) => ToolResult): Promise<ToolResult> {
	try {
		const { result } = await store.query(op);
		return result;
	} catch (e) {
		return fail(action, `lion ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
async function runOp(store: LionStore, action: string, op: (l: import("./store.ts").LionLedger) => ToolResult): Promise<ToolResult> {
	try {
		const { result } = await store.mutate(op);
		return result;
	} catch (e) {
		if (e instanceof LionError) return fail(action, `lion ${action} failed (${e.code}): ${e.message}`);
		return fail(action, `lion ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function activeRunScope(store: LionStore, run: Pick<LionRun, "id" | "incarnation_id">): ActiveRunScope {
	return { namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id ?? null };
}

async function reconcileStore(store: LionStore): Promise<void> {
	try {
		await store.mutateMaybe((l) => {
			const changed = l.reconcileControls(isPidAlive, { active_run_refs: getActiveRunRefs(store.namespaceId), get_process_identity: getProcessIdentity });
			return { result: changed, changed: changed.length > 0 };
		});
	} catch { /* best-effort read reconciliation */ }
}

export async function executeRun(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	store: LionStore;
	action: string;
	run: LionRun;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	timeout_ms?: number;
	include_progress_text?: boolean;
	activeOwner: ActiveRunOwner;
	runner?: (request: import("./subprocess.ts").LionRunRequest) => Promise<import("./subprocess.ts").LionRunnerOutcome>;
}): Promise<ToolResult> {
	let run = args.run;
	const runId = args.run.id;
	const runIncarnationId = args.run.incarnation_id;
	const activeOwner = args.activeOwner;
	let ownershipTransferred = false;
	const progressUpdater = createProgressUpdater(async (progress) => {
		const updated = await persistBatchedProgress(args.store, { id: runId, incarnation_id: runIncarnationId }, progress);
		if (!updated) return;
		run = updated;
		emitLionEvent(args.pi, "progress", run, progress);
	}, { onError: (error) => console.warn(`[nervous-system/lion] progress update failed for ${run.id}:`, error) });
	const enqueueProgress = (progress: LionProgressSnapshot) => {
		const preview = { ...run, progress, updated_at: progress.last_event_at } satisfies LionRun;
		try {
			args.onUpdate?.({ content: [{ type: "text", text: `${run.id}/${run.agent_id}: ${progress.activity}` }], details: { action: args.action, run: preview } });
		} catch (err) {
			console.warn(`[nervous-system/lion] progress update callback failed for ${run.id}:`, err);
		}
		progressUpdater.enqueue(progress);
	};

	const initialProgress = startedProgress();
	emitLionEvent(args.pi, "started", run, initialProgress);
	enqueueProgress(initialProgress);

	try {
		const runner = args.runner ?? (run.runner_mode === "rpc"
			? createLionRpcRunner({ cwd: args.ctx.cwd, store: args.store })
			: createLionRunner({ cwd: args.ctx.cwd }));
		const out = await runner({
			run,
			cleanupOwner: activeOwner,
			registerCleanupSupervisor: async (handoff) => {
				run = await persistCleanupPendingObservation(args.store, activeOwner, handoff);
				return registerLionCleanupSupervisor({
					owner: activeOwner,
					handoff,
					finalize: async (intent, cleanupError) => {
						await progressUpdater.drain();
						return finalizeExactLionRun(args.store, activeOwner, await terminalFinishInput(args.store, activeOwner, intent, cleanupError, args.signal?.aborted));
					},
					emitTerminal: (settlement) => {
						if (settlement.disposition === "terminal") emitLionEvent(args.pi, terminalEventKind(settlement.run.status as import("./schema.ts").TerminalLionRunStatus), settlement.run);
					},
					releaseOwner: () => finishActiveRun(activeOwner),
				});
			},
			signal: args.signal,
			timeout_ms: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
			include_progress_text: args.include_progress_text,
			onProgress: enqueueProgress,
			onProcessStart: (info) => {
				attachActiveRunProcess(activeOwner, info);
				void args.store.mutate((l) => isActiveRunOwner(activeOwner)
					? l.updateControlIfCurrent(runId, runIncarnationId, { pid: info.pid, pgid: info.pgid, process_identity: info.process_identity ?? null, started_at: new Date().toISOString() })
					: { run: l.get(runId), committed: false }).then((updated) => { if (updated.result.committed && updated.result.run) run = updated.result.run; }).catch((err) => {
					console.warn(`[nervous-system/lion] process metadata update failed for ${run.id}:`, err);
				}).finally(() => replayPendingCancellation(activeOwner, args.store).catch((err) => {
					console.warn(`[nervous-system/lion] pending cancellation replay failed for ${run.id}:`, err);
				}));
			},
			onControlClosed: () => markActiveRunControlClosed(activeOwner),
			onProcessExit: () => markActiveRunExited(activeOwner),
		});
		await progressUpdater.drain();
		if (out.settlement === "cleanup_pending") {
			ownershipTransferred = true;
			const current = await args.store.query((l) => l.get(runId)).then(({ result }) => result, () => undefined);
			return ok(args.action, `LION run_id=${runId} incarnation_id=${runIncarnationId} cleanup_pending: attached RPC child is still exiting; run ownership and orchestration capacity remain retained.`, current ? { run: current } : {});
		}
		const finished = await args.store.mutate((l) => l.finishIfCurrent(runId, runIncarnationId, { output: out.text, report: out.report }));
		if (!finished.result.committed || !finished.result.run) {
			return fail(args.action, `LION finalization was superseded for run_id=${runId} incarnation_id=${runIncarnationId}; current ledger state was left unchanged.`, finished.result.run ? { run: finished.result.run } : {});
		}
		run = finished.result.run;
		if (isActiveLionStatus(run.status)) throw new Error(`LION ${run.id} remained nonterminal after finish`);
		emitLionEvent(args.pi, terminalEventKind(run.status), run);
		const reportHint = run.report ? `${run.report.outcome}: ${run.report.summary}` : "completed with unparsed report";
		return ok(args.action, `LION ${modelVisibleRunRef(run)} status=${run.status}: ${reportHint}`, { run });
	} catch (err) {
		await progressUpdater.drain();
		const msg = err instanceof Error ? err.message : String(err);
		const current = (await args.store.query((l) => l.get(runId))).result;
		const exactCurrent = current && (current.incarnation_id ?? null) === (runIncarnationId ?? null) ? current : undefined;
		const wasCancelled = Boolean(exactCurrent?.control?.cancel_requested_at || args.signal?.aborted);
		const failed = await args.store.mutate((l) => l.finishIfCurrent(runId, runIncarnationId, { output: "", report: null, status: wasCancelled ? "aborted" : "failed", error: wasCancelled ? (exactCurrent?.control?.cancel_reason ? `Cancelled: ${exactCurrent.control.cancel_reason}` : "Cancelled") : msg }));
		if (!failed.result.committed || !failed.result.run) {
			return fail(args.action, `LION failure finalization was superseded for run_id=${runId} incarnation_id=${runIncarnationId}; current ledger state was left unchanged.`, failed.result.run ? { run: failed.result.run } : {});
		}
		run = failed.result.run;
		emitLionEvent(args.pi, "failed", run);
		return fail(args.action, `LION ${modelVisibleRunRef(run)} status=${run.status}: ${run.error ?? msg}`, { run });
	} finally {
		if (!ownershipTransferred) finishActiveRun(activeOwner);
	}
}

async function terminalFinishInput(
	store: LionStore,
	owner: ActiveRunOwner,
	intent: LionTerminalIntent,
	cleanupError?: Error,
	hostAborted = false,
): Promise<import("./store.ts").FinishRunInput> {
	const current = (await store.query((ledger) => ledger.get(owner.runId))).result;
	const exact = current && (current.incarnation_id ?? null) === (owner.incarnationId ?? null) ? current : undefined;
	const cancelled = Boolean(exact?.control?.cancel_requested_at || hostAborted);
	if (intent.kind === "result" && !cleanupError && !cancelled) return { output: intent.output.text, report: intent.output.report };
	const error = intent.kind === "error" ? intent.error : cleanupError ?? new Error("LION run host aborted during cleanup");
	return {
		output: "",
		report: null,
		status: cancelled ? "aborted" : "failed",
		error: cancelled ? (exact?.control?.cancel_reason ? `Cancelled: ${exact.control.cancel_reason}` : "Cancelled") : error.message,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "lion",
		label: "LION",
		description: [
			"Local Intelligence Operations Node: launch one isolated pi coding subagent for a concrete assignment.",
			"A run persists to the active NERVous state namespace with status, bounded live progress, process control metadata, runner mode, output, and parsed WORKER_REPORT.",
			"Use it as CEREBEL's worker abstraction: task_id/objective in, worker report out.",
			"Actions: run, start, cancel, steer, get, list, summary, delete.",
		].join(" "),
		promptSnippet: "Launch a LION coding subagent for one concrete assignment and record its worker report",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use lion run when a self-contained coding task should be delegated to an isolated subagent.",
			"Set model_role='review' for implementation review/QA assignments so review workers can use the configured review model; implementation work defaults to model_role='implementation'.",
			"Give each LION a narrow objective and enough context/acceptance criteria; avoid broad ambiguous assignments.",
			"Pass an AXON task id when available so the worker can update durable task state if the axon tool is available.",
			"Read LION progress when a worker is active, then read the final worker report before marking orchestration work complete; blocked/failed reports should feed AXON/AMYGDALA.",
			"Use cancel for a running/queued worker only when stopping it is safer than letting it finish; cancellation is best-effort process signaling with durable reconciliation.",
			"Use steer freely for queued/pre-start runs. Running steering is accepted only for explicit runner_mode='rpc' runs with a live RPC worker; legacy json subprocess runs reject running steering.",
			"Use runner_mode='rpc' (or LION_RUNNER=rpc) when true live mid-run steering is required; json remains the default compatibility runner.",
		],
		parameters: LionToolParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const store = LionStore.fromCwd(ctx.cwd);
			const p = params as LionToolInput;
			const action = p.action;

			switch (action) {
				case "run": {
					if (!p.objective && !p.task_id) return fail(action, "run requires `objective` or `task_id`.");
					const modelRole = (p.model_role as LionModelRole | undefined) ?? "implementation";
					const model = p.model?.trim() || resolveConfiguredLionModel(ctx.cwd, () => ctx.isProjectTrusted?.() ?? false, modelRole);
					const runnerMode = resolveLionRunnerMode(p.runner_mode);
					if (p.dry_run) {
						const { result: run } = await store.mutate((l) => l.create({ agent_id: p.agent_id, task_id: p.task_id ?? null, objective: p.objective ?? "", context: p.context, model, model_role: modelRole, runner_mode: runnerMode, tools: p.tools, start: false }));
						return ok(action, `Queued dry-run ${modelVisibleRunRef(run)}. Use lion start id=${run.id} to launch; queued steering may be added before start.`, { run });
					}
					let activeOwner: ActiveRunOwner | undefined;
					try {
						const { result: run } = await store.mutate((l) => {
							const queued = l.create({ agent_id: p.agent_id, task_id: p.task_id ?? null, objective: p.objective ?? "", context: p.context, model, model_role: modelRole, runner_mode: runnerMode, tools: p.tools, start: false });
							activeOwner = beginActiveRun(activeRunScope(store, queued), runnerMode);
							return l.start(queued.id);
						});
						return await executeRun({ pi, ctx, store, action, run, activeOwner: activeOwner!, signal, onUpdate, timeout_ms: p.timeout_ms, include_progress_text: p.include_progress_text });
					} catch (e) {
						if (activeOwner) finishActiveRun(activeOwner);
						return e instanceof LionError ? fail(action, `lion run failed (${e.code}): ${e.message}`) : fail(action, `lion run failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				case "start": {
					if (!p.id) return fail(action, "start requires `id`.");
					let activeOwner: ActiveRunOwner | undefined;
					try {
						const { result: run } = await store.mutate((l) => {
							const current = l.get(p.id!);
							if (!current) throw new LionError("not_found", `run ${p.id} not found`);
							activeOwner = beginActiveRun(activeRunScope(store, current), current.runner_mode);
							return l.start(current.id);
						});
						return await executeRun({ pi, ctx, store, action, run, activeOwner: activeOwner!, signal, onUpdate, timeout_ms: p.timeout_ms, include_progress_text: p.include_progress_text });
					} catch (e) {
						if (activeOwner) finishActiveRun(activeOwner);
						return e instanceof LionError ? fail(action, `lion start failed (${e.code}): ${e.message}`) : fail(action, `lion start failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				case "cancel": {
					if (!p.id) return fail(action, "cancel requires `id`.");
					try {
						const cancellation = await requestRunCancellation(store, p.id, p.reason);
						const run = cancellation.run;
						if (!run) return fail(action, `LION ${p.id} not found.`);
						if (cancellation.superseded) return ok(action, `Cancellation result for ${p.id} was superseded by a replacement run.`, { run });
						if (cancellation.settled) {
							return ok(action, run.status === "aborted" ? `Cancelled LION ${p.id}.` : `LION ${p.id} is already terminal (${run.status}).`, { run });
						}
						const delivery = cancellation.delivery;
						if (delivery?.delivered) return ok(action, `Cancellation delivered to active LION ${p.id}${delivery.pid ? ` (pid ${delivery.pid})` : ""}.`, { run });
						return ok(action, `Cancel recorded for ${p.id}, but no owned active worker was signaled (${delivery && !delivery.delivered ? delivery.reason : "not_attached"}).`, { run });
					} catch (e) {
						return e instanceof LionError ? fail(action, `lion cancel failed (${e.code}): ${e.message}`) : fail(action, `lion cancel failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				case "steer": {
					if (!p.id) return fail(action, "steer requires `id`.");
					if (!p.message) return fail(action, "steer requires `message`.");
					try {
						await reconcileStore(store);
						const current = (await store.query((l) => l.get(p.id!))).result;
						const liveRpc = current?.status === "running" && current.runner_mode === "rpc" && isActiveRunAttached(activeRunScope(store, current), "rpc");
						const reason = current?.status === "running"
							? (liveRpc ? "queued for live RPC delivery" : (current?.runner_mode === "rpc" ? "rpc worker is not attached to a live process" : "running json subprocess backend does not support live steering"))
							: undefined;
						const { result } = await store.mutate((l) => l.steer(p.id!, p.message!, { liveDeliveryAvailable: liveRpc, reason }));
						const status = result.message.status === "queued"
							? "queued for pre-start delivery"
							: result.message.status === "pending_delivery"
								? "queued for live RPC delivery"
								: `${result.message.status}: ${result.message.reason}`;
						return ok(action, `Steering ${status}.`, { run: result.run });
					} catch (e) {
						return e instanceof LionError ? fail(action, `lion steer failed (${e.code}): ${e.message}`) : fail(action, `lion steer failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				case "get": {
					if (!p.id) return fail(action, "get requires `id`.");
					await reconcileStore(store);
					return runQuery(store, action, (l) => {
						const run = l.get(p.id!);
						if (!run) return fail(action, `Run ${p.id} not found.`);
						return ok(action, summarizeRun(run), { run });
					});
				}

				case "list": {
					await reconcileStore(store);
					return runQuery(store, action, (l) => {
						const runs = l.list({ status: p.status_filter as LionRunStatus | undefined, agent_id: p.agent_filter, task_id: p.task_id, limit: p.limit });
						return ok(action, summarizeList(runs), { runs });
					});
				}

				case "summary": {
					await reconcileStore(store);
					return runQuery(store, action, (l) => {
						const summary = l.summary(p.limit ?? 10);
						return ok(action, summarizeSummary(summary), { summary });
					});
				}

				case "delete": {
					if (!p.id) return fail(action, "delete requires `id`.");
					return runOp(store, action, (l) => {
						const run = l.delete(p.id!);
						return ok(action, `Deleted ${run.id}.`, { run, deleted: true });
					});
				}

				default:
					return fail(action, `Unknown action: ${action as string}`);
			}
		},

		renderCall(args, theme) {
			return renderLionCall(args as { action: string; id?: string; task_id?: string; objective?: string }, theme as never);
		},
		renderResult(result, options, theme) {
			return renderLionResult(
				result as Parameters<typeof renderLionResult>[0],
				options as Parameters<typeof renderLionResult>[1],
				theme as never,
			);
		},
	});

	pi.registerCommand("lion", {
		description: "Show LION run summary",
		handler: async (_args, ctx) => {
			const store = LionStore.fromCwd(ctx.cwd);
			const { result } = await store.query((l) => l.summary(10));
			post(ctx, pi, summarizeSummary(result), { summary: result });
		},
	});

	pi.registerCommand("lion:runs", {
		description: "List recent LION runs",
		handler: async (_args, ctx) => {
			const store = LionStore.fromCwd(ctx.cwd);
			const { result } = await store.query((l) => l.list({ limit: 20 }));
			post(ctx, pi, summarizeList(result), { runs: result });
		},
	});
}

function post(ctx: ExtensionContext, pi: ExtensionAPI, markdown: string, details: Record<string, unknown>): void {
	if (ctx.hasUI) pi.sendMessage({ customType: "lion", content: markdown, display: true, details }, { triggerTurn: false });
	else ctx.ui.notify(markdown, "info");
}
