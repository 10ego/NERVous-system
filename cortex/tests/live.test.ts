/**
 * Live end-to-end test for the CORTEX tool via a real pi subprocess.
 *
 * Gated behind CORTEX_LIVE=1 because it spawns a real `pi` child process and
 * makes real LLM calls. Run with:
 *   CORTEX_LIVE=1 npx vitest run cortex/tests/live.test.ts
 *
 * Asks a real model to use the `cortex analyze` tool on the spec's demo scenario
 * ("Build a simple todo API with tests") and verifies a durable goal is created
 * with structured intent (success criteria, risks, complexity, needs_magi).
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { CortexStore } from "../extension/backend.ts";

const RUN = process.env.CORTEX_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = process.env.CORTEX_LIVE_MODEL ?? "claude-haiku-4-5";
const EXT = path.resolve(process.cwd(), "cortex", "extension", "index.ts");

function runPi(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn("pi", ["-e", EXT, "--model", LIVE_MODEL, "-p", ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d.toString()));
		p.stderr.on("data", (d) => (stderr += d.toString()));
		p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

RUN("live cortex tool", () => {
	it("a real model analyzes the demo scenario into a durable goal", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-live-"));
		process.env.CORTEX_PATH = path.join(dir, "cortex.json");

		const prompt =
			`Use the cortex tool with action "analyze" to capture the intent of this request: ` +
			`"Build a simple todo API with tests." Fill in intent_summary, goal, success_criteria, constraints, risks, ` +
			`expected_output, complexity, and needs_magi. Then reply with the goal id in one short line.`;
		const { stdout, code } = await runPi([prompt], dir);

		assert.equal(code, 0, `pi exited ${code}; stdout:\n${stdout}\n`);

		// Verify a durable goal was persisted with structured intent.
		const store = CortexStore.fromCwd(dir);
		const { result } = await store.query((s) => s.current());
		assert.ok(result, "a goal was persisted");
		assert.match(result!.id, /^goal-\d+$/);
		assert.ok(result!.intent.goal.length > 0, "goal statement captured");
		assert.ok(result!.intent.success_criteria.length > 0, "success criteria captured");
		assert.ok(["low", "medium", "high"].includes(result!.intent.complexity), "complexity set");
		assert.equal(typeof result!.intent.needs_magi, "boolean");

		// eslint-disable-next-line no-console
		console.log(
			`\n--- LIVE CORTEX goal ${result!.id} ---\n` +
				`goal: ${result!.intent.goal}\n` +
				`complexity: ${result!.intent.complexity} · needs_magi: ${result!.intent.needs_magi}\n` +
				`success_criteria: ${JSON.stringify(result!.intent.success_criteria)}\n`,
		);

		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
