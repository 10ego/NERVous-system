/**
 * AXON — TUI rendering + markdown summaries.
 *
 * Renders the `axon` tool call/result and the `/axon*` command output. TUI
 * dependencies are isolated here so the pure core (store/backend) stays
 * testable without pi-tui.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AxonAction } from "./schema.ts";
import type { BoardSummary, Task, TaskStatus } from "./schema.ts";
import { statusLabel } from "./task_status.ts";

type AnyTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const STATUS_ICON: Record<TaskStatus, string> = {
	pending: "◯",
	ready: "▹",
	in_progress: "▶",
	blocked: "⛔",
	needs_amygdala: "⚠",
	needs_review: "🔎",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

const STATUS_COLOR: Record<TaskStatus, string> = {
	pending: "dim",
	ready: "accent",
	in_progress: "warning",
	blocked: "error",
	needs_amygdala: "error",
	needs_review: "accent",
	completed: "success",
	failed: "error",
	cancelled: "muted",
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Sort tasks: active-first by priority, then id. */
export function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		const ra = PRIORITY_RANK[a.priority] ?? 9;
		const rb = PRIORITY_RANK[b.priority] ?? 9;
		if (ra !== rb) return ra - rb;
		return a.id.localeCompare(b.id);
	});
}

/* ----------------------------- markdown summaries ----------------------- */

export function summarizeBoard(s: BoardSummary, project?: string): string {
	const active = s.total - s.terminal;
	const lines: string[] = [];
	lines.push(`# AXON board${project ? ` — ${project}` : ""}`);
	lines.push("");
	lines.push(`**${s.total}** tasks · **${active}** active · **${s.terminal}** terminal`);
	lines.push("");
	lines.push("## Status");
	lines.push("| status | count |");
	lines.push("| --- | --- |");
	const order: TaskStatus[] = [
		"pending",
		"ready",
		"in_progress",
		"blocked",
		"needs_amygdala",
		"needs_review",
		"completed",
		"failed",
		"cancelled",
	];
	for (const st of order) {
		const c = s.by_status[st];
		if (c) lines.push(`| ${statusLabel(st)} | ${c} |`);
	}
	const col = (title: string, ids: string[]) => {
		if (!ids.length) return;
		lines.push("");
		lines.push(`## ${title}`);
		for (const id of ids) lines.push(`- \`${id}\``);
	};
	col("Ready to pick up", s.ready);
	col("In progress", s.in_progress);
	col("Blocked", s.blocked);
	col("Needs AMYGDALA", s.needs_amygdala);
	col("Needs review", s.needs_review);
	return lines.join("\n");
}

export function summarizeTask(t: Task): string {
	const lines: string[] = [];
	lines.push(`# ${t.id} — ${t.title}`);
	lines.push("");
	lines.push(
		`**status:** ${statusLabel(t.status)} · **priority:** ${t.priority} · **review:** ${t.review_status} · **assigned:** ${t.assigned_to ?? "—"}`,
	);
	if (t.parent_id) lines.push(`**parent:** \`${t.parent_id}\``);
	if (t.dependencies.length) lines.push(`**depends on:** ${t.dependencies.map((d) => `\`${d}\``).join(", ")}`);
	if (t.description) {
		lines.push("");
		lines.push(t.description);
	}
	if (t.blockers.length) {
		lines.push("");
		lines.push("## Blockers");
		for (const b of t.blockers) lines.push(`- ${b.resolved ? "~~" : ""}${b.text}${b.resolved ? "~~ _(resolved)_" : ""}`);
	}
	if (t.artifacts.length) {
		lines.push("");
		lines.push("## Artifacts");
		for (const a of t.artifacts) lines.push(`- \`${a.path}\`${a.kind ? ` (${a.kind})` : ""}`);
	}
	if (t.progress_notes.length) {
		lines.push("");
		lines.push("## Progress notes");
		for (const n of t.progress_notes)
			lines.push(`- _${n.ts}${n.author ? ` · ${n.author}` : ""}_ — ${n.text}`);
	}
	return lines.join("\n");
}

export function summarizeList(tasks: Task[]): string {
	if (tasks.length === 0) return "_(no tasks match)_";
	const lines: string[] = ["# AXON tasks", ""];
	for (const t of sortTasks(tasks)) {
		lines.push(
			`${STATUS_ICON[t.status]} \`${t.id}\` — **${t.title}** _(${t.status}, ${t.priority}${t.assigned_to ? `, ${t.assigned_to}` : ""})_`,
		);
	}
	return lines.join("\n");
}

