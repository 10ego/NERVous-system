/** GANGLION rendering helpers. */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { Ganglion, GanglionStatus, GanglionSummary, MemberStatus } from "./schema.ts";
import type { AllocationReleaseDisposition } from "./store.ts";

type AnyTheme = { fg(color: string, text: string): string; bold(text: string): string };
const G_ICON: Record<GanglionStatus, string> = { forming: "◇", active: "▶", paused: "Ⅱ", draining: "…", completed: "✓", cancelled: "⊘" };
const G_COLOR: Record<GanglionStatus, string> = { forming: "accent", active: "success", paused: "warning", draining: "warning", completed: "success", cancelled: "muted" };
const M_ICON: Record<MemberStatus, string> = { available: "○", busy: "●", offline: "◌", failed: "✗" };

export function formatAllocationReleaseDisposition(disposition: AllocationReleaseDisposition): string {
	switch (disposition) {
		case "released": return "capacity released";
		case "already_free": return "capacity was already free";
		case "member_unavailable": return "member has no active lease but remains unavailable";
		case "retained_by_newer_allocation": return "capacity retained by a newer allocation";
		case "not_terminal": return "no terminal capacity release";
		default: return assertNever(disposition);
	}
}

function assertNever(value: never): never {
	throw new Error(`unknown allocation release disposition: ${String(value)}`);
}

export function summarizeGanglion(g: Ganglion): string {
	const lines = [`# ${g.id} — ${g.name}`, ""];
	lines.push(`**status:** ${g.status} · **members:** ${g.members.length} · **busy:** ${g.members.filter((m) => m.status === "busy").length} · **max_parallel:** ${g.max_parallel}${g.goal_id ? ` · **goal:** \`${g.goal_id}\`` : ""}`);
	lines.push("", "## Members");
	for (const m of g.members) {
		lines.push(`- ${M_ICON[m.status]} \`${m.id}\` **${m.role}** _${m.status}_ — ${m.capabilities.join(", ") || "general"}${m.current_task_id ? ` → \`${m.current_task_id}\`` : ""}`);
	}
	if (g.allocations.length) {
		lines.push("", "## Allocations");
		for (const a of g.allocations) {
			lines.push(`- \`${a.id}\` **${a.member_id}** → \`${a.task_id}\` _${a.status}/${a.priority}_ — ${firstLine(a.objective)}`);
			lines.push(`  - ${a.reason}${a.lion_run_id ? ` · LION \`${a.lion_run_id}\`` : ""}`);
			if (a.outcome_summary) lines.push(`  - ${a.outcome_summary}`);
		}
	}
	return lines.join("\n");
}

export function summarizeList(gs: Ganglion[]): string {
	if (!gs.length) return "_(no GANGLIONs)_";
	return ["# GANGLIONs", "", ...gs.map((g) => `${G_ICON[g.status]} \`${g.id}\` **${g.name}** _${g.status}_ · ${g.members.length} member(s), ${g.allocations.length} allocation(s)`)].join("\n");
}

export function summarizeSummary(s: GanglionSummary): string {
	const counts = Object.entries(s.by_status).map(([k, v]) => `${k}:${v}`).join(" · ") || "none";
	return [`# GANGLION summary`, "", `**${s.total}** group(s) · current: \`${s.current_ganglion_id ?? "—"}\` · ${counts}`, "", ...(s.active.length ? ["## Active", ...s.active.map((g) => `- \`${g.id}\` **${g.name}** _${g.status}_ · ${g.busy}/${g.members} busy`)] : ["_(no active groups)_"]), "", "## Recent", ...s.recent.map((g) => `${G_ICON[g.status]} \`${g.id}\` ${g.name}`)].join("\n");
}

export function renderGanglionCall(args: { action: string; ganglion_id?: string; name?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("ganglion ")) + theme.fg("accent", args.action);
	if (args.ganglion_id) text += " " + theme.fg("accent", args.ganglion_id);
	if (args.name) text += " " + theme.fg("dim", args.name);
	return new Text(text, 0, 0);
}

export function renderGanglionResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }, _options: { expanded: boolean }, theme: AnyTheme): Container | Text {
	const d = result.details as { ganglion?: Ganglion; ganglions?: Ganglion[]; summary?: GanglionSummary; error?: string } | undefined;
	if (result.isError || d?.error) return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", result.content[0]?.text ?? "error")}`, 0, 0);
	const c = new Container();
	if (d?.ganglion) c.addChild(new Markdown(summarizeGanglion(d.ganglion), 0, 0, getMarkdownTheme()));
	else if (d?.ganglions) c.addChild(new Markdown(summarizeList(d.ganglions), 0, 0, getMarkdownTheme()));
	else if (d?.summary) c.addChild(new Markdown(summarizeSummary(d.summary), 0, 0, getMarkdownTheme()));
	else c.addChild(new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", result.content[0]?.text ?? "ok")}`, 0, 0));
	return c;
}
function firstLine(s: string): string { const line = s.split(/\n/)[0]?.trim() ?? ""; return line.length > 90 ? `${line.slice(0, 90)}…` : line; }
