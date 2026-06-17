/**
 * CORTEX — TUI rendering + markdown summaries.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Goal, GoalStatus, IntentAnalysis, VerificationReport } from "./schema.ts";

type AnyTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const STATUS_ICON: Record<GoalStatus, string> = {
	analyzed: "◇",
	planned: "▹",
	executing: "▶",
	verified: "✓",
	needs_replan: "↻",
	completed: "✓",
	cancelled: "⊘",
};

const STATUS_COLOR: Record<GoalStatus, string> = {
	analyzed: "accent",
	planned: "accent",
	executing: "warning",
	verified: "success",
	needs_replan: "warning",
	completed: "success",
	cancelled: "muted",
};

const COMPLEXITY_COLOR: Record<string, string> = { low: "success", medium: "accent", high: "warning" };
const SEVERITY_COLOR: Record<string, string> = { low: "muted", medium: "accent", high: "error" };

/* ----------------------------- markdown summaries ----------------------- */

export function summarizeGoal(g: Goal): string {
	const lines: string[] = [];
	lines.push(`# ${g.id} — ${g.intent.goal || "(unnamed goal)"}`);
	lines.push("");
	lines.push(`**status:** ${g.status} · **complexity:** ${g.intent.complexity} · **needs MAGI:** ${g.intent.needs_magi ? "yes" : "no"}`);
	lines.push("");
	lines.push(`> _prompt:_ ${truncate(g.prompt, 160)}`);
	if (g.intent.intent_summary) {
		lines.push("");
		lines.push("## Intent");
		lines.push(g.intent.intent_summary);
	}
	if (g.intent.success_criteria.length) {
		lines.push("");
		lines.push("## Success criteria");
		for (const c of g.intent.success_criteria) lines.push(`- [ ] ${c}`);
	}
	if (g.intent.constraints.length) {
		lines.push("");
		lines.push("## Constraints");
		for (const c of g.intent.constraints) lines.push(`- ${c}`);
	}
	if (g.intent.risks.length) {
		lines.push("");
		lines.push("## Risks");
		for (const r of g.intent.risks) lines.push(`- **${r.severity}** — ${r.description}`);
	}
	if (g.plan) {
		lines.push("");
		lines.push(`## Execution plan${g.plan.magi_used ? " (MAGI-refined)" : ""}`);
		for (const s of g.plan.subtasks) {
			const axon = s.axon_task_id ? ` → \`${s.axon_task_id}\`` : "";
			lines.push(`- \`${s.id}\` **${s.title}** _(${s.priority})_${axon}`);
		}
	}
	if (g.axon_task_ids.length) {
		lines.push("");
		lines.push(`**AXON tasks:** ${g.axon_task_ids.map((id) => `\`${id}\``).join(", ")}`);
	}
	if (g.verification) {
		lines.push("");
		lines.push(verificationSection(g.verification));
	}
	return lines.join("\n");
}

export function verificationSection(v: VerificationReport): string {
	const lines = [`## Verification — ${v.recommendation}${v.ready_for_magi_review ? " (ready for MAGI review)" : ""}`];
	for (const c of v.checks) lines.push(`- [${c.passed ? "x" : " "}] ${c.criterion}${c.evidence ? ` — _${c.evidence}_` : ""}`);
	if (v.concerns.length) {
		lines.push("");
		lines.push("**Concerns:**");
		for (const c of v.concerns) lines.push(`- ${c}`);
	}
	return lines.join("\n");
}

export function summarizeGoalList(goals: Goal[]): string {
	if (goals.length === 0) return "_(no goals)_";
	const lines = ["# CORTEX goals", ""];
	for (const g of goals) {
		lines.push(
			`${STATUS_ICON[g.status]} \`${g.id}\` — **${g.intent.goal || truncate(g.prompt, 50)}** _(${g.status})_`,
		);
	}
	return lines.join("\n");
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/* ----------------------------- TUI rendering ---------------------------- */

export function renderCortexCall(args: { action: string; goal_id?: string; prompt?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("cortex ")) + theme.fg("accent", args.action);
	if (args.goal_id) text += " " + theme.fg("accent", args.goal_id);
	const preview = args.prompt ?? "";
	if (preview) text += " " + theme.fg("dim", truncate(preview, 50));
	return new Text(text, 0, 0);
}

interface CortexResultDetails {
	action: string;
	goal?: Goal;
	goals?: Goal[];
	error?: string;
}

export function renderCortexResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: { expanded: boolean },
	theme: AnyTheme,
): Container | Text {
	const details = result.details as CortexResultDetails | undefined;

	if (result.isError || !details || details.error) {
		const text = result.content[0]?.text ?? "(no output)";
		return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", text)}`, 0, 0);
	}

	if (details.goal) {
		return renderGoalCard(details.goal, options.expanded, theme);
	}
	if (details.goals) {
		const c = new Container();
		c.addChild(new Markdown(summarizeGoalList(details.goals), 0, 0, getMarkdownTheme()));
		return c;
	}
	const text = result.content[0]?.text ?? "ok";
	return new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", text)}`, 0, 0);
}

function renderGoalCard(g: Goal, expanded: boolean, theme: AnyTheme): Container | Text {
	const icon = theme.fg(STATUS_COLOR[g.status], STATUS_ICON[g.status]);
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(g.id))} ${theme.fg("muted", "—")} ${g.intent.goal || g.prompt}`;
	const meta =
		`${theme.fg("muted", g.status)} · ` +
		theme.fg(COMPLEXITY_COLOR[g.intent.complexity] ?? "muted", g.intent.complexity) +
		(g.intent.needs_magi ? ` · ${theme.fg("warning", "needs MAGI")}` : "");

	if (!expanded) {
		let text = `${header}\n${meta}`;
		const topRisk = g.intent.risks.find((r) => r.severity === "high");
		if (topRisk) text += `\n${theme.fg("error", "⚠ " + truncate(topRisk.description, 60))}`;
		if (g.plan) text += `\n${theme.fg("dim", `plan: ${g.plan.subtasks.length} subtask(s)`)}`;
		if (g.verification) text += `\n${theme.fg(STATUS_COLOR[g.status], `verify: ${g.verification.recommendation}`)}`;
		return new Text(text, 0, 0);
	}

	const c = new Container();
	c.addChild(new Text(header, 0, 0));
	c.addChild(new Text(meta, 0, 0));
	c.addChild(new Spacer(1));
	c.addChild(new Markdown(summarizeGoal(g), 0, 0, getMarkdownTheme()));
	return c;
}

/** Compact one-liner for the intent, used by the analyze confirmation. */
export function intentOneLiner(i: IntentAnalysis): string {
	return `${i.complexity} complexity · ${i.risks.length} risk(s) · needs MAGI: ${i.needs_magi ? "yes" : "no"}`;
}
