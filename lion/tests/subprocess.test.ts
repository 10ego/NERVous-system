import * as assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { buildLionSystemPrompt, buildLionUserPrompt, createLionProgressState, createLionRunner, getFinalOutput, getPiInvocation, isPidAlive, parseLionReport, progressFromEvent, signalOwnedProcessIfAlive, signalProcessTree } from "../extension/subprocess.ts";
import type { Message } from "@earendil-works/pi-ai";

const CHILD_EXIT_TIMEOUT_MS = 2_000;

async function waitForChildClose(child: ChildProcess, timeoutMs = CHILD_EXIT_TIMEOUT_MS): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.off("close", onClose);
			reject(new Error(`child did not close within ${timeoutMs}ms`));
		}, timeoutMs);
		const onClose = () => {
			clearTimeout(timer);
			resolve();
		};
		child.once("close", onClose);
	});
}

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
	it("treats an ESRCH cancellation race as undelivered", () => {
		const error = Object.assign(new Error("gone"), { code: "ESRCH" });
		assert.equal(signalOwnedProcessIfAlive(() => true, () => { throw error; }), false);
		assert.equal(signalOwnedProcessIfAlive(() => false, () => { throw new Error("must not signal"); }), false);
		assert.throws(() => signalOwnedProcessIfAlive(() => true, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), /denied/);
	});

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

	it("does not inspect assistant content when progress text is redacted", () => {
		const state = createLionProgressState();
		const message = { role: "assistant", usage: { input: 1, output: 1 } } as Record<string, unknown>;
		Object.defineProperty(message, "content", { get() { throw new Error("content should remain unread"); } });
		const snapshot = progressFromEvent({ type: "message_end", message }, state)!;
		assert.equal(snapshot.last_text, null);
		assert.equal(snapshot.token_total, 2);
	});

	it("bounds unique active tool names and their length", () => {
		const state = createLionProgressState();
		let snapshot;
		for (let index = 0; index < 100; index++) {
			snapshot = progressFromEvent({ type: "tool_execution_start", toolName: `tool-${index}-${"x".repeat(200)}` }, state)!;
		}
		assert.equal(snapshot!.active_tools.length, 32);
		assert.equal(snapshot!.active_tools.every((name) => name.length <= 128), true);
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
		try {
			assert.ok(proc.pid);
			assert.equal(isPidAlive(proc.pid!), true);
			signalProcessTree(proc.pid!, "SIGTERM");
			await waitForChildClose(proc);
			assert.equal(isPidAlive(proc.pid!), false);
		} finally {
			if (proc.pid && proc.exitCode === null && proc.signalCode === null && isPidAlive(proc.pid)) {
				try { signalProcessTree(proc.pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
			}
			await waitForChildClose(proc);
		}
	});

	it("rejects after owner-issued cancellation even when the child exits numerically", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lion-json-cancel-test-"));
		const bin = path.join(dir, "pi");
		const ready = path.join(dir, "ready");
		const handled = path.join(dir, "handled");
		await fs.promises.writeFile(bin, `#!/usr/bin/env node\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(handled)}, "handled"); process.exit(143); });\nfs.writeFileSync(${JSON.stringify(ready)}, "ready");\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
		try {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			let resolveProcess!: (info: import("../extension/subprocess.ts").LionProcessInfo) => void;
			const processStarted = new Promise<import("../extension/subprocess.ts").LionProcessInfo>((resolve) => { resolveProcess = resolve; });
			const running = runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5000, onProcessStart: resolveProcess });
			const processInfo = await processStarted;
			for (let attempt = 0; attempt < 200; attempt++) {
				try { await fs.promises.access(ready); break; }
				catch { if (attempt === 199) throw new Error("fake child did not install SIGTERM handler"); await new Promise((resolve) => setTimeout(resolve, 5)); }
			}
			assert.equal(await processInfo.cancel?.("SIGTERM"), true);
			await assert.rejects(() => running, /aborted or timed out/);
			assert.equal(await fs.promises.readFile(handled, "utf8"), "handled");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("notifies process exit once when spawn error is followed by close", async () => {
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const runner = createLionRunner({ cwd: process.cwd(), forcePiBinary: true });
			let exits = 0;
			await assert.rejects(() => runner({ run: { ...run, steering_messages: [] }, timeout_ms: 1000, onProcessExit: () => { exits++; } }), /ENOENT|spawn pi/);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(exits, 1);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("resolves pi invocation without throwing", () => {
		const inv = getPiInvocation(["--version"], { forceBinary: true });
		assert.equal(inv.command, "pi");
	});
});
