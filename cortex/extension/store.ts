/**
 * CORTEX — the goal store core (pure, no I/O).
 *
 * {@link GoalStore} holds goals in memory and implements the CORTEX lifecycle:
 * analyze (intent → goal) → plan → link (AXON tasks) → verify → complete, with
 * status-transition validation. It is deliberately free of filesystem concerns
 * so it is fully unit-testable. {@link import("./backend.ts").FileBackend} and
 * {@link import("./backend.ts").CortexStore} handle durability.
 */

import {
	type CortexFile,
	CortexError,
	type ExecutionPlan,
	type Goal,
	type GoalStatus,
	type IntentAnalysis,
	type PlannedSubtask,
	type VerificationReport,
	VERIFY_RECOMMENDATIONS,
	type VerifyRecommendation,
} from "./schema.ts";

const now = (): string => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* ----------------------------- lifecycle transitions ------------------- */

/**
 * Allowed goal status transitions. CORTEX flow:
 *   analyzed → planned → executing → verified → completed
 * with branches: analyzed→planned (MAGI optional), verified→needs_replan→planned,
 * and cancel from any non-terminal status.
 */
const TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
	analyzed: ["planned", "cancelled"],
	planned: ["executing", "analyzed", "cancelled"],
	executing: ["verified", "needs_replan", "analyzed", "cancelled"],
	verified: ["completed", "needs_replan", "cancelled"],
	needs_replan: ["planned", "cancelled"],
	completed: [],
	cancelled: [],
};

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
	if (from === to) return true;
	const allowed = TRANSITIONS[from];
	return allowed ? allowed.includes(to) : false;
}

/* ----------------------------- inputs ---------------------------------- */

export interface AnalyzeInput {
	prompt: string;
	intent_summary?: string;
	goal?: string;
	success_criteria?: string[];
	constraints?: string[];
	risks?: Array<{ description: string; severity?: string }>;
	expected_output?: string;
	complexity?: string;
	needs_magi?: boolean;
	magi_rationale?: string;
}

export interface PlanSubtaskInput {
	title: string;
	description?: string;
	dependencies?: string[];
	priority?: string;
	assigned_to?: string | null;
}

export interface PlanInput {
	subtasks: PlanSubtaskInput[];
	magi_used?: boolean;
	magi_output_ref?: string;
}

export interface LinkInput {
	plan_id?: string;
	axon_task_id: string;
}

export interface VerifyInput {
	checks: Array<{ criterion: string; passed: boolean; evidence?: string }>;
	all_axon_complete?: boolean;
	recommendation?: VerifyRecommendation;
	concerns?: string[];
}

const COMPLEXITIES = ["low", "medium", "high"] as const;
type Complexity = (typeof COMPLEXITIES)[number];
function asComplexity(v: unknown): Complexity {
	return (COMPLEXITIES as readonly string[]).includes(v as string) ? (v as Complexity) : "medium";
}
const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];
function asSeverity(v: unknown): Severity {
	return (SEVERITIES as readonly string[]).includes(v as string) ? (v as Severity) : "medium";
}
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
type Priority = (typeof PRIORITIES)[number];
function asPriority(v: unknown): Priority {
	return (PRIORITIES as readonly string[]).includes(v as string) ? (v as Priority) : "medium";
}

/* ----------------------------- store ----------------------------------- */

export class GoalStore {
	goals = new Map<string, Goal>();
	current_goal_id?: string;
	meta: { version: number; project?: string; created_at?: string; updated_at: string };

	constructor(project?: string) {
		const ts = now();
		this.meta = { version: 1, project, created_at: ts, updated_at: ts };
	}

	/* ----------------------------- (de)serialization ---------------------- */

