/**
 * MAGI — deliberation core.
 *
 * This module is pure: it builds councillor/synthesis prompts, drives the
 * deliberation flow, and coerces model output into the {@link MagiOutput}
 * contract. The actual LLM calls are made through an injectable
 * {@link GenerateFn}, so the core is fully unit-testable with a stub generator.
 *
 * Deliberation flow:
 *   1. Each active councillor produces an independent opinion (parallel).
 *   2. (optional) Cross-critique round: each councillor reviews the others.
 *   3. The synthesizer (The Hand by default) produces the synthesis.
 *   4. MAGI returns a single {@link MagiOutput} to CORTEX.
 *
 * MAGI never executes tasks directly — it only advises.
 */

import {
	type CouncilConfig,
	type Councillor,
	CONFIDENCE_VALUES,
	type Confidence,
	type Critique,
	type MagiInput,
	type MagiOutput,
	type Opinion,
	type Synthesis,
} from "./schema.ts";

/* -------------------------------------------------------------------------- */
/* Generator interface (injected)                                              */
/* -------------------------------------------------------------------------- */

export interface GenerateRequest {
	role: "opinion" | "critique" | "synthesis";
	/** Councillor id for opinion/critique roles. */
	councillorId?: string;
	systemPrompt: string;
	userPrompt: string;
	model?: string;
	tools?: string[];
}

/** Turns a (systemPrompt, userPrompt) request into the model's text reply. */
export type GenerateFn = (req: GenerateRequest, signal?: AbortSignal) => Promise<string>;

export interface DeliberateStatus {
	phase: "opinion" | "critique" | "synthesis" | "done" | "error";
	members: Array<{ id: string; phase: "pending" | "running" | "done" | "failed" }>;
	synthesis?: { synthesizer: string; phase: "pending" | "running" | "done" | "failed" };
	critique: boolean;
	error?: string;
}

export interface DeliberateOptions {
	input: MagiInput;
	config: CouncilConfig;
	generate: GenerateFn;
	signal?: AbortSignal;
	onUpdate?: (status: DeliberateStatus) => void;
}

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                         */
/* -------------------------------------------------------------------------- */

/** Build the persona system prompt for a councillor from its structured fields. */
export function buildCouncillorSystemPrompt(c: Councillor): string {
	if (c.system_prompt && c.system_prompt.trim()) return c.system_prompt.trim();

	const lines: string[] = [];
	lines.push(`# You are ${c.name}${c.symbol ? ` (${c.symbol})` : ""}.`);
	if (c.archetype) lines.push(`Archetype: ${c.archetype}`);
	if (c.core_trait) lines.push(`Core trait: ${c.core_trait}`);
	lines.push("");
	lines.push(`## Role in the MAGI council`);
	lines.push(c.role);
	if (c.danger_prevented) {
		lines.push("");
		lines.push(`## The danger you prevent`);
		lines.push(c.danger_prevented);
	}
	lines.push("");
	lines.push("## How you operate");
	lines.push(
		"- Reason independently. Do not defer to consensus for its own sake; your value is your distinct perspective.",
	);
	lines.push("- Be concrete and specific to THIS issue. No generic platitudes.",
	);
	lines.push("- When you reference code, files, or behavior, ground it in what you can actually read.",
	);
	lines.push("- Stay in character. Advise; do not attempt to execute the work yourself.");
	return lines.join("\n");
}

function renderInputBlock(input: MagiInput): string {
	const parts: string[] = [];
	parts.push(`## Issue\n${input.issue}`);
	if (input.context) parts.push(`## Context\n${input.context}`);
	if (input.constraints && input.constraints.length) {
		parts.push(`## Constraints\n- ${input.constraints.join("\n- ")}`);
	}
	if (input.decision_needed) parts.push(`## Decision needed\n${input.decision_needed}`);
	if (input.options && input.options.length) {
		parts.push(`## Candidate options\n- ${input.options.join("\n- ")}`);
	}
	return parts.join("\n\n");
}

