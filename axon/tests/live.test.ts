/**
 * Live end-to-end test for the AXON tool via a real pi subprocess.
 *
 * Gated behind AXON_LIVE=1 because it spawns a real `pi` child process and
 * makes real LLM calls. Run with:
 *   AXON_LIVE=1 npx vitest run axon/tests/live.test.ts
 *
 * It seeds an isolated ledger, then asks a real model (via pi -p) to use the
 * `axon` tool to read it and report — proving the tool wires to the store and
 * that a separate process sees the on-disk state.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { AxonStore } from "../extension/backend.ts";

const RUN = process.env.AXON_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = process.env.AXON_LIVE_MODEL ?? "claude-haiku-4-5";
const EXT = path.resolve(process.cwd(), "axon", "extension", "index.ts");

function runPi(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn("pi", ["-e", EXT, "--model", LIVE_MODEL, "-p", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d.toString()));
		p.stderr.on("data", (d) => (stderr += d.toString()));
		p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

RUN("live axon tool", () => {
	it("a real model can read tasks the store persisted, via the axon tool", async () => {
		// Isolated ledger dir so this test never touches the user's project ledger.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-live-"));
		process.env.AXON_LEDGER_PATH = path.join(dir, "ledger.json");

		// Seed durable state from a separate store instance (simulating CORTEX writing the plan).
		const store = AxonStore.fromCwd(dir);
		const t1 = await store.mutate((l) =>
			l.create({ title: "Scaffold todo API", priority: "high", description: "Set up project + entrypoint." }),
		);
		const t2 = await store.mutate((l) =>
			l.create({ title: "Write endpoint tests", dependencies: [t1.result.id], priority: "high" }),
		);
		const t1id = t1.result.id;
		const t2id = t2.result.id;

		// Ask a real model (via headless pi) to use the axon tool to read the board.
		const prompt =
			`Use the axon tool with action "summary" to read the task board, then tell me, in one short line, ` +
			`how many tasks are ready and how many are pending. Use the tool exactly once; do not modify anything.`;
		const { stdout, code } = await runPi([prompt], dir);

		assert.equal(code, 0, `pi exited ${code}; stderr/stdout:\n${stdout}\n`);
		// The model should mention that task-001 (no deps) is ready and task-002 is pending.
		assert.match(stdout, /ready/i);
		assert.match(stdout, /pending/i);

		// Verify the model did NOT mutate the ledger (read-only intent).
		const after = await store.query((l) => ({ n: l.summary().total, t1: l.get(t1id), t2: l.get(t2id) }));
		assert.equal(after.result.n, 2);
		assert.equal(after.result.t1?.status, "ready");
		assert.equal(after.result.t2?.status, "pending");

		// eslint-disable-next-line no-console
		console.log("\n--- LIVE AXON model output ---\n" + stdout.trim().slice(0, 400) + "\n");

		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
