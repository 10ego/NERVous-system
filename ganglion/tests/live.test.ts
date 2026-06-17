/**
 * Live end-to-end test for the GANGLION tool via real pi.
 *
 * Gated behind GANGLION_LIVE=1 because it spawns a real pi process and makes an
 * LLM call. Defaults to the cheaper configured GPT-family provider/model:
 *   GANGLION_LIVE=1 npx vitest run ganglion/tests/live.test.ts
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { GanglionStore } from "../extension/backend.ts";

const RUN = process.env.GANGLION_LIVE === "1" ? describe : describe.skip;
const LIVE_PROVIDER = process.env.GANGLION_LIVE_PROVIDER ?? "openai-codex";
const LIVE_MODEL = process.env.GANGLION_LIVE_MODEL ?? "gpt-5.5";
const LIVE_THINKING = process.env.GANGLION_LIVE_THINKING ?? "low";
const EXT = path.resolve(process.cwd(), "ganglion", "extension", "index.ts");

function runPi(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn(
			"pi",
			["-e", EXT, "--provider", LIVE_PROVIDER, "--model", LIVE_MODEL, "--thinking", LIVE_THINKING, "-p", prompt],
			{ cwd, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d.toString()));
		p.stderr.on("data", (d) => (stderr += d.toString()));
		p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

RUN("live ganglion tool", () => {
	it("a real model creates a group and allocates a ready task", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ganglion-live-"));
		process.env.GANGLION_PATH = path.join(dir, "ganglion.json");
		const prompt = [
			`Use the ganglion tool to create a group named "demo" with max_parallel=1 and two members:`,
			`member lion-api capabilities ["api"] and member lion-docs capabilities ["docs"].`,
			`Then use ganglion allocate for one ready task: id task-001, title "Implement todo API", required_capabilities ["api"], priority high.`,
			`Reply with the ganglion id and allocation id.`,
		].join(" ");
		const { stdout, stderr, code } = await runPi(prompt, dir);
		assert.equal(code, 0, `pi exited ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);

		const store = GanglionStore.fromCwd(dir);
		const { result } = await store.query((l) => l.current());
		assert.ok(result, "ganglion persisted");
		assert.equal(result!.name, "demo");
		assert.equal(result!.allocations.length, 1);
		assert.equal(result!.allocations[0]?.member_id, "lion-api");
		assert.equal(result!.members.find((m) => m.id === "lion-api")?.status, "busy");
		// eslint-disable-next-line no-console
		console.log(`\n--- LIVE GANGLION ${result!.id} ---\nallocation: ${result!.allocations[0]?.id} -> ${result!.allocations[0]?.member_id}\n`);
		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