	static fromJSON(data: unknown): GoalStore {
		const store = new GoalStore();
		if (typeof data !== "object" || data === null) return store;
		const d = data as Record<string, unknown>;
		if (typeof d.meta === "object" && d.meta !== null) {
			store.meta = { ...store.meta, ...(d.meta as object) } as GoalStore["meta"];
		}
		if (typeof d.current_goal_id === "string") store.current_goal_id = d.current_goal_id;
		const goals = (d.goals ?? {}) as Record<string, unknown>;
		for (const [id, raw] of Object.entries(goals)) {
			const g = GoalStore.coerceGoal(id, raw);
			if (g) store.goals.set(id, g);
		}
		if (store.current_goal_id && !store.goals.has(store.current_goal_id)) store.current_goal_id = undefined;
		return store;
	}

	toJSON(): CortexFile {
		const goals: Record<string, Goal> = {};
		for (const [id, g] of this.goals) goals[id] = g;
		return {
			version: this.meta.version,
			project: this.meta.project,
			created_at: this.meta.created_at,
			updated_at: this.meta.updated_at,
			current_goal_id: this.current_goal_id,
			goals,
		};
	}

	private static coerceGoal(id: string, raw: unknown): Goal | null {
		if (typeof raw !== "object" || raw === null) return null;
		const r = raw as Record<string, unknown>;
		if (typeof r.prompt !== "string" || typeof r.intent !== "object") return null;
		const ts = now();
		const str = (v: unknown, f = ""): string => (typeof v === "string" ? v : f);
		const strArr = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
		const status = (
			["analyzed", "planned", "executing", "verified", "needs_replan", "completed", "cancelled"] as const
		).includes(r.status as never)
			? (r.status as GoalStatus)
			: "analyzed";
		const intent = (r.intent ?? {}) as Record<string, unknown>;
		const risks = Array.isArray(intent.risks)
			? intent.risks
					.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
					.map((x) => ({ description: str(x.description), severity: asSeverity(x.severity) }))
			: [];
		return {
			id,
			prompt: str(r.prompt),
			status,
			intent: {
				intent_summary: str(intent.intent_summary),
				goal: str(intent.goal, str(r.prompt)),
				success_criteria: strArr(intent.success_criteria),
				constraints: strArr(intent.constraints),
				risks,
				expected_output: str(intent.expected_output),
				complexity: asComplexity(intent.complexity),
				needs_magi: typeof intent.needs_magi === "boolean" ? intent.needs_magi : false,
				magi_rationale: typeof intent.magi_rationale === "string" ? intent.magi_rationale : undefined,
			} as IntentAnalysis,
			plan: typeof r.plan === "object" && r.plan !== null ? (r.plan as ExecutionPlan) : undefined,
			axon_task_ids: strArr(r.axon_task_ids),
			verification:
				typeof r.verification === "object" && r.verification !== null
					? (r.verification as VerificationReport)
					: undefined,
			created_at: str(r.created_at, ts),
			updated_at: str(r.updated_at, ts),
		};
	}

	/* ----------------------------- queries -------------------------------- */

	get(id: string): Goal | undefined {
		const g = this.goals.get(id);
		return g ? clone(g) : undefined;
	}

	has(id: string): boolean {
		return this.goals.has(id);
	}

	/** The current goal, else the most recently created non-terminal goal. */
	current(): Goal | undefined {
		if (this.current_goal_id && this.goals.has(this.current_goal_id)) {
			return clone(this.goals.get(this.current_goal_id));
		}
		const active = this.all().filter((g) => g.status !== "completed" && g.status !== "cancelled");
		if (active.length === 0) return undefined;
		active.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
		return active[0];
	}

	all(): Goal[] {
		return Array.from(this.goals.values()).map(clone);
	}

	list(filter?: { status?: GoalStatus }): Goal[] {
		let result = this.all();
		if (filter?.status) result = result.filter((g) => g.status === filter.status);
		return result;
	}

