/**
 * MAGI — pi extension entry point.
 *
 * Registers:
 *   - the `magi` tool (LLM-callable) — runs a MAGI deliberation and returns a
 *     structured {@link MagiOutput} recommendation.
 *   - the `/magi <issue>` command — runs the default council from the user.
 *   - the `/magi:council` command — shows the active council configuration.
 *
 * MAGI advises CORTEX (or the main agent). It never executes work itself.
 *
 * Build priorities for the broader NERVous system put MAGI here; this package
 * is intentionally self-contained so it can be installed and used on its own.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliberate } from "./council.ts";
import { createSubprocessRunner } from "./subprocess.ts";
import { resolveCouncil } from "./config.ts";
import { formatStatus, renderMagiCall, renderMagiResult, summarizeOutput } from "./render.ts";
import { MagiToolParams, type MagiInput, type MagiOutput, type MagiToolInput } from "./schema.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_DIR = path.resolve(EXT_DIR, "..", "config");

async function runMagi(args: {
	input: MagiInput;
	councilSpec?: string;
	critiqueOverride?: boolean;
	cwd: string;
	signal?: AbortSignal;
	onStatusText?: (text: string) => void;
}): Promise<{ output: MagiOutput; source: string }> {
	const resolved = resolveCouncil(args.councilSpec, { cwd: args.cwd, bundledConfigDir: BUNDLED_CONFIG_DIR });
	const config = { ...resolved.config };
	if (args.critiqueOverride !== undefined) config.critique = args.critiqueOverride;

	const generate = createSubprocessRunner({ cwd: args.cwd });
	const output = await deliberate({
		input: args.input,
		config,
		generate,
		signal: args.signal,
		onUpdate: args.onStatusText ? (status) => args.onStatusText!(formatStatus(status)) : undefined,
	});
	return { output, source: resolved.source };
}

type MagiDetails = MagiOutput & { source: string };

export default function (pi: ExtensionAPI) {
	/* ----------------------------- magi tool ------------------------------ */
	pi.registerTool({
		name: "magi",
		label: "MAGI",
		description: [
			"Convene the MAGI deliberation council (default: The Mind, The Heart, The Hand) to deliberate a hard,",
			"ambiguous, risky, or architecturally significant decision and return a structured recommendation.",
			"MAGI advises only — it does not execute tasks. CORTEX converts the recommendation into a plan.",
		].join(" "),
		promptSnippet: "Convene the MAGI council to deliberate a hard decision and return a recommendation",
		promptGuidelines: [
			"Use the magi tool when facing an ambiguous, high-risk, or architecturally significant decision with unclear tradeoffs.",
			"Use the magi tool before final delivery to get a multi-perspective review of a major decision.",
			"Do not use the magi tool for simple, well-understood tasks — reserve it for decisions that warrant deliberation.",
		],
		parameters: MagiToolParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const input: MagiInput = {
				issue: params.issue,
				context: params.context,
				constraints: params.constraints,
				decision_needed: params.decision_needed,
				options: params.options,
			};

			try {
				const { output, source } = await runMagi({
					input,
					councilSpec: params.council,
					critiqueOverride: params.critique,
					cwd: ctx.cwd,
					signal,
					onStatusText: onUpdate
						? (text) => {
								const partial: AgentToolResult<MagiDetails> = {
									content: [{ type: "text", text }],
									details: { ...emptyOutput(), source },
								};
								onUpdate(partial);
							}
						: undefined,
				});

				const details: MagiDetails = { ...output, source };
				return {
					content: [{ type: "text", text: summarizeOutput(output) }],
					details,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `MAGI deliberation failed: ${msg}` }],
					details: { ...emptyOutput(), source: "error" } as MagiDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return renderMagiCall(args as { issue?: string; council?: string }, theme as never);
		},

		renderResult(result, options, theme) {
			return renderMagiResult(
				result as Parameters<typeof renderMagiResult>[0],
				options as Parameters<typeof renderMagiResult>[1],
				theme as never,
			);
		},
	});

	/* ------------------------- /magi <issue> command ---------------------- */
	pi.registerCommand("magi", {
		description: "Convene the MAGI council to deliberate an issue (default council)",
		handler: async (rawArgs, ctx) => {
			const issue = (rawArgs ?? "").trim();
			if (!issue) {
				ctx.ui.notify("Usage: /magi <issue or decision to deliberate>", "info");
				return;
			}
			await deliberateCommand(pi, ctx, { issue });
		},
	});

	/* --------------------- /magi:council info command --------------------- */
	pi.registerCommand("magi:council", {
		description: "Show the active MAGI council configuration",
		handler: async (_args, ctx) => {
			try {
				const resolved = resolveCouncil(undefined, {
					cwd: ctx.cwd,
					bundledConfigDir: BUNDLED_CONFIG_DIR,
				});
				const lines = [
					`MAGI council — source: ${resolved.source}`,
					`synthesizer: ${resolved.config.synthesizer ?? "(default)"} · critique: ${resolved.config.critique ? "on" : "off"}`,
					"",
					...resolved.config.councillors.map((c) => `• ${c.id} — ${c.name}${c.symbol ? ` (${c.symbol})` : ""}`),
				];
				if (resolved.warnings.length) lines.push("", "Warnings:", ...resolved.warnings.map((w) => `- ${w}`));
				for (const line of lines) ctx.ui.notify(line, "info");
			} catch (err) {
				ctx.ui.notify(`MAGI config error: ${err instanceof Error ? err.message : err}`, "error");
			}
		},
	});
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function emptyOutput(): MagiOutput {
	return {
		council_used: [],
		individual_opinions: [],
		points_of_agreement: [],
		points_of_disagreement: [],
		risks: [],
		rejected_options: [],
		final_recommendation: "",
		confidence: "low",
		meta: { critique_used: false, synthesizer: "", rounds: 0, warnings: [] },
	};
}

async function deliberateCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: MagiInput,
): Promise<void> {
	if (ctx.hasUI) {
		ctx.ui.notify("MAGI council convening…", "info");
		ctx.ui.setStatus("magi", "MAGI deliberating…");
	}
	try {
		const { output, source } = await runMagi({
			input,
			cwd: ctx.cwd,
			onStatusText: ctx.hasUI ? (text) => ctx.ui.setStatus("magi", text) : undefined,
		});
		if (ctx.hasUI) ctx.ui.setStatus("magi", undefined);

		// Display the result in the transcript and notify a short summary.
		pi.sendMessage(
			{
				customType: "magi",
				content: summarizeOutput(output),
				display: true,
				details: { ...output, source },
			},
			{ triggerTurn: false },
		);
		const short =
			output.final_recommendation.length > 120
				? `${output.final_recommendation.slice(0, 120)}…`
				: output.final_recommendation;
		ctx.ui.notify(`MAGI complete (${output.confidence}): ${short || "(no recommendation)"}`, "info");
	} catch (err) {
		if (ctx.hasUI) ctx.ui.setStatus("magi", undefined);
		ctx.ui.notify(`MAGI failed: ${err instanceof Error ? err.message : err}`, "error");
	}
}
