import * as assert from "node:assert";
import { describe, it } from "vitest";
import {
	buildCouncillorSystemPrompt,
	coerceCritique,
	coerceOpinion,
	coerceSynthesis,
	buildSynthesisUserPrompt,
	deliberate,
	parseJsonLoose,
	type GenerateFn,
} from "../extension/council.ts";
import { DEFAULT_CONFIG, ONE_CONFIG, TWO_CONFIG } from "../extension/config.ts";
import type { CouncilConfig, MagiInput, MagiOutput } from "../extension/schema.ts";

const INPUT: MagiInput = {
	issue: "Should we adopt a monorepo?",
	context: "Two services, shared types.",
	constraints: ["must not block the next release"],
	decision_needed: "Pick a repo structure by EOD.",
	options: ["polyrepo", "monorepo", "single mega-repo"],
};

describe("buildCouncillorSystemPrompt", () => {
	it("derives a persona from structured fields", () => {
		const p = buildCouncillorSystemPrompt({
			id: "mind",
			name: "The Analytical Critic",
			symbol: "The Mind",
			archetype: "Devil's Advocate",
			core_trait: "precise",
			role: "dissect facts",
			danger_prevented: "groupthink",
		});
		assert.ok(p.includes("The Analytical Critic"));
		assert.ok(p.includes("dissect facts"));
		assert.ok(p.includes("groupthink"));
	});

	it("uses an explicit system_prompt override when provided", () => {
		const p = buildCouncillorSystemPrompt({
			id: "x",
			name: "X",
			role: "r",
			system_prompt: "You are a custom persona. Be terse.",
		});
		assert.equal(p, "You are a custom persona. Be terse.");
	});
});

describe("parseJsonLoose", () => {
	it("parses plain json", () => {
		assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
	});
	it("strips a json code fence", () => {
		assert.deepEqual(parseJsonLoose("```json\n{\"a\":1}\n```"), { a: 1 });
		assert.deepEqual(parseJsonLoose("```\n{\"a\":1}\n```"), { a: 1 });
	});
	it("slices out the outermost object from surrounding prose", () => {
		assert.deepEqual(parseJsonLoose('Here you go: {"a":{"b":2}, "c":[1,2]} thanks'), {
			a: { b: 2 },
			c: [1, 2],
		});
	});
	it("returns null when no object is present", () => {
		assert.equal(parseJsonLoose("no json here"), null);
		assert.equal(parseJsonLoose(""), null);
	});
});

describe("coercion helpers", () => {
	it("coerceOpinion maps fields and warns on junk", () => {
		const w: string[] = [];
		const o = coerceOpinion({ position: "p", concerns: ["c1", "c2"], recommendation: "r" }, "mind", w);
		assert.equal(o.councillor, "mind");
		assert.deepEqual(o.concerns, ["c1", "c2"]);
		assert.equal(w.length, 0);

		const w2: string[] = [];
		const fallback = coerceOpinion("not an object", "mind", w2);
		assert.equal(fallback.position, "");
		assert.ok(w2.length > 0);
	});

	it("coerceCritique filters malformed entries", () => {
		const raw = { critiques: [{ of: "heart", note: "weak" }, { note: "no target" }, { of: "hand" }] };
		const out = coerceCritique(raw, []);
		assert.equal(out.length, 1);
		assert.equal(out[0]?.of, "heart");
		assert.equal(coerceCritique({ critiques: [] }, []).length, 0);
	});

	it("coerceSynthesis coerces confidence and warns on empty recommendation", () => {
		const w: string[] = [];
		const s = coerceSynthesis(
			{
				points_of_agreement: ["a"],
				points_of_disagreement: ["d"],
				risks: ["r"],
				rejected_options: ["x"],
				final_recommendation: "do it",
				confidence: "very high",
			},
			w,
		);
		assert.equal(s.confidence, "medium"); // invalid -> medium
		assert.equal(s.final_recommendation, "do it");

		const w2: string[] = [];
		coerceSynthesis({ final_recommendation: "" }, w2);
		assert.ok(w2.some((x) => x.includes("empty")));
	});
});

