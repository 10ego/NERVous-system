/**
 * MAGI — TUI rendering + human-readable summaries.
 *
 * Used by the `magi` tool's `renderCall` / `renderResult` and by the `/magi`
 * command to format progress and final output. Keeps pi-tui usage isolated
 * here so the pure core (config/council) stays testable without TUI deps.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { MagiOutput } from "./schema.ts";
import type { DeliberateStatus } from "./council.ts";

type AnyTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const CONFIDENCE_ICON: Record<MagiOutput["confidence"], string> = {
	high: "▲",
	medium: "◆",
	low: "▽",
};

/** One-line progress string for streaming tool updates. */
export function formatStatus(status: DeliberateStatus): string {
	const phaseLabel =
		status.phase === "opinion"
			? "gathering opinions"
			: status.phase === "critique"
				? "cross-critique"
				: status.phase === "synthesis"
					? "synthesizing"
					: status.phase === "error"
						? "error"
						: "done";

	const members = status.members
		.map((m) => {
			const icon =
				m.phase === "done" ? "✓" : m.phase === "running" ? "…" : m.phase === "failed" ? "✗" : "·";
			return `${m.id}${icon}`;
		})
		.join(" ");
	return `MAGI [${phaseLabel}] ${members}`.trim();
}

/** Compact, model/user-facing summary of a completed deliberation. */
export function summarizeOutput(output: MagiOutput): string {
	const lines: string[] = [];
	lines.push(`# MAGI recommendation (confidence: ${output.confidence})`);
	lines.push("");
	lines.push(`**Council:** ${output.council_used.join(", ")} · synthesizer: ${output.meta.synthesizer} · critique: ${output.meta.critique_used ? "on" : "off"}`);
	lines.push("");
	lines.push(`## Final recommendation`);
	lines.push(output.final_recommendation || "_(empty)_");

	if (output.risks.length) {
		lines.push("");
		lines.push(`## Risks`);
		for (const r of output.risks) lines.push(`- ${r}`);
	}
	if (output.points_of_disagreement.length) {
		lines.push("");
		lines.push(`## Points of disagreement`);
		for (const d of output.points_of_disagreement) lines.push(`- ${d}`);
	}
	if (output.rejected_options.length) {
		lines.push("");
		lines.push(`## Rejected options`);
		for (const r of output.rejected_options) lines.push(`- ${r}`);
	}
	if (output.points_of_agreement.length) {
		lines.push("");
		lines.push(`## Points of agreement`);
		for (const a of output.points_of_agreement) lines.push(`- ${a}`);
	}
	lines.push("");
	lines.push(`## Individual opinions`);
	for (const o of output.individual_opinions) {
		lines.push(`### ${o.councillor}`);
		lines.push(`- Position: ${o.position || "_(none)_"}`);
		if (o.concerns.length) lines.push(`- Concerns: ${o.concerns.join("; ")}`);
		lines.push(`- Recommendation: ${o.recommendation || "_(none)_"}`);
	}
	if (output.meta.warnings.length) {
		lines.push("");
		lines.push(`> Warnings: ${output.meta.warnings.join("; ")}`);
	}
	return lines.join("\n");
}

/** Render the tool call invocation line. */
export function renderMagiCall(args: { issue?: string; council?: string }, theme: AnyTheme): Text {
	const council = args.council ?? "default";
	const issue = args.issue ?? "...";
	const preview = issue.length > 70 ? `${issue.slice(0, 70)}...` : issue;
	const text =
		theme.fg("toolTitle", theme.bold("magi ")) +
		theme.fg("accent", `council:${council}`) +
		"\n  " +
		theme.fg("dim", preview);
	return new Text(text, 0, 0);
}

/** Render the completed deliberation result (collapsed + expanded views). */
export function renderMagiResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: { expanded: boolean },
	theme: AnyTheme,
): Container | Text {
	const details = result.details as MagiOutput | undefined;

	// Error / no-details fallback.
	if (!details || result.isError) {
		const text = result.content[0]?.text ?? "(no output)";
		const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		return new Text(`${icon} magi\n${theme.fg("dim", text)}`, 0, 0);
	}

	const icon = theme.fg("success", "✓");
	const confidence = theme.fg(
		details.confidence === "high" ? "success" : details.confidence === "low" ? "warning" : "accent",
		`${CONFIDENCE_ICON[details.confidence]} ${details.confidence}`,
	);

	if (options.expanded) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold("magi "))}${theme.fg("accent", details.council_used.join(" · "))} ${confidence}`,
				0,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Final recommendation ───"), 0, 0));
		container.addChild(new Markdown(details.final_recommendation || "_(empty)_", 0, 0, getMarkdownTheme()));

		const section = (title: string, items: string[]) => {
			if (!items.length) return;
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", `─── ${title} ───`), 0, 0));
			for (const it of items) container.addChild(new Text(`• ${it}`, 0, 0));
		};
		section("Risks", details.risks);
		section("Disagreements", details.points_of_disagreement);
		section("Rejected", details.rejected_options);
		section("Agreement", details.points_of_agreement);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Individual opinions ───"), 0, 0));
		for (const o of details.individual_opinions) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("accent", o.councillor)} ${theme.fg("dim", "— " + (o.position || "(no position)"))}`, 0, 0),
			);
			if (o.recommendation)
				container.addChild(new Text(theme.fg("toolOutput", `→ ${o.recommendation}`), 0, 0));
			if (o.critiques?.length) {
				for (const c of o.critiques)
					container.addChild(new Text(theme.fg("dim", `  ⚑ re ${c.of}: ${c.note}`), 0, 0));
			}
		}
		if (details.meta.warnings.length) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("warning", `⚠ ${details.meta.warnings.join("; ")}`), 0, 0));
		}
		return container;
	}

	// Collapsed view.
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("magi "))}${theme.fg("accent", details.council_used.join(" · "))} ${confidence}`;
	const reco =
		details.final_recommendation.length > 140
			? `${details.final_recommendation.slice(0, 140)}...`
			: details.final_recommendation;
	text += `\n${theme.fg("toolOutput", reco || "(no recommendation)")}`;
	if (details.risks.length) text += `\n${theme.fg("warning", `⚠ ${details.risks.length} risk(s)`)}`;
	if (details.points_of_disagreement.length)
		text += `\n${theme.fg("muted", `${details.points_of_disagreement.length} disagreement(s)`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
