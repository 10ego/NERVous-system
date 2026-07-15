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
import { getSelectListTheme, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Key, matchesKey, type SelectItem, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { getNervousModel, resolveNervousModel, type NervousModelKey } from "@nervous-system/state";
import {
	applyNervousCerebelMaxParallelPatch,
	applyNervousEnabledPatch,
	applyNervousModelPatch,
	DEFAULT_CEREBEL_MAX_PARALLEL,
	loadNervousConfig,
	MAX_CEREBEL_MAX_PARALLEL,
	MIN_CEREBEL_MAX_PARALLEL,
	readUserNervousConfig,
	resolveNervousCerebelMaxParallel,
	resolveNervousEnabled,
	writeUserNervousConfig,
	type NervousConfigResolution,
} from "./enablement.ts";
import { CortexStore } from "./backend.ts";
import {
	type CortexAction,
	CortexError,
	type CortexConfig,
	CortexToolParams,
	type CortexToolInput,
	type DrainMode,
	type DrainPolicyName,
	type Goal,
	type GoalStatus,
	type IntentAnalysis,
	type RiskGateMode,
	type VerifyRecommendation,
} from "./schema.ts";
import type { ConfigInput } from "./store.ts";
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

export function magiReadinessGaps(intent: IntentAnalysis): string[] {
	const gaps: string[] = [];
	if (!intent.goal.trim()) gaps.push("objective");
	if (!intent.success_criteria.length) gaps.push("success criteria");
	if (!intent.framing?.scope.length) gaps.push("scope");
	if (!intent.framing?.decision_needed?.trim()) gaps.push("decision_needed");
	return gaps;
}

/** Resolve the goal id: explicit id, "current"/"latest", or undefined. */
function resolveGoalId(s: import("./store.ts").GoalStore, id: string | undefined): string | undefined {
	if (!id || id === "current" || id === "latest") return s.current_goal_id ?? s.current()?.id;
	return id;
}

const ROOT_CONTROL_PLANE_SCOPES = Symbol.for("nervous-system.root-control-plane-scopes");
type RootControlPlaneRegistry = typeof globalThis & { [ROOT_CONTROL_PLANE_SCOPES]?: WeakSet<object> };

function rootControlPlaneRegistry(): WeakSet<object> {
	const root = globalThis as RootControlPlaneRegistry;
	return root[ROOT_CONTROL_PLANE_SCOPES] ??= new WeakSet<object>();
}

function extensionRuntimeScope(pi: ExtensionAPI): object {
	// Pi creates a separate ExtensionAPI wrapper for each extension, while the
	// event bus is shared by every extension loaded into the same runtime.
	return pi.events;
}

export function markNervousRootControlPlane(pi: ExtensionAPI): () => void {
	const scope = extensionRuntimeScope(pi);
	rootControlPlaneRegistry().add(scope);
	return () => rootControlPlaneRegistry().delete(scope);
}

function hasNervousRootControlPlane(pi: ExtensionAPI): boolean {
	return rootControlPlaneRegistry().has(extensionRuntimeScope(pi));
}

export function registerCortexExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "cortex",
		label: "CORTEX",
		description: [
			"Main reasoning core: turn a user prompt into a durable goal (intent, success criteria, risks),",
			"decide whether MAGI is needed, store an execution plan, link AXON tasks, and verify completion.",
			"Goals persist across compaction/restart. Actions: analyze, refine, plan, link, verify, complete, block, escalate, accept_risk, record_failure, reopen, cancel, drain,",
			"get_config, set_config, get, list, summary, set_current.",
		].join(" "),
		promptSnippet: "Run CORTEX: frame new work once, analyze intent into a durable goal, plan, link AXON tasks, verify",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"After explicit NERVous activation, check CORTEX config; unless drain_mode=off, default to draining all workable incomplete CORTEX goals, including due revisits and retryable/classification-needed failures.",
			"When explaining a NERVous workflow, prefer a compact checklist of component → action/status → evidence; avoid verbose restatement.",
			"Before cortex analyze for new work, perform one bounded task-framing pass: inspect relevant context when useful, make scope/non-goals/assumptions explicit, clarify blocking questions, and identify candidate options plus the decision MAGI would need to make. Do not repeat framing on resume or replan.",
			"Use the cortex tool action 'analyze' to persist the framed intent, success criteria, constraints, risks, and optional framing brief as a durable goal. If its response reports MAGI readiness gaps, use cortex action 'refine' on the same analyzed goal before deliberation; do not create a duplicate goal.",
			"After cortex analyze/refine, if needs_magi is true or the decision is hard/risky/ambiguous/architectural, ensure the objective, scope, success criteria, and decision_needed are concrete, then pass framing context/constraints/options/decision_needed to magi before cortex plan; otherwise proceed to cortex plan.",
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
							framing: p.framing,
							complexity: p.complexity,
							needs_magi: p.needs_magi,
							magi_rationale: p.magi_rationale,
						});
						const gaps = g.intent.needs_magi ? magiReadinessGaps(g.intent) : [];
						const next = g.intent.needs_magi
							? gaps.length
								? `needs_magi=true, but framing is not ready (${gaps.join(", ")}); do not convene MAGI until these gaps are resolved.`
								: `needs_magi=true → framing ready; convene MAGI before planning.`
							: `proceed to plan.`;
						return ok(action, `Analyzed ${g.id}: ${g.intent.intent_summary}\n(${next})`, { goal: g });
					});
				}

				case "refine": {
					if (!p.goal_id) return fail(action, "refine requires `goal_id`.");
					return runOp(store, action, (s) => {
						const id = resolveGoalId(s, p.goal_id)!;
						const g = s.refine(id, {
							intent_summary: p.intent_summary,
							goal: p.goal,
							success_criteria: p.success_criteria,
							constraints: p.constraints,
							risks: p.risks,
							expected_output: p.expected_output,
							framing: p.framing,
							complexity: p.complexity,
							needs_magi: p.needs_magi,
							magi_rationale: p.magi_rationale,
						});
						const gaps = g.intent.needs_magi ? magiReadinessGaps(g.intent) : [];
						const next = g.intent.needs_magi
							? gaps.length
								? `MAGI framing still incomplete (${gaps.join(", ")}); refine this goal again before deliberation.`
								: `MAGI framing ready; convene MAGI before planning.`
							: `proceed to plan.`;
						return ok(action, `Refined ${g.id} in place: ${g.intent.intent_summary}\n(${next})`, { goal: g });
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

	if (!hasNervousRootControlPlane(pi)) registerNervousConfigCommand(pi);
}

export default function cortexExtension(pi: ExtensionAPI): void {
	registerCortexExtension(pi);
}

/**
 * Register the persistent NERVous control command. The root package's control
 * plane calls this even when the rest of the suite is disabled, so it remains
 * possible to turn the installed suite back on without editing settings.json.
 */
export interface NervousConfigCommandOptions {
	onEnablementChange?: (enabled: boolean, ctx: ExtensionCommandContext) => void | Promise<void>;
}

export function registerNervousConfigCommand(pi: ExtensionAPI, options: NervousConfigCommandOptions = {}): void {
	pi.registerCommand("nervous:config", {
		description: "Show or set persistent NERVous enablement, drain/risk, and model defaults",
		handler: async (args, ctx) => {
			const store = CortexStore.fromCwd(ctx.cwd);
			const rawArgs = args ?? "";
			const parsed = parseNervousConfigArgs(rawArgs);
			if (parsed.errors.length) {
				ctx.ui.notify(`Invalid NERVous config: ${parsed.errors.join("; ")}`, "error");
				return;
			}
			if (parsed.hasEnablementChange && !options.onEnablementChange) {
				ctx.ui.notify("Suite enablement is available only through the installed nervous-system root package.", "error");
				return;
			}
			try {
				let config: CortexConfig;
				if (parsed.hasCortexChanges) {
					const { result } = await store.mutate((s) => s.setConfig(parsed.patch));
					config = result;
				} else {
					const { result } = await store.query((s) => s.getConfig());
					config = result;
				}
				if (parsed.hasEnablementChange) await options.onEnablementChange?.(parsed.enabled!, ctx);
				if (parsed.hasNervousChanges) {
					let next = readUserNervousConfig();
					if (parsed.enabled !== undefined) next = applyNervousEnabledPatch(next, parsed.enabled);
					if (parsed.hasModelChanges) next = applyNervousModelPatch(next, parsed.modelPatch);
					if (parsed.cerebelMaxParallel !== undefined) next = applyNervousCerebelMaxParallelPatch(next, parsed.cerebelMaxParallel);
					writeUserNervousConfig(next);
				}
				const nervousConfig = loadNervousConfig({ cwd: ctx.cwd, isProjectTrusted: () => ctx.isProjectTrusted?.() ?? false });
				if (parsed.hasChanges) {
					post(ctx, pi, summarizeConfig(config, true, nervousConfig), { config, nervous_config: nervousConfig });
					if (parsed.hasEnablementChange) {
						ctx.ui.notify("NERVous enablement updated; reloading this session.", "info");
						await ctx.reload();
					}
					return;
				}

				if (shouldOpenConfigMenu(rawArgs, ctx)) {
					const available = await availableModelSpecs(ctx);
					const menuResult = await showNervousConfigMenu(store, config, nervousConfig, ctx, available, options.onEnablementChange);
					if (menuResult.kind === "fallback") post(ctx, pi, summarizeConfig(config, false, nervousConfig), { config, nervous_config: nervousConfig });
					return;
				}

				post(ctx, pi, summarizeConfig(config, false, nervousConfig), { config, nervous_config: nervousConfig });
			} catch (e) {
				const msg = e instanceof CortexError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`nervous:config failed: ${msg}`, "error");
			}
		},
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.toLowerCase();
			const filtered = CONFIG_COMPLETIONS
				.filter((item) => options.onEnablementChange || !item.value.startsWith("enabled="))
				.filter((item) => item.value.toLowerCase().startsWith(normalized));
			return filtered.length ? filtered : null;
		},
	});
}

