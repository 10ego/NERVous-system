import * as assert from "node:assert";
import { describe, it } from "vitest";
import { buildLionSystemPrompt, buildLionUserPrompt, getFinalOutput, getPiInvocation, parseLionReport } from "../extension/subprocess.ts";
import type { Message } from "@earendil-works/pi-ai";

const run = {
	id: "run-001",
	agent_id: "lion-tests",
	task_id: "task-001",
	objective: "Add tests",
	context: "Use npm test",
	model: null,
	tools: null,
};

describe("LION subprocess helpers", () => {
	it("builds system and user prompts with worker contract", () => {
		const sys = buildLionSystemPrompt(run);
		assert.match(sys, /Local Intelligence Operations Node/);
		assert.match(sys, /WORKER_REPORT/);
		const user = buildLionUserPrompt(run);
		assert.match(user, /run-001/);
		assert.match(user, /task-001/);
		assert.match(user, /Add tests/);
		assert.match(user, /axon tool is available/);
	});

	it("parses fenced WORKER_REPORT JSON", () => {
		const text = `Done\n\n\`\`\`json\n{"WORKER_REPORT":{"outcome":"completed","summary":"added tests","changed_files":["a.test.ts"],"tests_run":["npm test"],"blockers":[],"next_steps":[]}}\n\`\`\``;
		const r = parseLionReport(text)!;
		assert.equal(r.outcome, "completed");
		assert.deepEqual(r.changed_files, ["a.test.ts"]);
	});

	it("parses direct report JSON too", () => {
		const r = parseLionReport('{"outcome":"blocked","summary":"missing dependency","blockers":["dep"],"changed_files":[],"tests_run":[],"next_steps":[]}')!;
		assert.equal(r.outcome, "blocked");
		assert.deepEqual(r.blockers, ["dep"]);
	});

	it("returns null for unparseable output", () => {
		assert.equal(parseLionReport("not json"), null);
	});

	it("extracts final assistant text", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
		] as Message[];
		assert.equal(getFinalOutput(messages), "final");
	});

	it("resolves pi invocation without throwing", () => {
		const inv = getPiInvocation(["--version"], { forceBinary: true });
		assert.equal(inv.command, "pi");
	});
});