describe("buildSynthesisUserPrompt", () => {
	it("includes critiques when present", () => {
		const p = buildSynthesisUserPrompt(
			{ id: "hand", name: "Hand", role: "r" },
			[
				{ councillor: "mind", position: "p", concerns: [], recommendation: "r", critiques: [{ of: "heart", note: "n" }] },
			],
			INPUT,
		);
		assert.ok(p.includes("with critiques"));
		assert.ok(p.includes("re heart"));
	});
});

/* ----------------------------- end-to-end (stubbed) --------------------- */

function makeStub(): { fn: GenerateFn; calls: { role: string; id?: string }[] } {
	const calls: { role: string; id?: string }[] = [];
	const fn: GenerateFn = async (req) => {
		calls.push({ role: req.role, id: req.councillorId });
		if (req.role === "opinion") {
			return JSON.stringify({
				position: `position of ${req.councillorId}`,
				concerns: [`${req.councillorId}-concern`],
				recommendation: `rec of ${req.councillorId}`,
			});
		}
		if (req.role === "critique") {
			return JSON.stringify({ critiques: [{ of: "mind", note: "disagrees a bit" }] });
		}
		// synthesis
		return JSON.stringify({
			points_of_agreement: ["agree-1"],
			points_of_disagreement: ["disagree-1"],
			risks: ["risk-1"],
			rejected_options: ["reject-1"],
			final_recommendation: "adopt the monorepo",
			confidence: "high",
		});
	};
	return { fn, calls };
}

describe("deliberate — full flow with stub generator", () => {
	it("runs the 3-councillor default council with critique", async () => {
		const { fn, calls } = makeStub();
		const out: MagiOutput = await deliberate({ input: INPUT, config: DEFAULT_CONFIG, generate: fn });

		assert.deepEqual(out.council_used, ["mind", "heart", "hand"]);
		assert.equal(out.individual_opinions.length, 3);
		assert.equal(out.meta.critique_used, true);
		assert.equal(out.meta.synthesizer, "hand");
		assert.equal(out.meta.rounds, 3);
		assert.equal(out.final_recommendation, "adopt the monorepo");
		assert.equal(out.confidence, "high");
		assert.deepEqual(out.risks, ["risk-1"]);

		// 3 opinions + 3 critiques + 1 synthesis = 7 calls
		assert.equal(calls.length, 7);
		assert.equal(calls.filter((c) => c.role === "synthesis").length, 1);
	});

	it("skips critique when disabled", async () => {
		const cfg: CouncilConfig = { ...DEFAULT_CONFIG, critique: false };
		const { fn, calls } = makeStub();
		const out = await deliberate({ input: INPUT, config: cfg, generate: fn });
		assert.equal(out.meta.critique_used, false);
		assert.equal(out.meta.rounds, 2);
		// 3 opinions + 1 synthesis
		assert.equal(calls.length, 4);
	});

	it("skips critique automatically for a solo council", async () => {
		const { fn, calls } = makeStub();
		const out = await deliberate({ input: INPUT, config: ONE_CONFIG, generate: fn });
		assert.equal(out.council_used.length, 1);
		assert.equal(out.meta.critique_used, false);
		assert.equal(calls.length, 2); // 1 opinion + 1 synthesis
		assert.equal(out.meta.synthesizer, "mind");
	});

	it("degrades gracefully when the model returns prose instead of JSON", async () => {
		const fn: GenerateFn = async () => "I think we should just pick monorepo, honestly.";
		const out = await deliberate({ input: INPUT, config: TWO_CONFIG, generate: fn });
		assert.equal(out.individual_opinions.length, 2);
		// opinions are empty fallbacks, synthesis is a fallback; warnings recorded
		assert.ok(out.meta.warnings.length > 0);
		assert.equal(out.confidence, "medium"); // fallback default
	});
});
