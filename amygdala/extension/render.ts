/** AMYGDALA rendering helpers. */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { AmygdalaSummary, Incident, IncidentStatus, Severity } from "./schema.ts";

type AnyTheme = { fg(color: string, text: string): string; bold(text: string): string };
const S_ICON: Record<Severity, string> = { low: "○", medium: "◇", high: "⚠", critical: "‼" };
const S_COLOR: Record<Severity, string> = { low: "muted", medium: "accent", high: "warning", critical: "error" };
const ST_ICON: Record<IncidentStatus, string> = { open: "◇", acknowledged: "◐", mitigating: "▶", resolved: "✓", accepted: "✓", escalated: "↑", cancelled: "⊘" };

export function summarizeIncident(i: Incident): string {
	const lines = [`# ${i.id} — ${i.title}`, ""];
	lines.push(`**status:** ${i.status} · **severity:** ${i.severity} · **category:** ${i.category} · **recommendation:** ${i.recommendation}`);
	lines.push(`**source:** ${i.source}${i.source_id ? ` → \`${i.source_id}\`` : ""}`);
	lines.push("", "## Description", i.description);
	lines.push("", "## Reason", i.reason || "_(none)_");
	if (i.mitigation_plan.length) lines.push("", "## Mitigation", ...i.mitigation_plan.map((m) => `- ${m}`));
	if (i.related_ids.length) lines.push("", `**Related:** ${i.related_ids.map((x) => `\`${x}\``).join(", ")}`);
	if (i.notes.length) lines.push("", "## Notes", ...i.notes.map((n) => `- ${n.ts}${n.author ? ` ${n.author}` : ""}: ${n.text}`));
	return lines.join("\n");
}
export function summarizeList(xs: Incident[]): string { if (!xs.length) return "_(no AMYGDALA incidents)_"; return ["# AMYGDALA incidents", "", ...xs.map((i) => `${S_ICON[i.severity]} ${ST_ICON[i.status]} \`${i.id}\` **${i.title}** _${i.status}/${i.severity}_ → ${i.recommendation}`)].join("\n"); }
export function summarizeSummary(s: AmygdalaSummary): string {
	const statuses = Object.entries(s.by_status).map(([k, v]) => `${k}:${v}`).join(" · ") || "none";
	const severities = Object.entries(s.by_severity).map(([k, v]) => `${k}:${v}`).join(" · ") || "none";
	return [`# AMYGDALA summary`, "", `**${s.total}** incident(s)`, `status: ${statuses}`, `severity: ${severities}`, "", ...(s.needs_attention.length ? ["## Needs attention", ...s.needs_attention.map((i) => `- \`${i.id}\` **${i.title}** _${i.severity}_ → ${i.recommendation}`)] : ["_(no incidents need attention)_"]), "", "## Recent", ...s.recent.map((i) => `${S_ICON[i.severity]} \`${i.id}\` ${i.title}`)].join("\n");
}
export function renderAmygdalaCall(args: { action: string; id?: string; title?: string }, theme: AnyTheme): Text { let text = theme.fg("toolTitle", theme.bold("amygdala ")) + theme.fg("accent", args.action); if (args.id) text += " " + theme.fg("accent", args.id); if (args.title) text += " " + theme.fg("dim", args.title); return new Text(text, 0, 0); }
export function renderAmygdalaResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }, _options: { expanded: boolean }, theme: AnyTheme): Container | Text {
	const d = result.details as { incident?: Incident; incidents?: Incident[]; summary?: AmygdalaSummary; error?: string } | undefined;
	if (result.isError || d?.error) return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", result.content[0]?.text ?? "error")}`, 0, 0);
	const c = new Container();
	if (d?.incident) c.addChild(new Markdown(summarizeIncident(d.incident), 0, 0, getMarkdownTheme()));
	else if (d?.incidents) c.addChild(new Markdown(summarizeList(d.incidents), 0, 0, getMarkdownTheme()));
	else if (d?.summary) c.addChild(new Markdown(summarizeSummary(d.summary), 0, 0, getMarkdownTheme()));
	else c.addChild(new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", result.content[0]?.text ?? "ok")}`, 0, 0));
	return c;
}
