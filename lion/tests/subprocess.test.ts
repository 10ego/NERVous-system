import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { describe, it } from "vitest";
import { buildLionSystemPrompt, buildLionUserPrompt, createLionProgressState, getFinalOutput, getPiInvocation, isPidAlive, parseLionReport, progressFromEvent, signalProcessTree } from "../extension/subprocess.ts";
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
		const user = buildLionUserPrompt({ ...run, steering_messages: [{ id: "steer-001", message: "Prefer tests first", status: "applied", created_at: "now" }] });
		assert.match(user, /run-001/);
		assert.match(user, /task-001/);
		assert.match(user, /Add tests/);
		assert.match(user, /Prefer tests first/);
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

	it("derives redacted bounded progress snapshots from pi JSON events by default", () => {
		const state = createLionProgressState();
		const start = progressFromEvent({ type: "tool_execution_start", toolName: "bash" }, state)!;
		assert.equal(start.event, "tool_start");
		assert.deepEqual(start.active_tools, ["bash"]);
		const end = progressFromEvent({ type: "tool_execution_end", toolName: "bash" }, state)!;
		assert.equal(end.event, "tool_end");
		assert.equal(end.tool_uses, 1);
		assert.deepEqual(end.active_tools, []);
		const msg = progressFromEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working on it" } }, state, 2000)!;
		assert.equal(msg.event, "message");
		assert.equal(msg.last_event_at, new Date(2000).toISOString());
		assert.equal(msg.activity, "responding…");
		assert.equal(msg.last_text, null);
		const done = progressFromEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 10, output: 5 } } }, state)!;
		assert.equal(done.event, "message_end");
		assert.equal(done.token_total, 15);
		assert.equal(done.last_text, null);
	});

	it("can opt in to raw progress text tails", () => {
		const state = createLionProgressState({ includeText: true });
		const msg = progressFromEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working on it" } }, state, 2000)!;
		assert.match(msg.activity, /Working/);
		assert.match(msg.last_text ?? "", /Working/);
	});

	it("keeps same-name active tool calls active until all end", () => {
		const state = createLionProgressState();
		progressFromEvent({ type: "tool_execution_start", toolName: "bash" }, state)!;
		progressFromEvent({ type: "tool_execution_start", toolName: "bash" }, state)!;
		const firstEnd = progressFromEvent({ type: "tool_execution_end", toolName: "bash" }, state)!;
		assert.deepEqual(firstEnd.active_tools, ["bash"]);
		const secondEnd = progressFromEvent({ type: "tool_execution_end", toolName: "bash" }, state)!;
		assert.deepEqual(secondEnd.active_tools, []);
	});

	it("throttles text progress snapshots", () => {
		const state = createLionProgressState();
		assert.ok(progressFromEvent({ type: "message_update", delta: "first" }, state, 2000));
		assert.equal(progressFromEvent({ type: "message_update", delta: "second" }, state, 2500), null);
		assert.ok(progressFromEvent({ type: "message_update", delta: "third" }, state, 3100));
	});

	it("signals a spawned process", async () => {
		const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
		assert.ok(proc.pid);
		assert.equal(isPidAlive(proc.pid!), true);
		signalProcessTree(proc.pid!, "SIGTERM");
		await new Promise<void>((resolve) => proc.on("close", () => resolve()));
		assert.equal(isPidAlive(proc.pid!), false);
	});

	it("resolves pi invocation without throwing", () => {
		const inv = getPiInvocation(["--version"], { forceBinary: true });
		assert.equal(inv.command, "pi");
	});
});