/* ----------------------------- TUI rendering ---------------------------- */

export function renderAxonCall(args: { action: string; id?: string; title?: string; status?: string }, theme: AnyTheme): Text {
	let text = theme.fg("toolTitle", theme.bold("axon ")) + theme.fg("accent", args.action);
	if (args.id) text += " " + theme.fg("accent", args.id);
	const preview = args.title ?? args.status;
	if (preview) text += " " + theme.fg("dim", preview.length > 50 ? `${preview.slice(0, 50)}...` : preview);
	return new Text(text, 0, 0);
}

interface AxonResultDetails {
	action: AxonAction;
	task?: Task;
	tasks?: Task[];
	summary?: BoardSummary;
	project?: string;
	promoted?: string[];
	deleted?: boolean;
	assigned?: string | null;
	error?: string;
}

export function renderAxonResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: { expanded: boolean },
	theme: AnyTheme,
): Container | Text {
	const details = result.details as AxonResultDetails | undefined;

	if (result.isError || !details || details.error) {
		const text = result.content[0]?.text ?? "(no output)";
		const icon = theme.fg("error", "✗");
		return new Text(`${icon} ${theme.fg("dim", text)}`, 0, 0);
	}

	// Task-centric actions → a task card.
	if (details.task) {
		return renderTaskCard(details.task, options.expanded, theme);
	}
	// List/summary → markdown wrapped in a container.
	if (details.summary) {
		const c = new Container();
		c.addChild(new Markdown(summarizeBoard(details.summary, details.project), 0, 0, getMarkdownTheme()));
		return c;
	}
	if (details.tasks) {
		const c = new Container();
		c.addChild(new Markdown(summarizeList(details.tasks), 0, 0, getMarkdownTheme()));
		return c;
	}
	// Simple confirmations.
	const text = result.content[0]?.text ?? "ok";
	const icon = theme.fg("success", "✓");
	if (details.promoted && details.promoted.length) {
		return new Text(
			`${icon} ${theme.fg("dim", text)}\n${theme.fg("accent", `promoted: ${details.promoted.join(", ")}`)}`,
			0,
			0,
		);
	}
	return new Text(`${icon} ${theme.fg("dim", text)}`, 0, 0);
}

function renderTaskCard(t: Task, expanded: boolean, theme: AnyTheme): Container | Text {
	const icon = theme.fg(STATUS_COLOR[t.status], STATUS_ICON[t.status]);
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(t.id))} ${theme.fg("muted", "—")} ${t.title}`;
	const meta =
		`${theme.fg("muted", statusLabel(t.status))} · ${theme.fg("muted", t.priority)}` +
		(t.assigned_to ? ` · ${theme.fg("accent", t.assigned_to)}` : "");

	if (!expanded) {
		let text = `${header}\n${meta}`;
		const firstBlocker = t.blockers.find((b) => !b.resolved);
		if (firstBlocker) text += `\n${theme.fg("error", `⛔ ${firstBlocker.text}`)}`;
		if (t.dependencies.length)
			text += `\n${theme.fg("dim", `deps: ${t.dependencies.join(", ")}`)}`;
		return new Text(text, 0, 0);
	}

	const c = new Container();
	c.addChild(new Text(header, 0, 0));
	c.addChild(new Text(meta, 0, 0));
	if (t.description) {
		c.addChild(new Spacer(1));
		c.addChild(new Markdown(t.description, 0, 0, getMarkdownTheme()));
	}
	if (t.dependencies.length) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", `depends on: ${t.dependencies.join(", ")}`), 0, 0));
	}
	if (t.blockers.length) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Blockers ───"), 0, 0));
		for (const b of t.blockers)
			c.addChild(
				new Text(
					(b.resolved ? theme.fg("dim", "✓ ") : theme.fg("error", "⛔ ")) + b.text,
					0,
					0,
				),
			);
	}
	if (t.artifacts.length) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Artifacts ───"), 0, 0));
		for (const a of t.artifacts) c.addChild(new Text(theme.fg("accent", a.path), 0, 0));
	}
	if (t.progress_notes.length) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("muted", "─── Notes ───"), 0, 0));
		const notes = t.progress_notes.slice(-5);
		for (const n of notes)
			c.addChild(new Text(theme.fg("dim", `• ${n.text}${n.author ? ` — ${n.author}` : ""}`), 0, 0));
	}
	return c;
}
