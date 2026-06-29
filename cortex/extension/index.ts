/**
 * CORTEX — pi extension entry point.
 *
 * Registers the `cortex` tool (single tool, `action` discriminator) and the
 * `/cortex`, `/cortex:goals`, `/cortex:resume` commands, backed by the durable
 * goal store.
 *
 * CORTEX is the NERVous System's main reasoning core. It converts a user prompt
 * into a durable Goal (intent analysis → plan → AXON-linked tasks →
 * verification), and decides whether to convene MAGI. Because goals are
 * persisted, work resumes after compaction/restart without the context window.
 *
 * CORTEX does NOT import AXON/MAGI/SYNAPSE — the agent bridges those tools
 * (read AXON, call MAGI, post SYNAPSE) guided by the cortex skill.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CortexStore } from "./backend.ts";
import {
	type CortexAction,
	CortexError,
	CortexToolParams,
	type CortexToolInput,
	type Goal,
	type GoalStatus,
	type VerifyRecommendation,
} from "./schema.ts";
import { renderCortexCall, renderCortexResult, summarizeGoal, summarizeGoalList } from "./render.ts";

interface CortexDetails {
	action: string;
	goal?: Goal;
	goals?: Goal[];
	drain_run?: import("./schema.ts").DrainRun;
	config?: import("./schema.ts").CortexConfig;
	error?: string;
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: CortexDetails;
	isError?: boolean;
};

function ok(action: string, text: string, details: Omit<CortexDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, error: message }, isError: true };
}

async function runOp(
	store: CortexStore,
	action: string,
	op: (s: import("./store.ts").GoalStore) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.mutate(op);
		return result;
	} catch (e) {
		if (e instanceof CortexError) return fail(action, `cortex ${action} failed (${e.code}): ${e.message}`);
		return fail(action, `cortex ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function runQuery(
	store: CortexStore,
	action: string,
	op: (s: import("./store.ts").GoalStore) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.query(op);
		return result;
	} catch (e) {
		return fail(action, `cortex ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function projectName(cwd: string): string {
	return path.basename(cwd) || cwd;
}

/** Resolve the goal id: explicit id, "current"/"latest", or undefined. */
function resolveGoalId(s: import("./store.ts").GoalStore, id: string | undefined): string | undefined {
	if (!id || id === "current" || id === "latest") return s.current_goal_id ?? s.current()?.id;
	return id;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cortex",
		label: "CORTEX",
		description: [
			"Main reasoning core: turn a user prompt into a durable goal (intent, success criteria, risks),",
			"decide whether MAGI is needed, store an execution plan, link AXON tasks, and verify completion.",
			"Goals persist across compaction/restart. Actions: analyze, plan, link, verify, complete, block, escalate, accept_risk, record_failure, reopen, cancel, drain,",
			"get_config, set_config, get, list, summary, set_current.",
		].join(" "),
		promptSnippet: "Run CORTEX: analyze intent into a durable goal, plan, link AXON tasks, verify",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"After explicit NERVous activation, check CORTEX config; unless drain_mode=off, default to draining all workable incomplete CORTEX goals, including due revisits and retryable/classification-needed failures.",
			"When explaining a NERVous workflow, prefer a compact checklist of component → action/status → evidence; avoid verbose restatement.",
			"Use the cortex tool action 'analyze' at the start of non-trivial new work to capture intent, success criteria, constraints, and risks as a durable goal.",
			"After cortex analyze, if needs_magi is true or the decision is hard/risky/ambiguous/architectural, convene the magi tool before cortex plan; otherwise proceed to cortex plan.",
			"Use cortex tool action 'plan' to store the execution plan, then create each subtask in AXON (axon create) and record the ids with cortex action 'link'.",
			"Use cortex tool action 'get' (goal_id 'current') to resume a goal after compaction or restart.",
			"When AXON work is complete, read the axon board, then use cortex action 'verify' to check against the goal's success criteria before final review.",
			"Do not silently stop with incomplete actionable, failed, or skipped goals; complete them, cancel them with evidence, record retryability, or escalate blockers/unsafe uncertainty with AMYGDALA evidence.",
			"Respect risk_gate_mode: strict blocks, auto_deliberate needs MAGI/AMYGDALA approval evidence, user_accepted needs scoped user acceptance, disabled requires explicit dangerous opt-in evidence.",
		],
		parameters: CortexToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = CortexStore.fromCwd(ctx.cwd);
			const project = projectName(ctx.cwd);
			const p = params as CortexToolInput;
			const action: CortexAction = p.action;

			switch (action) {
				case "analyze": {
					if (!p.prompt) return fail(action, "analyze requires `prompt`.");
					return runOp(store, action, (s) => {
						const g = s.analyze({
							prompt: p.prompt!,
							intent_summary: p.intent_summary,
							goal: p.goal,
							success_criteria: p.success_criteria,
							constraints: p.constraints,
							risks: p.risks,
							expected_output: p.expected_output,
							complexity: p.complexity,
							needs_magi: p.needs_magi,
							magi_rationale: p.magi_rationale,
						});
						const next = g.intent.needs_magi
							? `needs_magi=true → convene MAGI before planning.`
							: `proceed to plan.`;
						return ok(action, `Analyzed ${g.id}: ${g.intent.intent_summary}\n(${next})`, { goal: g });
					});
				}

				case "plan": {
					if (!p.goal_id) return fail(action, "plan requires `goal_id`.");
					if (!p.subtasks?.length) return fail(action, "plan requires `subtasks`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.plan(id, {
							subtasks: p.subtasks!.map((x) => ({
								title: x.title,
								description: x.description,
								dependencies: x.dependencies,
								priority: x.priority,
								assigned_to: x.assigned_to,
							})),
							magi_used: p.magi_used,
							magi_output_ref: p.magi_output_ref,
						});
						return ok(
							action,
							`Planned ${g.id}: ${g.plan!.subtasks.length} subtask(s). Next: create them in AXON (axon create) and cortex link.`,
							{ goal: g },
						);
					});
				}

				case "link": {
					if (!p.goal_id) return fail(action, "link requires `goal_id`.");
					if (!p.links?.length) return fail(action, "link requires `links`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.link(
							id,
							p.links!.map((l) => ({ plan_id: l.plan_id, axon_task_id: l.axon_task_id })),
						);
						return ok(action, `Linked ${g.axon_task_ids.length} AXON task(s) to ${g.id}. Goal now executing.`, { goal: g });
					});
				}

				case "verify": {
					if (!p.goal_id) return fail(action, "verify requires `goal_id`.");
					if (!p.checks?.length) return fail(action, "verify requires `checks`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.verify(id, {
							checks: p.checks!.map((c) => ({ criterion: c.criterion, passed: c.passed, evidence: c.evidence })),
							all_axon_complete: p.all_axon_complete,
							recommendation: p.recommendation as VerifyRecommendation | undefined,
							concerns: p.concerns,
						});
						const v = g.verification!;
						return ok(
							action,
							`Verified ${g.id}: ${v.recommendation}${v.ready_for_magi_review ? " (ready for MAGI review)" : ""}.`,
							{ goal: g },
						);
					});
				}

				case "complete": {
					if (!p.goal_id) return fail(action, "complete requires `goal_id`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.complete(id);
						return ok(action, `Completed ${g.id}.`, { goal: g });
					});
				}

				case "block": {
					if (!p.goal_id) return fail(action, "block requires `goal_id`.");
					if (!p.reason) return fail(action, "block requires `reason`.");
					if (!p.evidence) return fail(action, "block requires `evidence`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.block(id, {
							reason: p.reason!,
							evidence: p.evidence,
							related_ids: p.related_ids,
							next_revisit_at: p.next_revisit_at,
							unblock_conditions: p.unblock_conditions,
							terminal_resolution: p.terminal_resolution,
						});
						return ok(action, `Blocked ${g.id}: ${g.blocker?.reason ?? p.reason}.`, { goal: g });
					});
				}

				case "escalate": {
					if (!p.goal_id) return fail(action, "escalate requires `goal_id`.");
					if (!p.reason) return fail(action, "escalate requires `reason`.");
					if (!p.evidence) return fail(action, "escalate requires `evidence`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.escalate(id, {
							reason: p.reason!,
							evidence: p.evidence,
							related_ids: p.related_ids,
							next_revisit_at: p.next_revisit_at,
							unblock_conditions: p.unblock_conditions,
							terminal_resolution: p.terminal_resolution,
						});
						return ok(action, `Escalated ${g.id} to AMYGDALA: ${g.blocker?.reason ?? p.reason}.`, { goal: g });
					});
				}

				case "drain": {
					return runOp(store, action, (s) => {
						const run = s.startDrain({ policy_name: p.policy_name, max_goals: p.max_goals, evidence: p.evidence, force: p.force });
						const ids = (xs: string[]) => xs.length ? xs.map((id) => `\`${id}\``).join(", ") : "—";
						const text = [
							`Drain ${run.id}: ${run.status}`,
							`workable: ${ids(run.workable_goal_ids)}`,
							`actionable: ${ids(run.actionable_goal_ids)}`,
							`due_revisit: ${ids(run.due_revisit_goal_ids)}`,
							`retryable: ${ids(run.retryable_goal_ids)} · classify: ${ids(run.needs_retry_classification_goal_ids)}`,
							`waiting blocked/needs_amygdala: ${ids(run.waiting_goal_ids)}`,
							`risk gate: ${run.risk_gate_mode}; accepted: ${ids(run.risk_accepted_goal_ids)}`,
							`policy: ${run.policy.name}; budgets max_goals=${run.policy.max_goals}, replans=${run.policy.max_replans_per_goal}, retries=${run.policy.max_retries_per_goal}, no_progress=${run.policy.max_no_progress_iterations}`,
						].join("\n");
						return ok(action, text, { drain_run: run });
					});
				}

				case "get_config": {
					return runQuery(store, action, (s) => {
						const config = s.getConfig();
						return ok(action, `CORTEX config: drain_mode=${config.drain_mode}, default_drain_policy=${config.default_drain_policy}, risk_gate_mode=${config.risk_gate_mode}.`, { config });
					});
				}

				case "set_config": {
					return runOp(store, action, (s) => {
						const config = s.setConfig({
							drain_mode: p.drain_mode,
							default_drain_policy: p.default_drain_policy,
							risk_gate_mode: p.risk_gate_mode,
							risk_gate_evidence: p.risk_gate_evidence,
							dangerous_opt_in: p.dangerous_opt_in,
						});
						return ok(action, `Updated CORTEX config: drain_mode=${config.drain_mode}, default_drain_policy=${config.default_drain_policy}, risk_gate_mode=${config.risk_gate_mode}.`, { config });
					});
				}

				case "accept_risk": {
					if (!p.goal_id) return fail(action, "accept_risk requires `goal_id`.");
					if (!p.reason) return fail(action, "accept_risk requires `reason`.");
					if (!p.evidence) return fail(action, "accept_risk requires `evidence`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.acceptRisk(id, {
							reason: p.reason!,
							evidence: p.evidence,
							actor: p.actor,
							scope: p.scope,
							expires_at: p.expires_at,
							related_ids: p.related_ids,
							mode: p.risk_gate_mode === "auto_deliberate" || p.risk_gate_mode === "user_accepted" || p.risk_gate_mode === "disabled" ? p.risk_gate_mode : undefined,
						});
						return ok(action, `Accepted risk for ${g.id}: ${g.risk_acceptance?.reason ?? p.reason}.`, { goal: g });
					});
				}

				case "record_failure": {
					if (!p.goal_id) return fail(action, "record_failure requires `goal_id`.");
					if (!p.reason) return fail(action, "record_failure requires `reason`.");
					if (!p.evidence) return fail(action, "record_failure requires `evidence`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.recordFailure(id, {
							reason: p.reason!,
							evidence: p.evidence,
							related_ids: p.related_ids,
							retryability: p.retryability,
							next_retry_at: p.next_retry_at,
							max_attempts: p.max_attempts,
							terminal_resolution: p.terminal_resolution,
						});
						return ok(action, `Recorded failure for ${g.id}: retryability=${g.failure?.retryability ?? "unknown"}.`, { goal: g });
					});
				}

				case "reopen": {
					if (!p.goal_id) return fail(action, "reopen requires `goal_id`.");
					if (!p.reason) return fail(action, "reopen requires `reason`.");
					if (!p.evidence) return fail(action, "reopen requires `evidence`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.reopen(id, { reason: p.reason!, evidence: p.evidence, related_ids: p.related_ids });
						return ok(action, `Reopened ${g.id}; status=${g.status}.`, { goal: g });
					});
				}

				case "cancel": {
					if (!p.goal_id) return fail(action, "cancel requires `goal_id`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.cancel(id);
						return ok(action, `Cancelled ${g.id}.`, { goal: g });
					});
				}

				case "get": {
					return runQuery(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id);
						const g = id ? s.get(id) : s.current();
						if (!g) return fail(action, `No goal found${p.goal_id ? ` for "${p.goal_id}"` : ""}.`);
						return ok(action, summarizeGoal(g), { goal: g });
					});
				}

				case "list": {
					return runQuery(store, action, (s) => {
						const goals = s.list({ status: p.status_filter as GoalStatus | undefined });
						return ok(action, summarizeGoalList(goals), { goals });
					});
				}

				case "summary": {
					return runQuery(store, action, (s) => {
						const goals = s.all();
						const by_status: Partial<Record<GoalStatus, number>> = {};
						for (const g of goals) by_status[g.status] = (by_status[g.status] ?? 0) + 1;
						const active = goals
							.filter((g) => g.status !== "completed" && g.status !== "cancelled" && g.status !== "blocked" && g.status !== "needs_amygdala")
							.map((g) => ({ id: g.id, goal: g.intent.goal || g.prompt, status: g.status }));
						const config = s.getConfig();
						const md = [
							`# CORTEX — ${project}`,
							``,
							`**${goals.length}** goal(s) · current: \`${s.current_goal_id ?? s.current()?.id ?? "—"}\``,
							`**drain:** ${config.drain_mode} · policy: ${config.default_drain_policy} · risk gate: ${config.risk_gate_mode}`,
							``,
							active.length ? `## Active` : `_(no active goals)_`,
							...active.map((g) => `- ${STATUS_HINT(g.status)} \`${g.id}\` — ${g.goal}`),
						].join("\n");
						return ok(action, md, { goals });
					});
				}

				case "set_current": {
					if (!p.goal_id) return fail(action, "set_current requires `goal_id`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.setCurrent(id);
						return ok(action, `Current goal set to ${g.id}.`, { goal: g });
					});
				}

				default:
					return fail(action, `Unknown action: ${action as string}`);
			}
		},

		renderCall(args, theme) {
			return renderCortexCall(args as { action: string; goal_id?: string; prompt?: string }, theme as never);
		},
		renderResult(result, options, theme) {
			return renderCortexResult(
				result as Parameters<typeof renderCortexResult>[0],
				options as Parameters<typeof renderCortexResult>[1],
				theme as never,
			);
		},
	});

	/* ------------------------------- commands ------------------------------ */

	pi.registerCommand("cortex", {
		description: "Show the current CORTEX goal (or a summary if none)",
		handler: async (_args, ctx) => {
			const store = CortexStore.fromCwd(ctx.cwd);
			const { result } = await store.query((s) => s.current());
			if (!result) {
				ctx.ui.notify("No current CORTEX goal. Use the cortex tool (analyze) to create one.", "info");
				return;
			}
			post(ctx, pi, summarizeGoal(result), { goal: result });
		},
	});

	pi.registerCommand("cortex:goals", {
		description: "List all CORTEX goals",
		handler: async (_args, ctx) => {
			const store = CortexStore.fromCwd(ctx.cwd);
			const { result } = await store.query((s) => s.all());
			post(ctx, pi, summarizeGoalList(result), { goals: result });
		},
	});

	pi.registerCommand("cortex:resume", {
		description: "Print the current goal so work can resume after compaction/restart",
		handler: async (_args, ctx) => {
			const store = CortexStore.fromCwd(ctx.cwd);
			const { result } = await store.query((s) => s.current());
			if (!result) {
				ctx.ui.notify("No current CORTEX goal to resume.", "info");
				return;
			}
			const hint =
				result.status === "analyzed"
					? result.intent.needs_magi
						? "Next: convene MAGI, then cortex plan."
						: "Next: cortex plan."
					: result.status === "planned"
						? "Next: create subtasks in AXON, then cortex link."
						: result.status === "executing"
							? "Next: do the work (update AXON), then cortex verify."
							: result.status === "verified"
								? "Next: MAGI final review, then cortex complete."
								: result.status === "needs_replan"
									? "Next: revise the plan (cortex plan)."
									: result.status === "blocked" || result.status === "needs_amygdala"
										? "Goal is waiting with blocker/AMYGDALA evidence; resolve or cancel before drain can act."
										: "Goal is terminal.";
			post(ctx, pi, `${summarizeGoal(result)}\n\n---\n**Resume hint:** ${hint}`, { goal: result });
		},
	});
}

/* ----------------------------- helpers ---------------------------------- */

function STATUS_HINT(status: GoalStatus): string {
	switch (status) {
		case "analyzed":
			return "◇";
		case "planned":
			return "▹";
		case "executing":
			return "▶";
		case "verified":
			return "✓";
		case "needs_replan":
			return "↻";
		case "blocked":
			return "⛔";
		case "needs_amygdala":
			return "⚠";
		case "completed":
			return "✓";
		case "cancelled":
			return "⊘";
	}
}

function post(ctx: ExtensionContext, pi: ExtensionAPI, markdown: string, details: Record<string, unknown>): void {
	if (ctx.hasUI) {
		pi.sendMessage({ customType: "cortex", content: markdown, display: true, details }, { triggerTurn: false });
	} else {
		ctx.ui.notify(markdown, "info");
	}
}