/* ----------------------------- helpers ---------------------------------- */

const DRAIN_MODE_VALUES = ["off", "on_explicit_nervous", "always"] as const;
const RISK_GATE_MODE_VALUES = ["strict", "auto_deliberate", "user_accepted", "disabled"] as const;
const DRAIN_POLICY_VALUES = ["default", "conservative", "aggressive"] as const;
const MODEL_UNSET = "(unset — pi default)";
const CEREBEL_MAX_PARALLEL_VALUES = Array.from(
	{ length: MAX_CEREBEL_MAX_PARALLEL - MIN_CEREBEL_MAX_PARALLEL + 1 },
	(_, index) => String(MIN_CEREBEL_MAX_PARALLEL + index),
);
const MODEL_SETTING_IDS = ["lion.default", "lion.implementationDefault", "lion.reviewDefault", "magi.councillorDefault", "magi.synthesisDefault"] as const satisfies readonly NervousModelKey[];

const DRAIN_MODE_DESCRIPTIONS: Record<DrainMode, string> = {
	off: "disable automatic drain; only explicit forced drain can run",
	on_explicit_nervous: "drain when /nervous is explicitly invoked",
	always: "default to draining/resuming actionable incomplete goals",
};

const RISK_GATE_MODE_DESCRIPTIONS: Record<RiskGateMode, string> = {
	strict: "block or escalate risky work unless explicit evidence is recorded elsewhere",
	auto_deliberate: "allow risky work only with recorded MAGI/AMYGDALA approval evidence",
	user_accepted: "allow risky work only with scoped user acceptance evidence",
	disabled: "dangerous opt-in; requires dangerous_opt_in=true and non-empty evidence",
};

