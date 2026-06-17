/**
 * Live end-to-end test for the subprocess runner.
 *
 * Gated behind MAGI_LIVE=1 because it spawns real `pi` child processes and
 * makes real LLM calls. Run with:
 *   MAGI_LIVE=1 npx vitest run tests/live.test.ts
 *
 * Uses a 1-councillor council on a cheap model to keep cost minimal.
 */
import * as assert from "node:assert";
import { describe, it } from "vitest";
import { deliberate } from "../extension/council.ts";
import { createSubprocessRunner } from "../extension/subprocess.ts";
import type { CouncilConfig, MagiInput } from "../extension/schema.ts";

const RUN = process.env.MAGI_LIVE === "1" ? describe : describe.skip;

const LIVE_MODEL = process.env.MAGI_LIVE_MODEL ?? "claude-haiku-4-5";

const soloCouncil: CouncilConfig = {
	name: "live-solo",
	synthesizer: "mind",
	critique: false,
	synthesis_model: LIVE_MODEL,
	councillors: [
		{
			id: "mind",
			name: "The Analytical Critic",
			symbol: "The Mind",
			role: "Dissect the issue with cold precision and recommend the safest option.",
			danger_prevented: "sloppy execution",
			model: LIVE_MODEL,
			tools: ["read", "ls"],
		},
	],
};

const input: MagiInput = {
	issue: "Should we store this app's tiny feature flags in a JSON file or environment variables?",
	decision_needed: "Pick one and justify in one sentence.",
	constraints: ["no new dependencies", "must be readable by a single-process CLI"],
	options: ["json file", "environment variables"],
};

RUN("live subprocess deliberation", () => {
	it("convenes a 1-councillor council via real pi subprocesses", async () => {
		const generate = createSubprocessRunner({ cwd: process.cwd(), forcePiBinary: true });
		const output = await deliberate({ input, config: soloCouncil, generate });

		assert.deepEqual(output.council_used, ["mind"]);
		assert.equal(output.individual_opinions.length, 1);
		assert.equal(output.meta.critique_used, false);
		assert.equal(output.meta.synthesizer, "mind");
		assert.ok(
			output.final_recommendation.length > 0,
			`final_recommendation should be non-empty (warnings: ${output.meta.warnings.join("; ")})`,
		);
		// eslint-disable-next-line no-console
		console.log("\n--- LIVE MAGI recommendation ---\n" + output.final_recommendation + "\n");
	}, 120000);
});
