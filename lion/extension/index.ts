/**
 * LION — pi extension entry point.
 *
 * Registers the `lion` tool. A LION run launches one isolated pi subprocess
 * worker and persists the final worker report in the active NERVous state namespace.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadNervousConfig, resolveNervousModel, type NervousModelKey } from "@nervous-system/state";
import { LionStore } from "./backend.ts";
import { LionError, LionToolParams, type LionModelRole, type LionProgressSnapshot, type LionRun, type LionRunStatus, type LionSummary, type LionToolInput } from "./schema.ts";
import { renderLionCall, renderLionResult, summarizeList, summarizeRun, summarizeSummary } from "./render.ts";
import { createLionRunner, isPidAlive, signalProcessTree } from "./subprocess.ts";

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

type LionEventKind = "started" | "progress" | "completed" | "blocked" | "failed";

function emitLionEvent(pi: ExtensionAPI, kind: LionEventKind, run: LionRun, progress?: LionProgressSnapshot): void {
	try {
		(pi as { events?: { emit(event: string, payload: unknown): void } }).events?.emit(`nervous:lion:${kind}`, {
			component: "lion",
			event: kind,
			run_id: run.id,
			agent_id: run.agent_id,
			task_id: run.task_id,
			status: run.status,
			objective: run.objective,
			progress: progress ?? run.progress ?? null,
			updated_at: run.updated_at,
		});
	} catch (err) {
		console.warn(`[nervous-system/lion] event emission failed for ${run.id}/${kind}:`, err);
	}
}

function startedProgress(): LionProgressSnapshot {
	const ts = new Date().toISOString();
	return { event: "started", activity: "starting LION subprocess…", active_tools: [], tool_uses: 0, turn_count: 0, token_total: null, last_text: null, last_event_at: ts };
}

function terminalEventKind(status: LionRunStatus): LionEventKind {
	if (status === "blocked") return "blocked";
	if (status === "failed" || status === "aborted") return "failed";
	return "completed";
}

function ok(action: string, text: string, details: Omit<LionDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, error: message }, isError: true };
}

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

async function reconcileStore(store: LionStore): Promise<void> {
	try { await store.mutate((l) => l.reconcileControls(isPidAlive)); } catch { /* best-effort read reconciliation */ }
}