const DRAIN_POLICY_DESCRIPTIONS: Record<DrainPolicyName, string> = {
	default: "balanced drain budgets and retry/replan limits",
	conservative: "smaller, safer drain budgets",
	aggressive: "larger, more proactive drain budgets",
};

const MODEL_DESCRIPTIONS: Record<NervousModelKey, string> = {
	"lion.default": "generic fallback model for LION workers when no role-specific model is set",
	"lion.implementationDefault": "default model for LION implementation workers",
	"lion.reviewDefault": "default model for LION review/QA workers",
	"magi.councillorDefault": "default model for MAGI councillors whose council config omits model",
	"magi.synthesisDefault": "separate default model for MAGI synthesis when no synthesis/synthesizer model is explicit",
};

const MODEL_ALIASES: Record<string, NervousModelKey> = {
	"lion": "lion.default",
	"lion_model": "lion.default",
	"lion-model": "lion.default",
	"lion.default": "lion.default",
	"model.lion": "lion.default",
	"model.lion.default": "lion.default",
	"models.lion.default": "lion.default",
	"lion_implementation": "lion.implementationDefault",
	"lion-implementation": "lion.implementationDefault",
	"lion_implementation_model": "lion.implementationDefault",
	"lion-implementation-model": "lion.implementationDefault",
	"lion_impl_model": "lion.implementationDefault",
	"lion-impl-model": "lion.implementationDefault",
	"lion.implementation": "lion.implementationDefault",
	"lion.implementationdefault": "lion.implementationDefault",
	"model.lion.implementation": "lion.implementationDefault",
	"model.lion.implementationdefault": "lion.implementationDefault",
	"models.lion.implementationdefault": "lion.implementationDefault",
	"lion_review": "lion.reviewDefault",
	"lion-review": "lion.reviewDefault",
	"lion_review_model": "lion.reviewDefault",
	"lion-review-model": "lion.reviewDefault",
	"lion.review": "lion.reviewDefault",
	"lion.reviewdefault": "lion.reviewDefault",
	"model.lion.review": "lion.reviewDefault",
	"model.lion.reviewdefault": "lion.reviewDefault",
	"models.lion.reviewdefault": "lion.reviewDefault",
	"magi": "magi.councillorDefault",
	"magi_model": "magi.councillorDefault",
	"magi-model": "magi.councillorDefault",
	"magi.default": "magi.councillorDefault",
	"magi.councillor": "magi.councillorDefault",
	"magi.councillor_default": "magi.councillorDefault",
	"magi.councillor-default": "magi.councillorDefault",
	"magi.councillordefault": "magi.councillorDefault",
	"model.magi": "magi.councillorDefault",
	"model.magi.councillor": "magi.councillorDefault",
	"model.magi.councillordefault": "magi.councillorDefault",
	"models.magi.councillordefault": "magi.councillorDefault",
	"magi_synthesis": "magi.synthesisDefault",
	"magi-synthesis": "magi.synthesisDefault",
	"magi_synthesis_model": "magi.synthesisDefault",
	"magi-synthesis-model": "magi.synthesisDefault",
	"magi.synthesis": "magi.synthesisDefault",
	"magi.synthesis_default": "magi.synthesisDefault",
	"magi.synthesis-default": "magi.synthesisDefault",
	"magi.synthesisdefault": "magi.synthesisDefault",
	"model.magi.synthesis": "magi.synthesisDefault",
	"model.magi.synthesisdefault": "magi.synthesisDefault",
	"models.magi.synthesisdefault": "magi.synthesisDefault",
};

const CONFIG_COMPLETIONS: Array<{ value: string; label: string }> = [
	{ value: "enabled=true", label: "enabled=true — load the full NERVous suite in this session" },
	{ value: "enabled=false", label: "enabled=false — unload the NERVous suite, leaving only /nervous:config" },
	...DRAIN_MODE_VALUES.map((value) => ({ value: `drain=${value}`, label: `drain=${value} — ${DRAIN_MODE_DESCRIPTIONS[value]}` })),
	...RISK_GATE_MODE_VALUES.map((value) => ({ value: `risk=${value}`, label: `risk=${value} — ${RISK_GATE_MODE_DESCRIPTIONS[value]}` })),
	...DRAIN_POLICY_VALUES.map((value) => ({ value: `policy=${value}`, label: `policy=${value} — ${DRAIN_POLICY_DESCRIPTIONS[value]}` })),
	...CEREBEL_MAX_PARALLEL_VALUES.map((value) => ({ value: `max_parallel=${value}`, label: `max_parallel=${value} — default concurrent LION workers for new CEREBEL waves` })),
	{ value: "lion_model=", label: `lion_model=<model> — ${MODEL_DESCRIPTIONS["lion.default"]}` },
	{ value: "lion_implementation_model=", label: `lion_implementation_model=<model> — ${MODEL_DESCRIPTIONS["lion.implementationDefault"]}` },
	{ value: "lion_review_model=", label: `lion_review_model=<model> — ${MODEL_DESCRIPTIONS["lion.reviewDefault"]}` },
	{ value: "magi_model=", label: `magi_model=<model> — ${MODEL_DESCRIPTIONS["magi.councillorDefault"]}` },
	{ value: "magi_synthesis_model=", label: `magi_synthesis_model=<model> — ${MODEL_DESCRIPTIONS["magi.synthesisDefault"]}` },
	{ value: "lion_model=unset", label: "lion_model=unset — clear the generic LION fallback model" },
	{ value: "lion_implementation_model=unset", label: "lion_implementation_model=unset — clear the LION implementation model default" },
	{ value: "lion_review_model=unset", label: "lion_review_model=unset — clear the LION review model default" },
	{ value: "dangerous_opt_in=true", label: "dangerous_opt_in=true — required with risk=disabled" },
	{ value: 'evidence="..."', label: 'evidence="..." — audit note; required with risk=disabled' },
];

