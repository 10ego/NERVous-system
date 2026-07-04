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
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
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

	pi.registerCommand("nervous:config", {
		description: "Show or set persistent CORTEX drain/risk-gate config used by /nervous",
		handler: async (args, ctx) => {
			const store = CortexStore.fromCwd(ctx.cwd);
			const rawArgs = args ?? "";
			const parsed = parseNervousConfigArgs(rawArgs);
			if (parsed.errors.length) {
				ctx.ui.notify(`Invalid NERVous config: ${parsed.errors.join("; ")}`, "error");
				return;
			}
			try {
				if (parsed.hasChanges) {
					const { result } = await store.mutate((s) => s.setConfig(parsed.patch));
					post(ctx, pi, summarizeConfig(result, true), { config: result });
					return;
				}

				const { result: config } = await store.query((s) => s.getConfig());
				if (shouldOpenConfigMenu(rawArgs, ctx)) {
					const menuResult = await showNervousConfigMenu(store, config, ctx);
					if (menuResult.kind === "updated") {
						post(ctx, pi, summarizeConfig(menuResult.config, true), { config: menuResult.config });
					} else if (menuResult.kind === "fallback") {
						post(ctx, pi, summarizeConfig(config, false), { config });
					}
					return;
				}

				post(ctx, pi, summarizeConfig(config, false), { config });
			} catch (e) {
				const msg = e instanceof CortexError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`nervous:config failed: ${msg}`, "error");
			}
		},
		getArgumentCompletions(prefix: string) {
			const normalized = prefix.toLowerCase();
			const filtered = CONFIG_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(normalized));
			return filtered.length ? filtered : null;
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

const DRAIN_MODE_VALUES = ["off", "on_explicit_nervous", "always"] as const;
const RISK_GATE_MODE_VALUES = ["strict", "auto_deliberate", "user_accepted", "disabled"] as const;
const DRAIN_POLICY_VALUES = ["default", "conservative", "aggressive"] as const;

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

const CONFIG_COMPLETIONS: Array<{ value: string; label: string }> = [
	...DRAIN_MODE_VALUES.map((value) => ({ value: `drain=${value}`, label: `drain=${value} — ${DRAIN_MODE_DESCRIPTIONS[value]}` })),
	...RISK_GATE_MODE_VALUES.map((value) => ({ value: `risk=${value}`, label: `risk=${value} — ${RISK_GATE_MODE_DESCRIPTIONS[value]}` })),
	...DRAIN_POLICY_VALUES.map((value) => ({ value: `policy=${value}`, label: `policy=${value} — ${DRAIN_POLICY_DESCRIPTIONS[value]}` })),
	{ value: "dangerous_opt_in=true", label: "dangerous_opt_in=true — required with risk=disabled" },
	{ value: 'evidence="..."', label: 'evidence="..." — audit note; required with risk=disabled' },
];

type ConfigMenuResult =
	| { kind: "updated"; config: CortexConfig }
	| { kind: "cancelled" }
	| { kind: "fallback" };

interface ConfigDraft {
	drain_mode: DrainMode;
	risk_gate_mode: RiskGateMode;
	default_drain_policy: DrainPolicyName;
}

function shouldOpenConfigMenu(args: string, ctx: ExtensionContext): boolean {
	return args.trim().length === 0 && ctx.mode === "tui" && typeof ctx.ui.custom === "function";
}

async function showNervousConfigMenu(
	store: CortexStore,
	config: CortexConfig,
	ctx: ExtensionContext,
): Promise<ConfigMenuResult> {
	const draft: ConfigDraft = {
		drain_mode: config.drain_mode,
		risk_gate_mode: config.risk_gate_mode,
		default_drain_policy: config.default_drain_policy,
	};

	let selection: ConfigDraft | undefined;
	try {
		selection = await ctx.ui.custom<ConfigDraft | undefined>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("NERVous CORTEX Config")), 1, 1));
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"Edit defaults used by /nervous. Changes are staged until Save; Esc or Cancel discards them.",
					),
					1,
					0,
				),
			);

			const settingsList = new SettingsList(
				configMenuItems(draft, config),
				8,
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "drain_mode" && (DRAIN_MODE_VALUES as readonly string[]).includes(newValue)) {
						draft.drain_mode = newValue as DrainMode;
					} else if (id === "risk_gate_mode" && (RISK_GATE_MODE_VALUES as readonly string[]).includes(newValue)) {
						draft.risk_gate_mode = newValue as RiskGateMode;
					} else if (id === "default_drain_policy" && (DRAIN_POLICY_VALUES as readonly string[]).includes(newValue)) {
						draft.default_drain_policy = newValue as DrainPolicyName;
					} else if (id === "save") {
						done({ ...draft });
					} else if (id === "cancel") {
						done(undefined);
					}
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);
			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	} catch {
		ctx.ui.notify("NERVous config menu unavailable; showing text config instead.", "warning");
		return { kind: "fallback" };
	}

	if (!selection) return { kind: "cancelled" };

	const patch = configPatch(config, selection);
	if (!hasConfigChanges(patch)) {
		ctx.ui.notify("NERVous config unchanged.", "info");
		return { kind: "cancelled" };
	}

	if (patch.risk_gate_mode === "disabled") {
		const confirmed = await ctx.ui.confirm(
			"Enable disabled risk gate?",
			"This is a dangerous opt-in. It requires explicit user approval and a non-empty audit evidence note.",
		);
		if (!confirmed) {
			ctx.ui.notify("NERVous config unchanged; disabled risk gate was not confirmed.", "warning");
			return { kind: "cancelled" };
		}
		const evidence = await ctx.ui.input("risk_gate_evidence", config.risk_gate_evidence ?? "explicit user-approved automation window");
		if (!evidence?.trim()) {
			ctx.ui.notify("NERVous config unchanged; risk_gate_mode=disabled requires evidence.", "error");
			return { kind: "cancelled" };
		}
		patch.dangerous_opt_in = true;
		patch.risk_gate_evidence = evidence.trim();
	}

	const { result } = await store.mutate((s) => s.setConfig(patch));
	return { kind: "updated", config: result };
}

