/** Live AMYGDALA tool test via real pi. Defaults to cheaper GPT/openai-codex low thinking. */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { AmygdalaStore } from "../extension/backend.ts";

const RUN = process.env.AMYGDALA_LIVE === "1" ? describe : describe.skip;
const LIVE_PROVIDER = process.env.AMYGDALA_LIVE_PROVIDER ?? "openai-codex";
const LIVE_MODEL = process.env.AMYGDALA_LIVE_MODEL ?? "gpt-5.5";
const LIVE_THINKING = process.env.AMYGDALA_LIVE_THINKING ?? "low";
const EXT = path.resolve(process.cwd(), "amygdala", "extension", "index.ts");

function runPi(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn("pi", ["-e", EXT, "--provider", LIVE_PROVIDER, "--model", LIVE_MODEL, "--thinking", LIVE_THINKING, "-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		p.stdout.on("data", (d) => stdout += d.toString());
		p.stderr.on("data", (d) => stderr += d.toString());
		p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

RUN("live amygdala tool", () => {
	it("a real model assesses a critical risk", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amygdala-live-"));
		process.env.AMYGDALA_PATH = path.join(dir, "amygdala.json");
		const prompt = `Use the amygdala tool action assess for this risk: "Blocked AXON task task-001 requires deleting production data and exposes an auth token." Use source axon and source_id task-001. Then reply with the incident id.`;
		const { stdout, stderr, code } = await runPi(prompt, dir);
		assert.equal(code, 0, `pi exited ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);
		const store = AmygdalaStore.fromCwd(dir);
		const { result } = await store.query((l) => l.all());
		assert.equal(result.length, 1);
		assert.equal(result[0]?.severity, "critical");
		assert.equal(result[0]?.source_id, "task-001");
		// eslint-disable-next-line no-console
		console.log(`\n--- LIVE AMYGDALA ${result[0]!.id} ---\n${result[0]!.severity}/${result[0]!.category} -> ${result[0]!.recommendation}\n`);
		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