export function buildOpinionUserPrompt(c: Councillor, input: MagiInput): string {
	return [
		renderInputBlock(input),
		"",
		"## Your task",
		`Deliberate on this issue strictly from your perspective as ${c.name}. Then respond.`,
		"",
		"Respond with ONLY a JSON object (no prose, no markdown fences) in exactly this shape:",
		"```json",
		JSON.stringify(
			{
				position: "Your overall position on the issue, in 2-4 sentences.",
				concerns: ["specific concern 1", "specific concern 2"],
				recommendation: "What you recommend, and why, from your perspective.",
			},
			null,
			2,
		),
		"```",
	].join("\n");
}

export function buildCritiqueUserPrompt(
	c: Councillor,
	own: Opinion,
	others: Opinion[],
	input: MagiInput,
): string {
	const othersBlock = others
		.map((o) => {
			return `### ${o.councillor}\n- Position: ${o.position}\n- Recommendation: ${o.recommendation}\n- Concerns: ${o.concerns.join("; ") || "(none)"}`;
		})
		.join("\n\n");
	return [
		`Your own initial position as ${c.name}:`,
		`- Position: ${own.position}`,
		`- Recommendation: ${own.recommendation}`,
		"",
		"## Other councillors' positions",
		othersBlock || "(none)",
		"",
		"## Your task",
		`Review the other councillors' positions from your perspective as ${c.name}. Identify where you agree, ` +
			"where you disagree, and any blind spots or flawed reasoning. Be specific and name the councillor.",
		"",
		"Respond with ONLY a JSON object (no prose, no fences) in exactly this shape:",
		"```json",
		JSON.stringify(
			{
				critiques: [
					{ of: "other-councillor-id", note: "what you agree/disagree with and why" },
				],
			},
			null,
			2,
		),
		"```",
		"If you have no critiques, return { \"critiques\": [] }.",
	].join("\n");
}

export function buildSynthesisUserPrompt(
	synthesizer: Councillor,
	opinions: Opinion[],
	input: MagiInput,
): string {
	const opinionsBlock = opinions
		.map((o) => {
			const crit = o.critiques && o.critiques.length
				? o.critiques.map((x) => `  - re ${x.of}: ${x.note}`).join("\n")
				: "";
			return `### ${o.councillor}\n- Position: ${o.position}\n- Recommendation: ${o.recommendation}\n- Concerns: ${(o.concerns || []).join("; ") || "(none)"}${crit ? "\n" + crit : ""}`;
		})
		.join("\n\n");
	return [
		`You are ${synthesizer.name}, leading the MAGI synthesis.`,
		"",
		renderInputBlock(input),
		"",
		"## Councillor opinions" + (opinions.some((o) => o.critiques?.length) ? " (with critiques)" : ""),
		opinionsBlock || "(none)",
		"",
		"## Your task",
		"Synthesize the council into a single recommendation. Reconcile disagreements, surface the real risks, " +
			"and name what was rejected and why. The final_recommendation must be actionable by CORTEX.",
		"",
		"Respond with ONLY a JSON object (no prose, no fences) in exactly this shape:",
		"```json",
		JSON.stringify(
			{
				points_of_agreement: ["..."],
				points_of_disagreement: ["..."],
				risks: ["..."],
				rejected_options: ["..."],
				final_recommendation: "A single, concrete, actionable recommendation.",
				confidence: "low | medium | high",
			},
			null,
			2,
		),
		"```",
	].join("\n");
}

/* -------------------------------------------------------------------------- */
/* JSON parsing + defensive coercion                                           */
/* -------------------------------------------------------------------------- */

/**
 * Extract a JSON object from a model reply: strips ```json fences and slices to
 * the outermost `{ ... }`. Returns null if no object can be found.
 */