	nextId(): string {
		let max = 0;
		for (const id of this.goals.keys()) {
			const m = id.match(/^goal-(\d+)$/);
			if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
		}
		const next = max + 1;
		const width = Math.max(3, String(next).length);
		return `goal-${String(next).padStart(width, "0")}`;
	}

	/* ----------------------------- mutations ------------------------------ */

	analyze(input: AnalyzeInput): Goal {
		if (!input.prompt || !input.prompt.trim()) {
			throw new CortexError("invalid_arg", "A prompt is required to analyze intent.");
		}
		const id = this.nextId();
		const ts = now();
		const intent: IntentAnalysis = {
			intent_summary: (input.intent_summary ?? input.prompt).trim(),
			goal: (input.goal ?? input.prompt).trim(),
			success_criteria: input.success_criteria ?? [],
			constraints: input.constraints ?? [],
			risks: (input.risks ?? []).map((r) => ({ description: r.description, severity: asSeverity(r.severity) })),
			expected_output: input.expected_output ?? "",
			complexity: asComplexity(input.complexity),
			needs_magi: input.needs_magi ?? this.heuristicNeedsMagi(input),
			magi_rationale: input.magi_rationale,
		};
		const goal: Goal = {
			id,
			prompt: input.prompt.trim(),
			status: "analyzed",
			intent,
			axon_task_ids: [],
			created_at: ts,
			updated_at: ts,
		};
		this.goals.set(id, goal);
		this.current_goal_id = id;
		this.meta.updated_at = now();
		return clone(goal);
	}

	plan(goalId: string, input: PlanInput): Goal {
		const g = this.require(goalId);
		if (g.status !== "analyzed" && g.status !== "needs_replan") {
			throw new CortexError("invalid_transition", `Cannot plan goal ${goalId} from status "${g.status}".`);
		}
		if (!input.subtasks.length) {
			throw new CortexError("invalid_arg", "A plan requires at least one subtask.");
		}
		const plan: ExecutionPlan = {
			subtasks: this.materializePlan(input.subtasks),
			magi_used: input.magi_used ?? false,
			magi_output_ref: input.magi_output_ref,
			created_at: now(),
		};
		g.plan = plan;
		this.transition(g, "planned");
		g.updated_at = now();
		this.meta.updated_at = g.updated_at;
		return clone(g);
	}

	/** Record AXON task ids created for the plan; moves the goal to executing. */
	link(goalId: string, links: LinkInput[]): Goal {
		const g = this.require(goalId);
		if (!g.plan) throw new CortexError("invalid_arg", `Goal ${goalId} has no plan to link tasks to.`);
		if (g.status !== "planned" && g.status !== "executing") {
			throw new CortexError("invalid_transition", `Cannot link tasks to goal ${goalId} from "${g.status}".`);
		}
		const byPlanId = new Map(g.plan.subtasks.map((s) => [s.id, s]));
		const byTitle = new Map(g.plan.subtasks.map((s) => [s.title.toLowerCase(), s]));
		for (const l of links) {
			if (!g.axon_task_ids.includes(l.axon_task_id)) g.axon_task_ids.push(l.axon_task_id);
			if (l.plan_id) {
				const s = byPlanId.get(l.plan_id);
				if (s) s.axon_task_id = l.axon_task_id;
			} else {
				// auto-match by title if the agent passes the subtask title as plan_id
				const s = byTitle.get(l.axon_task_id.toLowerCase());
				if (s && !s.axon_task_id) s.axon_task_id = l.axon_task_id;
			}
		}
		if (g.status === "planned") this.transition(g, "executing");
		g.updated_at = now();
		this.meta.updated_at = g.updated_at;
		return clone(g);
	}

