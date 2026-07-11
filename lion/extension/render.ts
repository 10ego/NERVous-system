/** LION rendering helpers. */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { LionRun, LionRunStatus, LionSummary } from "./schema.ts";

type AnyTheme = { fg(color: string, text: string): string; bold(text: string): string };

const ICON: Record<LionRunStatus, string> = {
	queued: "○",
	running: "▶",
	completed: "✓",
	blocked: "■",
	failed: "✗",
	aborted: "⊘",
};
const COLOR: Record<LionRunStatus, string> = {
	queued: "muted",
	running: "accent",
	completed: "success",
	blocked: "warning",
	failed: "error",
	aborted: "muted",
};

export function summarizeRun(r: LionRun): string {
	const lines = [`# ${r.id} — ${r.agent_id}`, ""];
	lines.push(`**status:** ${r.status}${r.task_id ? ` · **AXON:** \`${r.task_id}\`` : ""}${r.model ? ` · **model:** ${r.model}` : ""}${r.runner_mode ? ` · **runner:** ${r.runner_mode}` : ""}`);
	if (r.progress) lines.push(`**progress:** ${formatProgress(r)}`);
	if (r.control?.pid || r.control?.cancel_requested_at) lines.push(`**control:** ${formatControl(r)}`);
	if (r.steering_messages?.length) lines.push(`**steering:** ${formatSteering(r)}`);
	lines.push("");
	lines.push(`## Objective\n${r.objective || "_(none)_"}`);
	if (r.context) lines.push("", `## Context\n${r.context}`);
	if (r.report) {
		lines.push("", `## Worker report — ${r.report.outcome}`);
		lines.push(r.report.summary || "_(no summary)_");
		if (r.report.changed_files.length) lines.push("", "**Changed files:**", ...r.report.changed_files.map((f) => `- \`${f}\``));
		if (r.report.tests_run.length) lines.push("", "**Tests/checks:**", ...r.report.tests_run.map((t) => `- ${t}`));
		if (r.report.blockers.length) lines.push("", "**Blockers:**", ...r.report.blockers.map((b) => `- ${b}`));
		if (r.report.next_steps.length) lines.push("", "**Next steps:**", ...r.report.next_steps.map((s) => `- ${s}`));
		if (r.report.notes) lines.push("", `**Notes:** ${r.report.notes}`);
	}
	if (r.error) lines.push("", `**Error:** ${r.error}`);
	if (r.output && !r.report) lines.push("", "## Raw output", r.output.slice(0, 4000));
	return lines.join("\n");
}

export function summarizeList(runs: LionRun[]): string {
	if (!runs.length) return "_(no LION runs)_";
	return [
		"# LION runs",
		"",
		...runs.map((r) => `${ICON[r.status]} \`${r.id}\` **${r.agent_id}** _${r.status}_ ${r.task_id ? `→ \`${r.task_id}\`` : ""} — ${runListSuffix(r)}`),
	].join("\n");
}

export function summarizeSummary(s: LionSummary): string {
	const counts = Object.entries(s.by_status).map(([k, v]) => `${k}:${v}`).join(" · ") || "none";
	return [`# LION summary`, "", `**${s.total}** run(s) · ${counts}`, "", ...s.recent.map((r) => `${ICON[r.status]} \`${r.id}\` ${r.agent_id} — ${runListSuffix(r)}`)].join("\n");
}

export function renderLionCall(args: { action: string; id?: string; task_id?: string; objective?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("lion ")) + theme.fg("accent", args.action);
	if (args.id) text += " " + theme.fg("accent", args.id);
	if (args.task_id) text += " " + theme.fg("accent", args.task_id);
	if (args.objective) text += " " + theme.fg("dim", truncate(args.objective, 50));
	return new Text(text, 0, 0);
}

export function renderLionResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	_options: { expanded: boolean },
	theme: AnyTheme,
): Container | Text {
	const details = result.details as { run?: LionRun; runs?: LionRun[]; summary?: LionSummary; error?: string } | undefined;
	if (result.isError || details?.error) {
		return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", result.content[0]?.text ?? "error")}`, 0, 0);
	}
	const c = new Container();
	if (details?.run) c.addChild(new Markdown(summarizeRun(details.run), 0, 0, getMarkdownTheme()));
	else if (details?.runs) c.addChild(new Markdown(summarizeList(details.runs), 0, 0, getMarkdownTheme()));
	else if (details?.summary) c.addChild(new Markdown(summarizeSummary(details.summary), 0, 0, getMarkdownTheme()));
	else c.addChild(new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", result.content[0]?.text ?? "ok")}`, 0, 0));
	return c;
}

function runListSuffix(r: LionRun): string {
	const progress = r.control?.cancel_requested_at ? `cancelling: ${r.control.cancel_reason ?? "requested"}` : r.progress?.activity;
	return progress && (r.status === "running" || r.status === "queued") ? `${truncate(r.objective, 48)} · ${truncate(progress, 48)}` : truncate(r.objective, 80);
}

function formatProgress(r: LionRun): string {
	const p = r.progress;
	if (!p) return "—";
	const bits = [p.activity];
	if (p.active_tools.length) bits.push(`tools:${p.active_tools.join(",")}`);
	if (p.tool_uses > 0) bits.push(`${p.tool_uses} tool use${p.tool_uses === 1 ? "" : "s"}`);
	if (p.turn_count > 0) bits.push(`turns:${p.turn_count}`);
	if (typeof p.token_total === "number" && p.token_total > 0) bits.push(`tokens:${p.token_total}`);
	return bits.join(" · ");
}

function formatControl(r: LionRun): string {
	const c = r.control;
	if (!c) return "—";
	const bits: string[] = [];
	if (c.pid) bits.push(`pid:${c.pid}`);
	if (c.pgid) bits.push(`pgid:${c.pgid}`);
	if (c.cancel_requested_at) bits.push(`cancel requested${c.cancel_reason ? ` (${c.cancel_reason})` : ""}`);
	if (c.cancel_delivery_status) bits.push(`cancel:${c.cancel_delivery_status}`);
	if (c.reconciled_at) bits.push(`reconciled:${c.reconciled_at}`);
	return bits.join(" · ") || "—";
}

function formatSteering(r: LionRun): string {
	return (r.steering_messages ?? []).map((m) => `${m.id}:${m.status}${m.reason ? ` (${truncate(m.reason, 40)})` : ""}`).join(" · ");
}

function truncate(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