type ConfigMenuResult = { kind: "closed" } | { kind: "fallback" };

interface ConfigDraft {
	enabled: boolean;
	cerebel_max_parallel: number;
	drain_mode: DrainMode;
	risk_gate_mode: RiskGateMode;
	default_drain_policy: DrainPolicyName;
	risk_gate_evidence?: string;
	models: Partial<Record<NervousModelKey, string>>;
}

function shouldOpenConfigMenu(args: string, ctx: ExtensionContext): boolean {
	return args.trim().length === 0 && ctx.mode === "tui" && typeof ctx.ui.custom === "function";
}

async function showNervousConfigMenu(
	store: CortexStore,
	config: CortexConfig,
	modelConfig: NervousConfigResolution,
	ctx: ExtensionCommandContext,
	availableModels: string[],
	onEnablementChange?: NervousConfigCommandOptions["onEnablementChange"],
): Promise<ConfigMenuResult> {
	const current: ConfigDraft = {
		enabled: resolveNervousEnabled(modelConfig).enabled,
		cerebel_max_parallel: resolveNervousCerebelMaxParallel(modelConfig).maxParallel,
		drain_mode: config.drain_mode,
		risk_gate_mode: config.risk_gate_mode,
		default_drain_policy: config.default_drain_policy,
		risk_gate_evidence: config.risk_gate_evidence,
		models: draftModelsFromUser(modelConfig),
	};

	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("NERVous CORTEX Config")), 1, 1));
			container.addChild(
				new Text(theme.fg("dim", "Select a value to apply it immediately. Esc closes the menu."), 1, 0),
			);

			let settingsList: SettingsList;
			let disabledPrompt: { previous: ConfigDraft; evidence: string; applying: boolean } | undefined;

			const updateSettingsList = () => {
				settingsList.updateValue("enabled", configValueForId(current, "enabled"));
				settingsList.updateValue("cerebel_max_parallel", String(current.cerebel_max_parallel));
				settingsList.updateValue("drain_mode", current.drain_mode);
				settingsList.updateValue("risk_gate_mode", current.risk_gate_mode);
				settingsList.updateValue("default_drain_policy", current.default_drain_policy);
				settingsList.updateValue("risk_gate_evidence", current.risk_gate_evidence ?? "(none)");
				for (const id of MODEL_SETTING_IDS) settingsList.updateValue(id, configValueForId(current, id));
			};

			const revert = (previous: ConfigDraft, id: string) => {
				current.enabled = previous.enabled;
				current.cerebel_max_parallel = previous.cerebel_max_parallel;
				current.drain_mode = previous.drain_mode;
				current.risk_gate_mode = previous.risk_gate_mode;
				current.default_drain_policy = previous.default_drain_policy;
				current.risk_gate_evidence = previous.risk_gate_evidence;
				current.models = { ...previous.models };
				settingsList.updateValue(id, configValueForId(previous, id));
				settingsList.updateValue("risk_gate_evidence", previous.risk_gate_evidence ?? "(none)");
				for (const modelId of MODEL_SETTING_IDS) settingsList.updateValue(modelId, configValueForId(previous, modelId));
				tui.requestRender();
			};

			const persistChange = async (id: string, patch: ConfigInput, previous: ConfigDraft) => {
				try {
					const { result } = await store.mutate((s) => s.setConfig(patch));
					current.drain_mode = result.drain_mode;
					current.risk_gate_mode = result.risk_gate_mode;
					current.default_drain_policy = result.default_drain_policy;
					current.risk_gate_evidence = result.risk_gate_evidence;
					updateSettingsList();
					ctx.ui.notify(`NERVous config updated: ${id}=${configValueForId(current, id)}`, "info");
					tui.requestRender();
				} catch (e) {
					revert(previous, id);
					const msg = e instanceof CortexError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
					ctx.ui.notify(`nervous:config failed: ${msg}`, "error");
				}
			};

			const applyChange = (id: string, newValue: string) => {
				const previous = cloneDraft(current);
				if (id === "enabled" && (newValue === "true" || newValue === "false")) {
					const enabled = newValue === "true";
					void (async () => {
						try {
							await onEnablementChange?.(enabled, ctx);
							writeUserNervousConfig(applyNervousEnabledPatch(readUserNervousConfig(), enabled));
							current.enabled = enabled;
							updateSettingsList();
							ctx.ui.notify("NERVous enablement updated; reloading this session.", "info");
							done(undefined);
							await ctx.reload();
						} catch (e) {
							revert(previous, id);
							ctx.ui.notify(`nervous:config failed: ${e instanceof Error ? e.message : String(e)}`, "error");
							tui.requestRender();
						}
					})().catch((e) => ctx.ui.notify(`nervous:config failed: ${e instanceof Error ? e.message : String(e)}`, "error"));
					return;
				}
				if (id === "cerebel_max_parallel" && CEREBEL_MAX_PARALLEL_VALUES.includes(newValue)) {
					try {
						const maxParallel = Number(newValue);
						writeUserNervousConfig(applyNervousCerebelMaxParallelPatch(readUserNervousConfig(), maxParallel));
						current.cerebel_max_parallel = maxParallel;
						updateSettingsList();
						ctx.ui.notify(`NERVous config updated: max_parallel=${maxParallel}`, "info");
					} catch (e) {
						revert(previous, id);
						ctx.ui.notify(`nervous:config failed: ${e instanceof Error ? e.message : String(e)}`, "error");
					}
					tui.requestRender();
					return;
				}
				if (isModelSettingId(id)) {
					const value = newValue === "__unset__" || newValue === MODEL_UNSET ? null : newValue;
					try {
						const next = applyNervousModelPatch(readUserNervousConfig(), { [id]: value });
						writeUserNervousConfig(next);
						if (value) current.models[id] = value;
						else delete current.models[id];
						updateSettingsList();
						ctx.ui.notify(`NERVous config updated: ${id}=${configValueForId(current, id)}`, "info");
					} catch (e) {
						revert(previous, id);
						ctx.ui.notify(`nervous:config failed: ${e instanceof Error ? e.message : String(e)}`, "error");
					}
					tui.requestRender();
					return;
				}
				let patch: ConfigInput | undefined;
				if (id === "drain_mode" && (DRAIN_MODE_VALUES as readonly string[]).includes(newValue)) {
					patch = { drain_mode: newValue as DrainMode };
				} else if (id === "default_drain_policy" && (DRAIN_POLICY_VALUES as readonly string[]).includes(newValue)) {
					patch = { default_drain_policy: newValue as DrainPolicyName };
				} else if (id === "risk_gate_mode" && (RISK_GATE_MODE_VALUES as readonly string[]).includes(newValue)) {
					if (newValue === "disabled") {
						disabledPrompt = {
							previous,
							evidence: `approved via /nervous:config TUI at ${new Date().toISOString()}`,
							applying: false,
						};
						tui.requestRender();
						return;
					}
					patch = { risk_gate_mode: newValue as RiskGateMode };
				}
				if (!patch) {
					revert(previous, id);
					return;
				}
				void persistChange(id, patch, previous);
			};

			const confirmDisabledRiskGate = () => {
				if (!disabledPrompt || disabledPrompt.applying) return;
				disabledPrompt.applying = true;
				const { previous, evidence } = disabledPrompt;
				void persistChange(
					"risk_gate_mode",
					{ risk_gate_mode: "disabled", dangerous_opt_in: true, risk_gate_evidence: evidence },
					previous,
				).finally(() => {
					disabledPrompt = undefined;
					tui.requestRender();
				});
			};

			const cancelDisabledRiskGate = () => {
				if (!disabledPrompt) return;
				revert(disabledPrompt.previous, "risk_gate_mode");
				disabledPrompt = undefined;
				ctx.ui.notify("NERVous config unchanged; disabled risk gate was not confirmed.", "warning");
				tui.requestRender();
			};

			settingsList = new SettingsList(
				configMenuItems(current, availableModels, Boolean(onEnablementChange)),
				9,
				getSettingsListTheme(),
				(id, newValue) => applyChange(id, newValue),
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);
			return {
				render(width: number) {
					if (disabledPrompt) return renderDisabledRiskPrompt(width, theme, disabledPrompt.evidence, disabledPrompt.applying);
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (disabledPrompt) {
						if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") confirmDisabledRiskGate();
						else if (matchesKey(data, Key.escape) || data.toLowerCase() === "n") cancelDisabledRiskGate();
						tui.requestRender();
						return;
					}
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`NERVous config menu unavailable; showing text config instead. ${msg}`, "warning");
		return { kind: "fallback" };
	}

	return { kind: "closed" };
}

