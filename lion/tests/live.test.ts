/**
 * Live end-to-end test for the LION subprocess runner.
 *
 * Gated behind LION_LIVE=1 because it spawns a real `pi` child process and
 * makes a real LLM call. Run with:
 *   LION_LIVE=1 npx vitest run lion/tests/live.test.ts
 */
import * as assert from "node:assert";
import { describe, it } from "vitest";
import { createLionRunner } from "../extension/subprocess.ts";

const RUN = process.env.LION_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = process.env.LION_LIVE_MODEL ?? "claude-haiku-4-5";

RUN("live lion subprocess", () => {
	it("runs an isolated worker and parses its WORKER_REPORT", async () => {
		const runner = createLionRunner({ cwd: process.cwd(), forcePiBinary: true });
		const out = await runner({
			run: {
				id: "run-live-001",
				agent_id: "lion-live",
				task_id: null,
				objective: "Do not modify files. Report that the LION runner is operational.",
				context: "Return a WORKER_REPORT with outcome completed, no changed files, and no blockers.",
				model: LIVE_MODEL,
				tools: [],
			},
			timeout_ms: 120_000,
		});

		assert.ok(out.text.length > 0);
		assert.ok(out.report, `expected parsed WORKER_REPORT in:\n${out.text}`);
		assert.equal(out.report!.outcome, "completed");
		assert.deepEqual(out.report!.blockers, []);
		// eslint-disable-next-line no-console
		console.log("\n--- LIVE LION report ---\n" + JSON.stringify(out.report, null, 2) + "\n");
	}, 150000);
});
