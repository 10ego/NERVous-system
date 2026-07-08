/**
 * LION — pi extension entry point.
 *
 * Registers the `lion` tool. A LION run launches one isolated pi subprocess
 * worker and persists the final worker report in the active NERVous state namespace.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadNervousConfig, resolveNervousModel, type NervousModelKey } from "@nervous-system/state";
import { LionStore } from "./backend.ts";
import { LionError, LionToolParams, type LionModelRole, type LionRun, type LionRunStatus, type LionSummary, type LionToolInput } from "./schema.ts";
import { renderLionCall, renderLionResult, summarizeList, summarizeRun, summarizeSummary } from "./render.ts";
import { createLionRunner } from "./subprocess.ts";

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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "lion",
		label: "LION",
		description: [
			"Local Intelligence Operations Node: launch one isolated pi coding subagent for a concrete assignment.",
			"A run persists to the active NERVous state namespace with status, output, and parsed WORKER_REPORT.",
			"Use it as CEREBEL's worker abstraction: task_id/objective in, worker report out.",
			"Actions: run, get, list, summary, delete.",
		].join(" "),
		promptSnippet: "Launch a LION coding subagent for one concrete assignment and record its worker report",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use lion run when a self-contained coding task should be delegated to an isolated subagent.",
			"Set model_role='review' for implementation review/QA assignments so review workers can use the configured review model; implementation work defaults to model_role='implementation'.",
			"Give each LION a narrow objective and enough context/acceptance criteria; avoid broad ambiguous assignments.",
			"Pass an AXON task id when available so the worker can update durable task state if the axon tool is available.",
			"Read the LION worker report before marking orchestration work complete; blocked/failed reports should feed AXON/AMYGDALA.",
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
					let run: LionRun;
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
					run = created.result;
					if (p.dry_run) return ok(action, `Queued dry-run ${run.id}.`, { run });

					onUpdate?.({ content: [{ type: "text", text: `${run.id}/${run.agent_id}: starting LION subprocess…` }], details: { action, run } });
					try {
						const runner = createLionRunner({ cwd: ctx.cwd });
						const out = await runner({ run, signal, timeout_ms: p.timeout_ms ?? DEFAULT_TIMEOUT_MS });
						const finished = await store.mutate((l) => l.finish(run.id, { output: out.text, report: out.report }));
						run = finished.result;
						const reportHint = run.report ? `${run.report.outcome}: ${run.report.summary}` : "completed with unparsed report";
						return ok(action, `LION ${run.id} ${run.status}: ${reportHint}`, { run });
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await store.mutate((l) => l.finish(run.id, { output: "", report: null, status: signal?.aborted ? "aborted" : "failed", error: msg }));
						return fail(action, `LION ${run.id} failed: ${msg}`);
					}
				}

				case "get": {
					if (!p.id) return fail(action, "get requires `id`.");
					return runQuery(store, action, (l) => {
						const run = l.get(p.id!);
						if (!run) return fail(action, `Run ${p.id} not found.`);
						return ok(action, summarizeRun(run), { run });
					});
				}

				case "list": {
					return runQuery(store, action, (l) => {
						const runs = l.list({ status: p.status_filter as LionRunStatus | undefined, agent_id: p.agent_filter, task_id: p.task_id, limit: p.limit });
						return ok(action, summarizeList(runs), { runs });
					});
				}

				case "summary": {
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
