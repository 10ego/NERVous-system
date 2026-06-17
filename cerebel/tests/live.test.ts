/**
 * Live end-to-end test for the CEREBEL tool via real pi.
 *
 * Gated behind CEREBEL_LIVE=1 because it spawns a real pi process and makes an
 * LLM call. Run with:
 *   CEREBEL_LIVE=1 npx vitest run cerebel/tests/live.test.ts
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { CerebelStore } from "../extension/backend.ts";

const RUN = process.env.CEREBEL_LIVE === "1" ? describe : describe.skip;
const LIVE_MODEL = process.env.CEREBEL_LIVE_MODEL ?? "claude-haiku-4-5";
const EXT = path.resolve(process.cwd(), "cerebel", "extension", "index.ts");

function runPi(prompt: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const p = spawn("pi", ["-e", EXT, "--model", LIVE_MODEL, "-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = ""; let stderr = "";
		p.stdout.on("data", (d) => stdout += d.toString());
		p.stderr.on("data", (d) => stderr += d.toString());
		p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
	});
}

RUN("live cerebel tool", () => {
	it("a real model plans an orchestration wave", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cerebel-live-"));
		process.env.CEREBEL_PATH = path.join(dir, "cerebel.json");
		const prompt = `Use the cerebel tool with action plan_wave. Create a wave for two ready AXON tasks: task-001 titled "Implement todo API" and task-002 titled "Add API tests". Set max_parallel=2 and context="Demo flow". Then reply with the wave id.`;
		const { stdout, stderr, code } = await runPi(prompt, dir);
		assert.equal(code, 0, `pi exited ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);
		const store = CerebelStore.fromCwd(dir);
		const { result } = await store.query((l) => l.current());
		assert.ok(result, "wave persisted");
		assert.equal(result!.assignments.length, 2);
		assert.equal(result!.max_parallel, 2);
		assert.equal(result!.status, "planned");
		// eslint-disable-next-line no-console
		console.log(`\n--- LIVE CEREBEL wave ${result!.id} ---\nassignments: ${result!.assignments.map((a) => `${a.id}:${a.task_id}`).join(", ")}\n`);
		fs.rmSync(dir, { recursive: true, force: true });
	}, 120000);
});