function configMenuItems(draft: ConfigDraft, config: CortexConfig): SettingItem[] {
	return [
		{
			id: "drain_mode",
			label: "Drain mode",
			description: `When CORTEX drain should resume incomplete goals. ${formatInlineDescriptions(DRAIN_MODE_VALUES, DRAIN_MODE_DESCRIPTIONS)}`,
			currentValue: draft.drain_mode,
			values: [...DRAIN_MODE_VALUES],
		},
		{
			id: "risk_gate_mode",
			label: "Risk gate",
			description: `How risky work is authorized. Default is auto_deliberate; hard-stop work still needs recorded MAGI/AMYGDALA evidence. ${formatInlineDescriptions(RISK_GATE_MODE_VALUES, RISK_GATE_MODE_DESCRIPTIONS)}`,
			currentValue: draft.risk_gate_mode,
			values: [...RISK_GATE_MODE_VALUES],
		},
		{
			id: "default_drain_policy",
			label: "Drain policy",
			description: `Drain budget/retry posture. ${formatInlineDescriptions(DRAIN_POLICY_VALUES, DRAIN_POLICY_DESCRIPTIONS)}`,
			currentValue: draft.default_drain_policy,
			values: [...DRAIN_POLICY_VALUES],
		},
		{
			id: "risk_gate_evidence",
			label: "Disabled-mode evidence",
			description: "Audit note required only when saving risk_gate_mode=disabled. The menu prompts for it when needed; token form: evidence=\"...\".",
			currentValue: config.risk_gate_evidence ?? "(none)",
		},
		{
			id: "save",
			label: "Save and close",
			description: "Persist the staged CORTEX config defaults.",
			currentValue: "enter",
			values: ["save"],
		},
		{
			id: "cancel",
			label: "Cancel",
			description: "Discard staged changes and close the menu.",
			currentValue: "enter",
			values: ["cancel"],
		},
	];
}