	verify(goalId: string, input: VerifyInput): Goal {
		const g = this.require(goalId);
		if (g.status !== "executing" && g.status !== "verified" && g.status !== "needs_replan") {
			throw new CortexError("invalid_transition", `Cannot verify goal ${goalId} from "${g.status}".`);
		}
		const recommendation: VerifyRecommendation =
			input.recommendation && (VERIFY_RECOMMENDATIONS as readonly string[]).includes(input.recommendation)
				? input.recommendation
				: input.checks.every((c) => c.passed)
					? "approve"
					: "revise";
		const report: VerificationReport = {
			checks: input.checks.map((c) => ({ criterion: c.criterion, passed: c.passed, evidence: c.evidence ?? "" })),
			all_axon_complete: input.all_axon_complete ?? false,
			recommendation,
			concerns: input.concerns ?? [],
			ready_for_magi_review: recommendation === "approve",
			created_at: now(),
		};
		g.verification = report;
		this.transition(g, recommendation === "approve" ? "verified" : "needs_replan");
		g.updated_at = now();
		this.meta.updated_at = g.updated_at;
		return clone(g);
	}

	complete(goalId: string): Goal {
		const g = this.require(goalId);
		if (g.status !== "verified") {
			throw new CortexError(
				"unverified",
				`Goal ${goalId} must be verified (approved) before completion (status: "${g.status}").`,
			);
		}
		this.transition(g, "completed");
		g.updated_at = now();
		this.meta.updated_at = g.updated_at;
		return clone(g);
	}

	cancel(goalId: string): Goal {
		const g = this.require(goalId);
		if (g.status === "completed" || g.status === "cancelled") {
			throw new CortexError("invalid_transition", `Goal ${goalId} is already terminal ("${g.status}").`);
		}
		this.transition(g, "cancelled");
		g.updated_at = now();
		this.meta.updated_at = g.updated_at;
		return clone(g);
	}

	setCurrent(goalId: string): Goal {
		const g = this.require(goalId);
		this.current_goal_id = goalId;
		this.meta.updated_at = now();
		return clone(g);
	}

	/* ----------------------------- internals ------------------------------ */

	private require(id: string): Goal {
		const g = this.goals.get(id);
		if (!g) throw new CortexError("not_found", `Goal ${id} does not exist.`);
		return g;
	}

	private transition(g: Goal, to: GoalStatus): void {
		if (!canTransition(g.status, to)) {
			throw new CortexError("invalid_transition", `Cannot move goal ${g.id} from "${g.status}" to "${to}".`);
		}
		g.status = to;
	}

	/** Assign plan-ids (plan-001…) to subtasks and normalize dependencies to plan ids. */
	private materializePlan(inputs: PlanSubtaskInput[]): PlannedSubtask[] {
		const titleToId = new Map<string, string>();
		const subtasks: PlannedSubtask[] = [];
		let n = 0;
		for (const inp of inputs) {
			n++;
			const id = `plan-${String(n).padStart(3, "0")}`;
			titleToId.set(inp.title.toLowerCase(), id);
			subtasks.push({
				id,
				title: inp.title,
				description: inp.description ?? "",
				dependencies: [],
				priority: asPriority(inp.priority),
				assigned_to: inp.assigned_to ?? null,
				axon_task_id: null,
			});
		}
		// resolve dependency strings (titles or plan-ids) to plan ids
		for (let i = 0; i < inputs.length; i++) {
			const deps = inputs[i]?.dependencies ?? [];
			subtasks[i]!.dependencies = deps
				.map((d) => {
					const lower = d.toLowerCase();
					if (titleToId.has(lower)) return titleToId.get(lower)!;
					return d; // leave as-is (may be an external/axon id)
				})
				.filter((d, idx, arr) => arr.indexOf(d) === idx);
		}
		return subtasks;
	}

	/** Heuristic: suggest MAGI for high-complexity or multi-risk prompts when not specified. */
	private heuristicNeedsMagi(input: AnalyzeInput): boolean {
		if (input.complexity === "high") return true;
		const risks = input.risks ?? [];
		if (risks.some((r) => r.severity === "high")) return true;
		if (risks.length >= 3) return true;
		return false;
	}
}