function configMenuItems(current: ConfigDraft, availableModels: string[], canChangeEnablement: boolean): SettingItem[] {
	const modelItems: SettingItem[] = MODEL_SETTING_IDS.map((id) => ({
		id,
		label: modelLabel(id),
		description: `${MODEL_DESCRIPTIONS[id]}. ${availableModels.length ? "Press Enter to pick a model." : "Set directly with key=value if the model picker is unavailable."}`,
		currentValue: configValueForId(current, id),
		...(availableModels.length ? { submenu: buildModelSubmenu(availableModels, current.models[id]) } : {}),
	}));
	return [
		...(canChangeEnablement ? [{
			id: "enabled",
			label: "NERVous suite",
			description: "Turn the installed NERVous suite on or off. The session reloads; when off, only /nervous:config remains available to turn it back on.",
			currentValue: configValueForId(current, "enabled"),
			values: ["true", "false"],
		} satisfies SettingItem] : []),
		{
			id: "drain_mode",
			label: "Drain mode",
			description: `When CORTEX drain resumes incomplete goals. ${formatInlineDescriptions(DRAIN_MODE_VALUES, DRAIN_MODE_DESCRIPTIONS)}`,
			currentValue: current.drain_mode,
			values: [...DRAIN_MODE_VALUES],
		},
		{
			id: "cerebel_max_parallel",
			label: "CEREBEL parallel workers",
			description: `Default concurrent LION workers for new CEREBEL waves. Explicit plan_wave/run_wave max_parallel values still override it. Range: ${MIN_CEREBEL_MAX_PARALLEL}-${MAX_CEREBEL_MAX_PARALLEL}.`,
			currentValue: String(current.cerebel_max_parallel),
			values: CEREBEL_MAX_PARALLEL_VALUES,
		},
		{
			id: "risk_gate_mode",
			label: "Risk gate",
			description: `How risky work is authorized. Default: auto_deliberate. Hard-stop work still needs recorded MAGI/AMYGDALA evidence. ${formatInlineDescriptions(RISK_GATE_MODE_VALUES, RISK_GATE_MODE_DESCRIPTIONS)}`,
			currentValue: current.risk_gate_mode,
			values: [...RISK_GATE_MODE_VALUES],
		},
		{
			id: "default_drain_policy",
			label: "Drain policy",
			description: `Drain budget/retry posture. ${formatInlineDescriptions(DRAIN_POLICY_VALUES, DRAIN_POLICY_DESCRIPTIONS)}`,
			currentValue: current.default_drain_policy,
			values: [...DRAIN_POLICY_VALUES],
		},
		...modelItems,
		{
			id: "risk_gate_evidence",
			label: "Disabled evidence",
			description: "Audit note used only for risk_gate_mode=disabled. Selecting disabled prompts for this value.",
			currentValue: current.risk_gate_evidence ?? "(none)",
		},
	];
}

