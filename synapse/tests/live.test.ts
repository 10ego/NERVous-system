/**
 * Live end-to-end test for the SYNAPSE tool via a real pi subprocess.
 *
 * Gated behind SYNAPSE_LIVE=1 because it spawns a real `pi` child process and
 * makes real LLM calls. Run with:
 *   SYNAPSE_LIVE=1 npx vitest run synapse/tests/live.test.ts
 *
 * Seeds an isolated scratchpad from one store instance (simulating lion-1), then
 * asks a real model (via pi -p) to read it and report — proving the tool wires to
 * the store and that a separate process sees the on-disk feed.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { SynapseStore } from "../extension/backend.ts";

const RUN = process.env.SYNAPSE_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = process.env.SYNAPSE_LIVE_MODEL ?? "claude-haiku-4-5";
const EXT = path.resolve(process.cwd(), "synapse", "extension", "index.ts");

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

RUN("live synapse tool", () => {
	it("a real model can read notes another agent posted, via the synapse tool", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-live-"));
		process.env.SYNAPSE_PATH = path.join(dir, "synapse.json");
		// Disable retention so seeded notes definitely survive.
		process.env.SYNAPSE_TTL_MS = "0";
		process.env.SYNAPSE_MAX_NOTES = "0";

		// Seed coordination notes as if posted by lion-1 / lion-2.
		const store = SynapseStore.fromCwd(dir);
		await store.mutate((log) =>
			log.post({ message: "Refactoring auth middleware. Avoiding session store; lion-3 owns it.", task_id: "task-014", agent_id: "lion-2", type: "started" }),
		);
		await store.mutate((log) =>
			log.post({ message: "API contract differs from AXON plan. Requesting AMYGDALA review before changing schema.", task_id: "task-021", agent_id: "lion-1", type: "risk" }),
		);

		// Ask a real model (headless pi) to read the feed and report.
		const prompt =
			`Use the synapse tool with action "list" to read the coordination feed, then tell me in one short line ` +
			`how many notes there are and which agent posted a risk. Use the tool exactly once; do not modify anything.`;
		const { stdout, code } = await runPi([prompt], dir);

		assert.equal(code, 0, `pi exited ${code}; stdout:\n${stdout}\n`);
		// The model should report 2 notes and that lion-1 posted a risk.
		assert.match(stdout, /2/);
		assert.match(stdout, /lion-1/i);
		assert.match(stdout, /risk/i);

		// Verify the model did NOT mutate the scratchpad (read-only intent).
		const after = await store.query((log) => log.all().length);
		assert.equal(after.result, 2);

		// eslint-disable-next-line no-console
		console.log("\n--- LIVE SYNAPSE model output ---\n" + stdout.trim().slice(0, 400) + "\n");

		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
