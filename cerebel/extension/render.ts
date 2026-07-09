/** CEREBEL rendering helpers. */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { AssignmentStatus, CerebelSummary, Wave, WaveStatus } from "./schema.ts";
import type { RunWaveResult } from "./run-wave.ts";

type AnyTheme = { fg(color: string, text: string): string; bold(text: string): string };

const WAVE_ICON: Record<WaveStatus, string> = { planned: "◇", dispatched: "▶", collecting: "…", completed: "✓", blocked: "■", needs_replan: "↻", cancelled: "⊘" };
const WAVE_COLOR: Record<WaveStatus, string> = { planned: "accent", dispatched: "accent", collecting: "warning", completed: "success", blocked: "warning", needs_replan: "error", cancelled: "muted" };
const ASSIGN_ICON: Record<AssignmentStatus, string> = { planned: "◇", dispatched: "▶", completed: "✓", partial: "◐", blocked: "■", failed: "✗", cancelled: "⊘" };
export const RUN_WAVE_DASHBOARD_HINT = "Tip: open `/nervous:dashboard` for live LION/CEREBEL details.";

export function summarizeWave(w: Wave): string {
	const lines = [`# ${w.id}`, ""];
	lines.push(`**status:** ${w.status} · **assignments:** ${w.assignments.length} · **max_parallel:** ${w.max_parallel}${w.goal_id ? ` · **goal:** \`${w.goal_id}\`` : ""}`);
	lines.push(`**group:** ${summarizeAssignmentGroup(w)}`);
	if (w.decision) lines.push(`\n**decision:** ${w.decision.decision} — ${w.decision.reason}`);
	lines.push("", "## Assignments");
	for (const a of w.assignments) {
		lines.push(`- ${ASSIGN_ICON[a.status]} \`${a.id}\` **${a.agent_id}** ${a.task_id ? `→ \`${a.task_id}\`` : ""} _${a.status}/${a.priority}_ — ${firstLine(a.objective)}`);
		if (a.lion_run_id) lines.push(`  - LION: \`${a.lion_run_id}\``);
		if (a.ganglion_id || a.ganglion_allocation_id) lines.push(`  - GANGLION: \`${a.ganglion_id ?? "—"}\`${a.ganglion_allocation_id ? `/\`${a.ganglion_allocation_id}\`` : ""}`);
		if (a.outcome_summary) lines.push(`  - ${a.outcome_summary}`);
		if (a.blockers.length) lines.push(...a.blockers.map((b) => `  - blocker: ${b}`));
	}
	return lines.join("\n");
}

export function summarizeList(waves: Wave[]): string {
	if (!waves.length) return "_(no CEREBEL waves)_";
	return ["# CEREBEL waves", "", ...waves.map((w) => `${WAVE_ICON[w.status]} \`${w.id}\` _${w.status}_ · ${summarizeAssignmentGroup(w)}${w.decision ? ` · ${w.decision.decision}` : ""}`)].join("\n");
}

export function summarizeSummary(s: CerebelSummary): string {
	const counts = Object.entries(s.by_status).map(([k, v]) => `${k}:${v}`).join(" · ") || "none";
	return [`# CEREBEL summary`, "", `**${s.total}** wave(s) · current: \`${s.current_wave_id ?? "—"}\` · ${counts}`, "", ...(s.active.length ? ["## Active", ...s.active.map((w) => `- \`${w.id}\` _${w.status}_ · ${w.assignments} assignment(s)`)] : ["_(no active waves)_"]), "", "## Recent", ...s.recent.map((w) => `${WAVE_ICON[w.status]} \`${w.id}\` ${w.status}`)].join("\n");
}

export function renderCerebelCall(args: { action: string; wave_id?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("cerebel ")) + theme.fg("accent", args.action);
	if (args.wave_id) text += " " + theme.fg("accent", args.wave_id);
	return new Text(text, 0, 0);
}

export function renderCerebelResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }, _options: { expanded: boolean }, theme: AnyTheme): Container | Text {
	const d = result.details as { wave?: Wave; waves?: Wave[]; summary?: CerebelSummary; run_wave?: RunWaveResult; error?: string } | undefined;
	if (result.isError || d?.error) return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", result.content[0]?.text ?? "error")}`, 0, 0);
	const c = new Container();
	if (d?.run_wave) c.addChild(new Markdown(summarizeRunWaveResult(d.run_wave), 0, 0, getMarkdownTheme()));
	else if (d?.wave) c.addChild(new Markdown(summarizeWave(d.wave), 0, 0, getMarkdownTheme()));
	else if (d?.waves) c.addChild(new Markdown(summarizeList(d.waves), 0, 0, getMarkdownTheme()));
	else if (d?.summary) c.addChild(new Markdown(summarizeSummary(d.summary), 0, 0, getMarkdownTheme()));
	else c.addChild(new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", result.content[0]?.text ?? "ok")}`, 0, 0));
	return c;
}

export function summarizeAssignmentGroup(w: Wave): string {
	const counts = new Map<AssignmentStatus, number>();
	for (const a of w.assignments) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
	const order: AssignmentStatus[] = ["completed", "partial", "dispatched", "planned", "blocked", "failed", "cancelled"];
	return order
		.filter((status) => counts.has(status))
		.map((status) => `${status}:${counts.get(status)}`)
		.join(" · ") || "no assignments";
}

export function summarizeRunWaveResult(result: RunWaveResult): string {
	const lines = [
		`# CEREBEL run_wave — ${result.wave.id}`,
		"",
		`**summary:** ${result.summary}`,
		`**group:** ${summarizeAssignmentGroup(result.wave)}`,
		`**dashboard:** ${RUN_WAVE_DASHBOARD_HINT}`,
		"",
		"## Results",
	];
	if (!result.assignment_results.length) lines.push("_(no assignments ran)_");
	for (const r of result.assignment_results) {
		lines.push(`- ${r.outcome === "skipped" ? "◇" : ASSIGN_ICON[r.outcome]} \`${r.assignment_id}\`${r.lion_run_id ? ` / \`${r.lion_run_id}\`` : ""} _${r.outcome}_ — ${r.summary}`);
		if (r.blockers.length) lines.push(...r.blockers.map((b) => `  - blocker: ${b}`));
	}
	return lines.join("\n");
}

function firstLine(s: string): string {
	const line = s.split(/\n/)[0]?.trim() ?? "";
	return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}