export function parseJsonLoose(text: string): unknown | null {
	if (!text) return null;
	let t = text.trim();

	// Strip a leading code fence.
	const fence = t.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
	if (fence && fence[1] !== undefined) t = fence[1].trim();

	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;

	const slice = t.slice(start, end + 1);
	try {
		return JSON.parse(slice);
	} catch {
		return null;
	}
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.map((x) => (typeof x === "string" ? x : x == null ? "" : String(x)))
		.map((s) => s.trim())
		.filter(Boolean);
}

function asString(v: unknown, fallback = ""): string {
	if (typeof v === "string") return v.trim();
	if (v == null) return fallback;
	return String(v).trim();
}

function asConfidence(v: unknown): Confidence {
	const s = typeof v === "string" ? v.trim().toLowerCase() : "";
	return (CONFIDENCE_VALUES as readonly string[]).includes(s) ? (s as Confidence) : "medium";
}

/** Coerce arbitrary model output into an Opinion, anchored to a known councillor id. */
export function coerceOpinion(raw: unknown, councillorId: string, warnings: string[]): Opinion {
	if (typeof raw !== "object" || raw === null) {
		warnings.push(`councillor "${councillorId}" did not return a JSON object; using fallback opinion.`);
		return { councillor: councillorId, position: "", concerns: [], recommendation: "" };
	}
	const o = raw as Record<string, unknown>;
	const position = asString(o.position);
	const recommendation = asString(o.recommendation);
	const concerns = asStringArray(o.concerns);
	if (!position && !recommendation) {
		warnings.push(`councillor "${councillorId}" returned an empty opinion.`);
	}
	return { councillor: councillorId, position, concerns, recommendation };
}

/** Merge a critique-round reply into an existing opinion. */
export function coerceCritique(raw: unknown, warnings: string[]): Critique[] {
	if (typeof raw !== "object" || raw === null) return [];
	const o = raw as Record<string, unknown>;
	const arr = Array.isArray(o.critiques) ? o.critiques : Array.isArray(o) ? o : [];
	const validIds = new Set<string>();
	return arr
		.map((item) => {
			if (typeof item !== "object" || item === null) return null;
			const r = item as Record<string, unknown>;
			const of = asString(r.of);
			const note = asString(r.note);
			if (!of) return null;
			validIds.add(of);
			return { of, note } satisfies Critique;
		})
		.filter((x): x is Critique => x !== null && x.note.length > 0);
}

/** Coerce arbitrary model output into a Synthesis, with safe defaults. */
export function coerceSynthesis(raw: unknown, warnings: string[]): Synthesis {
	const fallback: Synthesis = {
		points_of_agreement: [],
		points_of_disagreement: [],
		risks: [],
		rejected_options: [],
		final_recommendation: "",
		confidence: "medium",
	};
	if (typeof raw !== "object" || raw === null) {
		warnings.push("synthesizer did not return a JSON object; using fallback synthesis.");
		return fallback;
	}
	const o = raw as Record<string, unknown>;
	const final_recommendation = asString(o.final_recommendation);
	if (!final_recommendation) {
		warnings.push("synthesis had an empty final_recommendation.");
	}
	return {
		points_of_agreement: asStringArray(o.points_of_agreement),
		points_of_disagreement: asStringArray(o.points_of_disagreement),
		risks: asStringArray(o.risks),
		rejected_options: asStringArray(o.rejected_options),
		final_recommendation,
		confidence: asConfidence(o.confidence),
	};
}

/* -------------------------------------------------------------------------- */
/* Deliberation                                                                */
/* -------------------------------------------------------------------------- */

async function safeGenerate(
	generate: GenerateFn,
	req: GenerateRequest,
	signal: AbortSignal | undefined,
	warnings: string[],
): Promise<string> {
	try {
		return await generate(req, signal);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`${req.role}${req.councillorId ? `:${req.councillorId}` : ""} call failed: ${msg}`);
		return "";
	}
}

/**
 * Run a MAGI deliberation and return a structured {@link MagiOutput}.
 *
 * @see DeliberateOptions
 */
