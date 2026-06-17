/**
 * SYNAPSE — TUI rendering + markdown summaries.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Note, NoteType, SynapseSummary } from "./schema.ts";

type AnyTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const TYPE_ICON: Record<NoteType, string> = {
	started: "▶",
	completed: "✓",
	blocker: "⛔",
	risk: "⚠",
	decision: "★",
	info: "•",
};

const TYPE_COLOR: Record<NoteType, string> = {
	started: "accent",
	completed: "success",
	blocker: "error",
	risk: "warning",
	decision: "accent",
	info: "muted",
};

function shortTime(iso: string): string {
	// ISO -> HH:MM:SS (keeps notes compact in the feed)
	const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
	return m && m[1] ? m[1] : iso.slice(-8);
}

/** One-line compact form for a note, e.g. `▶ note-003 [lion-1] (task-002) starting auth refactor`. */
export function noteLine(n: Note): string {
	const who = n.agent_id ? `[${n.agent_id}]` : "[system]";
	const task = n.task_id ? `(${n.task_id})` : "(general)";
	return `${TYPE_ICON[n.type]} ${n.id} ${who} ${task} ${n.message}`;
}

/* ----------------------------- markdown summaries ----------------------- */

export function summarizeFeed(notes: Note[], heading = "SYNAPSE feed"): string {
	if (notes.length === 0) return `_(no notes)_`;
	const lines = [`# ${heading}`, ""];
	for (const n of notes) {
		const who = n.agent_id ? `**${n.agent_id}**` : "_system_";
		const task = n.task_id ? ` \`${n.task_id}\`` : "";
		lines.push(`${TYPE_ICON[n.type]} \`${n.id}\` ${who}${task} — ${n.message}  _${shortTime(n.created_at)}_`);
	}
	return lines.join("\n");
}

export function summarizeBoard(s: SynapseSummary): string {
	const lines: string[] = ["# SYNAPSE — coordination feed", ""];
	lines.push(`**${s.total}** notes · oldest age: ${formatAge(s.oldest_age_ms)}`);
	lines.push(`_retention: TTL ${formatAge(s.retention.ttl_ms)}, max ${s.retention.max_notes}_`);
	if (Object.keys(s.by_type).length) {
		lines.push("");
		lines.push("**By type:** " + (Object.entries(s.by_type) as [NoteType, number][])
			.map(([t, c]) => `${TYPE_ICON[t]} ${t} ${c}`)
			.join(" · "));
	}
	if (s.by_task.length) {
		lines.push("");
		lines.push("**Top tasks:**");
		for (const t of s.by_task.slice(0, 6)) {
			lines.push(`- ${t.task_id ?? "(general)"}: ${t.count}`);
		}
	}
	if (s.recent.length) {
		lines.push("");
		lines.push("## Recent");
		for (const n of s.recent) {
			const who = n.agent_id ? `**${n.agent_id}**` : "_system_";
			const task = n.task_id ? ` \`${n.task_id}\`` : "";
			lines.push(`${TYPE_ICON[n.type]} \`${n.id}\` ${who}${task} — ${n.message}  _${shortTime(n.created_at)}_`);
		}
	}
	return lines.join("\n");
}

function formatAge(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return "—";
	if (ms <= 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/* ----------------------------- TUI rendering ---------------------------- */

export function renderSynapseCall(args: { action: string; type?: string; task_id?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("synapse ")) + theme.fg("accent", args.action);
	if (args.type) text += " " + theme.fg(TYPE_COLOR[args.type as NoteType] ?? "muted", TYPE_ICON[args.type as NoteType] ?? "•");
	if (args.task_id) text += " " + theme.fg("accent", args.task_id);
	return new Text(text, 0, 0);
}

interface SynapseResultDetails {
	action: string;
	note?: Note;
	notes?: Note[];
	summary?: SynapseSummary;
	pruned?: number;
	cleared?: number;
	error?: string;
}

export function renderSynapseResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	_options: { expanded: boolean },
	theme: AnyTheme,
): Container | Text {
	const details = result.details as SynapseResultDetails | undefined;

	if (result.isError || !details || details.error) {
		const text = result.content[0]?.text ?? "(no output)";
		return new Text(`${theme.fg("error", "✗")} ${theme.fg("dim", text)}`, 0, 0);
	}

	// Single note posted -> compact confirmation card.
	if (details.note && !details.notes && !details.summary) {
		const n = details.note;
		const text =
			`${theme.fg("success", "✓")} ${theme.fg(TYPE_COLOR[n.type], `${TYPE_ICON[n.type]} ${n.id}`)} ` +
			`${theme.fg("muted", n.agent_id ?? "system")} ` +
			`${theme.fg("accent", n.task_id ?? "general")} ` +
			`\n${theme.fg("dim", n.message)}`;
		return new Text(text, 0, 0);
	}

	// Summary / feed -> markdown.
	const md =
		details.summary ? summarizeBoard(details.summary) : details.notes ? summarizeFeed(details.notes) : null;
	if (md) {
		const c = new Container();
		c.addChild(new Markdown(md, 0, 0, getMarkdownTheme()));
		return c;
	}

	// Prune / clear confirmation.
	const text = result.content[0]?.text ?? "ok";
	const extra: string[] = [];
	if (details.pruned !== undefined) extra.push(theme.fg("muted", `pruned ${details.pruned}`));
	if (details.cleared !== undefined) extra.push(theme.fg("muted", `cleared ${details.cleared}`));
	const tail = extra.length ? `\n${extra.join(" · ")}` : "";
	return new Text(`${theme.fg("success", "✓")} ${theme.fg("dim", text)}${tail}`, 0, 0);
}

/** Build a SYNAPSE line for the AXON-style `[task][agent][type] message` convention. */
export function formatConventionalLine(n: Note): string {
	const task = n.task_id ? `[${n.task_id}]` : "";
	const agent = n.agent_id ? `[${n.agent_id}]` : "";
	const type = `[${n.type}]`;
	return `${task}${agent}${type} ${n.message}`.trim();
}

export function feedSpacer(): Spacer {
	return new Spacer(1);
}