async function executeRun(args: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	store: LionStore;
	action: string;
	run: LionRun;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	timeout_ms?: number;
}): Promise<ToolResult> {
	let run = args.run;
	let progressChain = Promise.resolve();
	const enqueueProgress = (progress: LionProgressSnapshot) => {
		const preview = { ...run, progress, updated_at: progress.last_event_at } satisfies LionRun;
		try {
			args.onUpdate?.({ content: [{ type: "text", text: `${run.id}/${run.agent_id}: ${progress.activity}` }], details: { action: args.action, run: preview } });
		} catch (err) {
			console.warn(`[nervous-system/lion] progress update callback failed for ${run.id}:`, err);
		}
		progressChain = progressChain.then(async () => {
			const updated = await args.store.mutate((l) => l.updateProgress(run.id, progress));
			run = updated.result;
			emitLionEvent(args.pi, "progress", run, progress);
		}).catch((err) => {
			console.warn(`[nervous-system/lion] progress update failed for ${run.id}:`, err);
		});
	};

	const initialProgress = startedProgress();
	emitLionEvent(args.pi, "started", run, initialProgress);
	enqueueProgress(initialProgress);

	try {
		const runner = createLionRunner({ cwd: args.ctx.cwd });
		const out = await runner({
			run,
			signal: args.signal,
			timeout_ms: args.timeout_ms ?? DEFAULT_TIMEOUT_MS,
			onProgress: enqueueProgress,
			onProcessStart: (info) => {
				void args.store.mutate((l) => l.updateControl(run.id, { pid: info.pid, pgid: info.pgid, started_at: new Date().toISOString() })).then((updated) => { run = updated.result; }).catch((err) => {
					console.warn(`[nervous-system/lion] process metadata update failed for ${run.id}:`, err);
				});
			},
		});
		await progressChain;
		const finished = await args.store.mutate((l) => l.finish(run.id, { output: out.text, report: out.report }));
		run = finished.result;
		emitLionEvent(args.pi, terminalEventKind(run.status), run);
		const reportHint = run.report ? `${run.report.outcome}: ${run.report.summary}` : "completed with unparsed report";
		return ok(args.action, `LION ${run.id} ${run.status}: ${reportHint}`, { run });
	} catch (err) {
		await progressChain;
		const msg = err instanceof Error ? err.message : String(err);
		const current = (await args.store.query((l) => l.get(run.id))).result;
		const wasCancelled = Boolean(current?.control?.cancel_requested_at || args.signal?.aborted);
		const failed = await args.store.mutate((l) => l.finish(run.id, { output: "", report: null, status: wasCancelled ? "aborted" : "failed", error: wasCancelled ? (current?.control?.cancel_reason ? `Cancelled: ${current.control.cancel_reason}` : "Cancelled") : msg }));
		run = failed.result;
		emitLionEvent(args.pi, "failed", run);
		return fail(args.action, `LION ${run.id} ${run.status}: ${run.error ?? msg}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "lion",
		label: "LION",
		description: [
			"Local Intelligence Operations Node: launch one isolated pi coding subagent for a concrete assignment.",
			"A run persists to the active NERVous state namespace with status, bounded live progress, process control metadata, output, and parsed WORKER_REPORT.",
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
			"Use cancel for a running/queued worker only when stopping it is safer than letting it finish; cancellation is best-effort process-group signaling with durable reconciliation.",
			"Use steer only for queued/pre-start runs; running subprocess workers reject steering because true live steering requires a separate control channel.",
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
					const model = p.model?.trim() || resolveConfiguredLionModel(ctx, modelRole);
					const created = await store.mutate((l) =>
						l.create({
							agent_id: p.agent_id,
							task_id: p.task_id ?? null,
							objective: p.objective ?? "",
							context: p.context,
							model,
							model_role: modelRole,
							tools: p.tools,
							start: !p.dry_run,
						}),
					);
					const run = created.result;
					if (p.dry_run) return ok(action, `Queued dry-run ${run.id}. Use lion start id=${run.id} to launch; queued steering may be added before start.`, { run });
					return executeRun({ pi, ctx, store, action, run, signal, onUpdate, timeout_ms: p.timeout_ms });
				}

				case "start": {
					if (!p.id) return fail(action, "start requires `id`.");
					let run: LionRun;
					try { run = (await store.mutate((l) => l.start(p.id!))).result; }
					catch (e) { return e instanceof LionError ? fail(action, `lion start failed (${e.code}): ${e.message}`) : fail(action, `lion start failed: ${e instanceof Error ? e.message : String(e)}`); }
					return executeRun({ pi, ctx, store, action, run, signal, onUpdate, timeout_ms: p.timeout_ms });
				}

				case "cancel": {
					if (!p.id) return fail(action, "cancel requires `id`.");
					try {
						const { result } = await store.mutate((l) => l.requestCancel(p.id!, p.reason ?? p.context));
						if (result.already_terminal) return ok(action, `LION ${p.id} is already terminal (${result.run.status}).`, { run: result.run });
						if (result.signal && result.pid) {
							try {
								signalProcessTree(result.pgid ?? result.pid, result.signal);
							} catch (err) {
								return fail(action, `Cancel recorded for ${p.id}, but signal failed: ${err instanceof Error ? err.message : String(err)}`);
							}
							setTimeout(() => {
								try { if (result.pid && isPidAlive(result.pid)) signalProcessTree(result.pgid ?? result.pid, "SIGKILL"); } catch { /* best effort */ }
							}, 5000).unref?.();
							return ok(action, `Cancellation requested for ${p.id} (pid ${result.pid}).`, { run: result.run });
						}
						return ok(action, `Cancelled queued LION ${p.id}.`, { run: result.run });
					} catch (e) {
						return e instanceof LionError ? fail(action, `lion cancel failed (${e.code}): ${e.message}`) : fail(action, `lion cancel failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				case "steer": {
					if (!p.id) return fail(action, "steer requires `id`.");
					if (!p.message) return fail(action, "steer requires `message`.");
					try {
						const { result } = await store.mutate((l) => l.steer(p.id!, p.message!));
						const status = result.accepted ? "queued for pre-start delivery" : `${result.message.status}: ${result.message.reason}`;
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