function configPatch(config: CortexConfig, draft: ConfigDraft): ConfigInput {
	const patch: ConfigInput = {};
	if (draft.drain_mode !== config.drain_mode) patch.drain_mode = draft.drain_mode;
	if (draft.risk_gate_mode !== config.risk_gate_mode) patch.risk_gate_mode = draft.risk_gate_mode;
	if (draft.default_drain_policy !== config.default_drain_policy) patch.default_drain_policy = draft.default_drain_policy;
	return patch;
}

function hasConfigChanges(patch: ConfigInput): boolean {
	return Boolean(patch.drain_mode || patch.risk_gate_mode || patch.default_drain_policy);
}

function splitCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(input)) !== null) {
		const raw = m[1] ?? m[2] ?? m[3] ?? "";
		tokens.push(raw.replace(/\\(["'\\])/g, "$1"));
	}
	return tokens;
}

function parseNervousConfigArgs(args: string): { patch: ConfigInput; hasChanges: boolean; errors: string[] } {
	const patch: ConfigInput = {};
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
			if (token.includes("=")) {
				const value = token.slice(token.indexOf("=") + 1).toLowerCase();
				patch.dangerous_opt_in = !["false", "0", "no"].includes(value);
			} else {
				patch.dangerous_opt_in = true;
			}
			continue;
		}
		errors.push(`unknown option "${rawKey}"`);
	}
	return { patch, hasChanges: Boolean(patch.drain_mode || patch.default_drain_policy || patch.risk_gate_mode), errors };
}

export function summarizeConfig(config: CortexConfig, changed: boolean): string {
	const lines = [
		`# NERVous CORTEX config${changed ? " updated" : ""}`,
		"",
		"## Current defaults",
		`- **drain_mode:** ${config.drain_mode}`,
		`- **risk_gate_mode:** ${config.risk_gate_mode}`,
		`- **default_drain_policy:** ${config.default_drain_policy}`,
	];
	if (config.risk_gate_evidence) lines.push(`- **risk_gate_evidence:** ${config.risk_gate_evidence}`);
	lines.push(
		"",
		"## Options",
		`- \`drain\` / \`drain_mode\` (${formatValues(DRAIN_MODE_VALUES)}): when CORTEX drain should resume incomplete goals.`,
		...formatDescriptions(DRAIN_MODE_VALUES, DRAIN_MODE_DESCRIPTIONS),
		`- \`risk\` / \`risk_gate\` / \`risk_gate_mode\` (${formatValues(RISK_GATE_MODE_VALUES)}): how risky work is authorized.`,
		...formatDescriptions(RISK_GATE_MODE_VALUES, RISK_GATE_MODE_DESCRIPTIONS),
		`- \`policy\` / \`default_drain_policy\` (${formatValues(DRAIN_POLICY_VALUES)}): drain budget/retry posture.`,
		...formatDescriptions(DRAIN_POLICY_VALUES, DRAIN_POLICY_DESCRIPTIONS),
		'- `evidence` / `risk_gate_evidence`: audit note; required when setting `risk=disabled`.',
		'- `dangerous_opt_in=true`: explicit confirmation required when setting `risk=disabled`.',
		"",
		"## Examples",
		"- `/nervous:config drain=always risk=auto_deliberate policy=default`",
		'- `/nervous:config risk=disabled dangerous_opt_in=true evidence="explicit user-approved automation window"`',
	);
	return lines.join("\n");
}

function formatValues(values: readonly string[]): string {
	return values.map((value) => `\`${value}\``).join(" | ");
}

function formatDescriptions<T extends string>(values: readonly T[], descriptions: Record<T, string>): string[] {
	return values.map((value) => `  - \`${value}\`: ${descriptions[value]}`);
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