function configValueForId(config: ConfigDraft, id: string): string {
	if (id === "enabled") return String(config.enabled);
	if (id === "cerebel_max_parallel") return String(config.cerebel_max_parallel);
	if (id === "drain_mode") return config.drain_mode;
	if (id === "risk_gate_mode") return config.risk_gate_mode;
	if (id === "default_drain_policy") return config.default_drain_policy;
	if (id === "risk_gate_evidence") return config.risk_gate_evidence ?? "(none)";
	if (isModelSettingId(id)) return config.models[id] ?? MODEL_UNSET;
	return "";
}

const MODEL_LIST_ROWS = 10;

function buildModelSubmenu(available: string[], currentSpec: string | undefined) {
	return (_currentValue: string, done: (selectedValue?: string) => void) => {
		const allItems: SelectItem[] = [
			{ value: "__unset__", label: MODEL_UNSET, description: "Do not pass --model; use the current pi default behavior." },
			...available.map((spec) => ({ value: spec, label: spec })),
		];
		const theme = getSelectListTheme();
		const search = new Input();
		const makeList = (items: SelectItem[], selectValue?: string): SelectList => {
			const list = new SelectList(items, MODEL_LIST_ROWS, theme);
			if (selectValue) {
				const idx = items.findIndex((i) => i.value === selectValue);
				if (idx >= 0) list.setSelectedIndex(idx);
			}
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done();
			return list;
		};
		let list = makeList(allItems, currentSpec ?? "__unset__");
		const applyQuery = (query: string) => {
			const filtered = query.trim() ? fuzzyFilter(allItems, query, (i) => i.label) : allItems;
			list = makeList(filtered);
		};
		const navKeys = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		return {
			render(width: number): string[] {
				return [...search.render(width), ...list.render(width)];
			},
			invalidate(): void {
				search.invalidate?.();
				list.invalidate();
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (navKeys.some((k) => kb.matches(data, k))) {
					list.handleInput(data);
					return;
				}
				if (data.startsWith("\x1b")) return;
				const sanitized = data.replace(/ /g, "");
				if (!sanitized) return;
				search.handleInput(sanitized);
				applyQuery(search.getValue());
			},
		};
	};
}

function modelLabel(id: NervousModelKey): string {
	switch (id) {
		case "lion.default": return "LION fallback model";
		case "lion.implementationDefault": return "LION implementation model";
		case "lion.reviewDefault": return "LION review model";
		case "magi.councillorDefault": return "MAGI councillor model";
		case "magi.synthesisDefault": return "MAGI synthesis model";
	}
}

function draftModelsFromUser(modelConfig: NervousConfigResolution): Partial<Record<NervousModelKey, string>> {
	const models: Partial<Record<NervousModelKey, string>> = {};
	for (const id of MODEL_SETTING_IDS) {
		const model = getNervousModel(modelConfig.user, id);
		if (model) models[id] = model;
	}
	return models;
}

function cloneDraft(current: ConfigDraft): ConfigDraft {
	return { ...current, models: { ...current.models } };
}

function isModelSettingId(id: string): id is NervousModelKey {
	return (MODEL_SETTING_IDS as readonly string[]).includes(id);
}

async function availableModelSpecs(ctx: ExtensionContext): Promise<string[]> {
	try {
		return (await ctx.modelRegistry.getAvailable()).map((m) => `${m.provider}/${m.id}`).sort();
	} catch {
		return [];
	}
}

function renderDisabledRiskPrompt(width: number, theme: any, evidence: string, applying: boolean): string[] {
	const warning = new Container();
	warning.addChild(new Text(theme.fg("warning", theme.bold("Enable disabled risk gate?")), 1, 1));
	warning.addChild(
		new Text(
			theme.fg(
				"warning",
				"This is a dangerous opt-in. Disabled mode still records evidence, but it bypasses normal risk-gate blocking.",
			),
			1,
			0,
		),
	);
	warning.addChild(new Text(theme.fg("muted", `Evidence: ${evidence}`), 1, 1));
	warning.addChild(
		new Text(
			theme.fg("dim", applying ? "Applying…" : "Enter/Y to confirm • Esc/N to cancel and return to settings"),
			1,
			0,
		),
	);
	return warning.render(width);
}

function splitCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === "\\") {
				const next = input[i + 1];
				if (next === quote || next === "\\") {
					token += next;
					i++;
				} else {
					token += ch;
				}
				continue;
			}
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			token += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (token) {
				tokens.push(token);
				token = "";
			}
			continue;
		}
		token += ch;
	}
	if (token) tokens.push(token);
	return tokens;
}