export async function deliberate(opts: DeliberateOptions): Promise<MagiOutput> {
	const { input, config, generate, signal, onUpdate } = opts;
	const warnings: string[] = [];
	const councillors = config.councillors;
	const ids = councillors.map((c) => c.id);

	const memberState = new Map<string, "pending" | "running" | "done" | "failed">(
		ids.map((id) => [id, "pending"]),
	);
	const synthesisState: { synthesizer: string; phase: "pending" | "running" | "done" | "failed" } = {
		synthesizer: config.synthesizer ?? "",
		phase: "pending",
	};
	const useCritique = Boolean(config.critique) && councillors.length >= 2;

	const emit = (phase: DeliberateStatus["phase"], extra?: Partial<DeliberateStatus>) => {
		onUpdate?.({
			phase,
			members: ids.map((id) => ({ id, phase: memberState.get(id) ?? "pending" })),
			synthesis: { ...synthesisState },
			critique: useCritique,
			...extra,
		});
	};

	// --- 1. Independent opinions (parallel) --------------------------------
	emit("opinion");
	const opinions = await Promise.all(
		councillors.map(async (c) => {
			memberState.set(c.id, "running");
			emit("opinion");
			const text = await safeGenerate(
				generate,
				{
					role: "opinion",
					councillorId: c.id,
					systemPrompt: buildCouncillorSystemPrompt(c),
					userPrompt: buildOpinionUserPrompt(c, input),
					model: c.model,
					tools: c.tools,
				},
				signal,
				warnings,
			);
			const opinion = coerceOpinion(parseJsonLoose(text), c.id, warnings);
			memberState.set(c.id, "done");
			emit("opinion");
			return opinion;
		}),
	);

	// --- 2. (optional) Cross-critique round --------------------------------
	if (useCritique) {
		emit("critique");
		await Promise.all(
			councillors.map(async (c) => {
				const own = opinions.find((o) => o.councillor === c.id)!;
				const others = opinions.filter((o) => o.councillor !== c.id);
				memberState.set(c.id, "running");
				emit("critique");
				const text = await safeGenerate(
					generate,
					{
						role: "critique",
						councillorId: c.id,
						systemPrompt: buildCouncillorSystemPrompt(c),
						userPrompt: buildCritiqueUserPrompt(c, own, others, input),
						model: c.model,
						tools: c.tools,
					},
					signal,
					warnings,
				);
				own.critiques = coerceCritique(parseJsonLoose(text), warnings);
				memberState.set(c.id, "done");
				emit("critique");
			}),
		);
	}

	// --- 3. Synthesis ------------------------------------------------------
	const synthesizer =
		councillors.find((c) => c.id === config.synthesizer) ?? councillors[councillors.length - 1]!;
	emit("synthesis", { synthesis: { ...synthesisState, phase: "running" } });
	const synthText = await safeGenerate(
		generate,
		{
			role: "synthesis",
			systemPrompt: buildCouncillorSystemPrompt(synthesizer),
			userPrompt: buildSynthesisUserPrompt(synthesizer, opinions, input),
			model: config.synthesis_model ?? synthesizer.model,
			tools: synthesizer.tools,
		},
		signal,
		warnings,
	);
	const synthesis = coerceSynthesis(parseJsonLoose(synthText), warnings);
	synthesisState.phase = "done";
	emit("done", { synthesis: { ...synthesisState, phase: "done" } });

	// --- 4. Assemble output ------------------------------------------------
	return {
		council_used: ids,
		individual_opinions: opinions,
		points_of_agreement: synthesis.points_of_agreement,
		points_of_disagreement: synthesis.points_of_disagreement,
		risks: synthesis.risks,
		rejected_options: synthesis.rejected_options,
		final_recommendation: synthesis.final_recommendation,
		confidence: synthesis.confidence,
		meta: {
			critique_used: useCritique,
			synthesizer: synthesizer.id,
			rounds: useCritique ? 3 : 2,
			warnings,
		},
	};
}