interface ParsedNervousConfigArgs {
	patch: ConfigInput;
	modelPatch: Partial<Record<NervousModelKey, string | null>>;
	enabled?: boolean;
	cerebelMaxParallel?: number;
	hasCortexChanges: boolean;
	hasModelChanges: boolean;
	hasEnablementChange: boolean;
	hasNervousChanges: boolean;
	hasChanges: boolean;
	errors: string[];
}

function parseNervousConfigArgs(args: string): ParsedNervousConfigArgs {
	const patch: ConfigInput = {};
	const modelPatch: Partial<Record<NervousModelKey, string | null>> = {};
	let enabled: boolean | undefined;
	let cerebelMaxParallel: number | undefined;
	const errors: string[] = [];
	const tokens = splitCommandArgs(args).filter((token) => !["show", "get", "current"].includes(token.toLowerCase()));
	const takeValue = (i: number, key: string): { value?: string; next: number } => {
		const token = tokens[i] ?? "";
		const eq = token.indexOf("=");
		if (eq >= 0) return { value: token.slice(eq + 1), next: i };
		const next = tokens[i + 1];
		if (!next || next.startsWith("--")) {
			errors.push(`${key} requires a value`);
			return { next: i };
		}
		return { value: next, next: i + 1 };
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const rawKey = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		const key = rawKey.replace(/^--?/, "").toLowerCase();
		const modelKey = MODEL_ALIASES[key];
		if (modelKey) {
			const { value, next } = takeValue(i, key);
			i = next;
			if (value !== undefined) {
				const trimmed = value.trim();
				modelPatch[modelKey] = trimmed === "" || trimmed.toLowerCase() === "unset" ? null : trimmed;
			}
			continue;
		}
		if (["enabled", "enable", "nervous_enabled", "nervous-enabled"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			const normalized = value?.toLowerCase();
			if (["true", "on", "yes", "1"].includes(normalized ?? "")) enabled = true;
			else if (["false", "off", "no", "0"].includes(normalized ?? "")) enabled = false;
			else if (value !== undefined) errors.push(`invalid enabled "${value}"; use true or false`);
			continue;
		}
		if (["max_parallel", "max-parallel", "cerebel_max_parallel", "cerebel-max-parallel", "cerebel.maxparallel"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			const numeric = Number(value);
			if (value !== undefined && Number.isInteger(numeric) && numeric >= MIN_CEREBEL_MAX_PARALLEL && numeric <= MAX_CEREBEL_MAX_PARALLEL) cerebelMaxParallel = numeric;
			else if (value !== undefined) errors.push(`invalid max_parallel "${value}"; use an integer from ${MIN_CEREBEL_MAX_PARALLEL} through ${MAX_CEREBEL_MAX_PARALLEL}`);
			continue;
		}
		if (["drain", "drain_mode"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			if (value && (DRAIN_MODE_VALUES as readonly string[]).includes(value)) patch.drain_mode = value as DrainMode;
			else if (value) errors.push(`invalid drain_mode "${value}"`);
			continue;
		}
		if (["risk", "risk_gate", "risk_gate_mode"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			if (value && (RISK_GATE_MODE_VALUES as readonly string[]).includes(value)) patch.risk_gate_mode = value as RiskGateMode;
			else if (value) errors.push(`invalid risk_gate_mode "${value}"`);
			continue;
		}
		if (["policy", "default_drain_policy"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			if (value && (DRAIN_POLICY_VALUES as readonly string[]).includes(value)) patch.default_drain_policy = value as DrainPolicyName;
			else if (value) errors.push(`invalid default_drain_policy "${value}"`);
			continue;
		}
		if (["evidence", "risk_gate_evidence"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			if (value?.trim()) patch.risk_gate_evidence = value.trim();
			else if (value !== undefined) errors.push("risk_gate_evidence cannot be empty");
			continue;
		}
		if (["dangerous", "dangerous_opt_in", "dangerous-opt-in"].includes(key)) {
			const { value, next } = takeValue(i, key);
			i = next;
			const normalized = value?.toLowerCase();
			if (normalized === "true") patch.dangerous_opt_in = true;
			else if (normalized === "false") patch.dangerous_opt_in = false;
			else if (value !== undefined) errors.push(`invalid dangerous_opt_in "${value}"; use true or false`);
			continue;
		}
		errors.push(`unknown option "${rawKey}"`);
	}
	const hasCortexChanges = Boolean(patch.drain_mode || patch.default_drain_policy || patch.risk_gate_mode || patch.risk_gate_evidence);
	const hasModelChanges = Object.keys(modelPatch).length > 0;
	const hasEnablementChange = enabled !== undefined;
	const hasNervousChanges = hasEnablementChange || hasModelChanges || cerebelMaxParallel !== undefined;
	return { patch, modelPatch, enabled, cerebelMaxParallel, hasCortexChanges, hasModelChanges, hasEnablementChange, hasNervousChanges, hasChanges: hasCortexChanges || hasNervousChanges, errors };
}

export function summarizeConfig(config: CortexConfig, changed: boolean, modelConfig?: NervousConfigResolution): string {
	const lines = [
		`# NERVous config${changed ? " updated" : ""}`,
		"",
		"## Current CORTEX defaults",
		"| Setting | Current | Meaning |",
		"|---|---|---|",
		`| \`drain_mode\` | \`${config.drain_mode}\` | When drain resumes incomplete goals. |`,
		`| \`risk_gate_mode\` | \`${config.risk_gate_mode}\` | How risky work is authorized. |`,
		`| \`default_drain_policy\` | \`${config.default_drain_policy}\` | Drain budget/retry posture. |`,
	];
	if (config.risk_gate_evidence) lines.push(`| \`risk_gate_evidence\` | ${config.risk_gate_evidence} | Audit evidence for disabled risk gate mode. |`);
	const enablement = modelConfig ? resolveNervousEnabled(modelConfig) : { enabled: true, source: "default" as const };
	const cerebelMaxParallel = modelConfig ? resolveNervousCerebelMaxParallel(modelConfig) : { maxParallel: DEFAULT_CEREBEL_MAX_PARALLEL, source: "default" as const };
	lines.push("", "## NERVous suite", "| Setting | Effective | Source | Meaning |", "|---|---|---|---|");
	lines.push(`| \`enabled\` | \`${enablement.enabled}\` | ${enablement.source} | Load NERVous tools, commands, skills, and prompts. Changes reload the session. |`);
	lines.push(`| \`cerebel.maxParallel\` | \`${cerebelMaxParallel.maxParallel}\` | ${cerebelMaxParallel.source} | Default concurrent LION workers for new CEREBEL waves. |`);
	lines.push("", "## Current model defaults", "| Model key | User setting | Effective | Source | Used for |", "|---|---|---|---|---|");
	for (const key of MODEL_SETTING_IDS) {
		const user = modelConfig ? getNervousModel(modelConfig.user, key) : undefined;
		const resolved = modelConfig ? resolveNervousModel(modelConfig, key) : { source: "default" as const };
		lines.push(`| \`${key}\` | ${formatModelCell(user, "_unset_")} | ${formatModelCell(resolved.model, "_pi default_")} | ${resolved.source} | ${MODEL_DESCRIPTIONS[key]} |`);
	}
	if (modelConfig) {
		lines.push("", `User model config: \`${modelConfig.userPath}\``);
		if (modelConfig.projectLoaded) lines.push(`Project model overlay (trusted): \`${modelConfig.projectPath}\``);
		else if (!modelConfig.projectTrusted) lines.push(`Project model overlay ignored until project is trusted: \`${modelConfig.projectPath}\``);
	}
	lines.push(
		"",
		"## Usage",
		"- Open the TUI menu: `/nervous:config`",
		"- Print this help: `/nervous:config show`",
		"- Root NERVous System package only: turn the installed suite off with `/nervous:config enabled=false` (reloads this session; the config command stays available)",
		"- Root NERVous System package only: turn the suite back on with `/nervous:config enabled=true`",
		"- Set CORTEX defaults: `/nervous:config drain=always risk=auto_deliberate policy=default`",
		"- Set CEREBEL concurrency: `/nervous:config max_parallel=6`",
		"- Set model defaults: `/nervous:config lion_implementation_model=provider/fast lion_review_model=provider/strong magi_model=provider/model`",
		"- Clear a model default: `/nervous:config lion_review_model=unset`",
		"",
		"## Options",
		"",
		"### Root-package suite enablement",
		"Aliases: `enabled`, `enable`, `nervous_enabled`",
		"Available only through the installed root NERVous System package. `true` loads the complete suite. `false` unloads all NERVous tools, workflow commands, skills, and prompts after reload, while preserving `/nervous:config` so it can be re-enabled.",
		"",
		"### Drain mode",
		"Aliases: `drain`, `drain_mode`",
		...formatOptionTable(DRAIN_MODE_VALUES, DRAIN_MODE_DESCRIPTIONS),
		"",
		"### Risk gate",
		"Aliases: `risk`, `risk_gate`, `risk_gate_mode`",
		"Default: `auto_deliberate` — hard-stop work still needs recorded MAGI/AMYGDALA approval evidence.",
		...formatOptionTable(RISK_GATE_MODE_VALUES, RISK_GATE_MODE_DESCRIPTIONS),
		"",
		"### Drain policy",
		"Aliases: `policy`, `default_drain_policy`",
		...formatOptionTable(DRAIN_POLICY_VALUES, DRAIN_POLICY_DESCRIPTIONS),
		"",
		"### CEREBEL parallel workers",
		"Aliases: `max_parallel`, `cerebel_max_parallel`",
		`Integer from ${MIN_CEREBEL_MAX_PARALLEL} through ${MAX_CEREBEL_MAX_PARALLEL}. Default: 3. Used when a new CEREBEL wave omits max_parallel; explicit plan_wave and run_wave values still override it.`,
		"",
		"### Model defaults",
		"Aliases: `lion_model`, `lion_implementation_model`, `lion_review_model`, `magi_model`, `magi_synthesis_model` (also exact keys like `model.lion.review`).",
		"A `<model>` is any pi model spec (`provider/model` or `provider/model:thinking`). Unset means NERVous passes no `--model`, preserving the current pi default behavior.",
		...formatOptionTable(MODEL_SETTING_IDS, MODEL_DESCRIPTIONS),
		"",
		"### Advanced disabled risk gate",
		"- Requires exact `dangerous_opt_in=true` plus non-empty `evidence` / `risk_gate_evidence`.",
		'- Example: `/nervous:config risk=disabled dangerous_opt_in=true evidence="explicit user-approved automation window"`',
	);
	return lines.join("\n");
}

function formatModelCell(model: string | undefined, fallback: string): string {
	return model ? `\`${model}\`` : fallback;
}

function formatOptionTable<T extends string>(values: readonly T[], descriptions: Record<T, string>): string[] {
	return ["| Value | Meaning |", "|---|---|", ...values.map((value) => `| \`${value}\` | ${descriptions[value]} |`)];
}

function formatInlineDescriptions<T extends string>(values: readonly T[], descriptions: Record<T, string>): string {
	return values.map((value) => `${value}: ${descriptions[value]}`).join("; ");
}

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
