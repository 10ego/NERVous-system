import * as assert from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { boundedPersistedOutput, buildLionSystemPrompt, buildLionUserPrompt, buildTerminalDiagnostic, captureObservationalGit, createLionProgressState, createLionRunner, getFinalOutput, getPiInvocation, isPidAlive, LionRunnerError, OBSERVATIONAL_GIT_CONFIG_ARGS, parseLionReport, progressFromEvent, sanitizeDiagnosticTail, signalOwnedProcessIfAlive, signalProcessTree, type LionSubprocessDiagnosticContext } from "../extension/subprocess.ts";
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

	it("rejects unwrapped report JSON because WORKER_REPORT is required", () => {
		assert.equal(parseLionReport('{"outcome":"blocked","summary":"missing dependency","blockers":["dep"],"changed_files":[],"tests_run":[],"next_steps":[]}'), null);
	});

	it("accepts only the final fenced JSON WORKER_REPORT block", () => {
		const wrapped = JSON.stringify({ WORKER_REPORT: { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] } });
		assert.equal(parseLionReport(wrapped), null, "raw wrapped JSON is not a final fenced report");
		assert.equal(parseLionReport(`prose\n\`\`\`json\n${wrapped}\n\`\`\`\ntrailing prose`), null, "a report fence must be final");
		assert.equal(parseLionReport(`\`\`\`json\n${wrapped}\n\`\`\`\n\`\`\`json\n{"WORKER_REPORT":{"outcome":"completed"}}\n\`\`\``), null, "an earlier valid fence cannot override the final invalid block");
		assert.equal(parseLionReport(`\`\`\`json\n${wrapped}\n\`\`\``)?.summary, "done");
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

async function withFakePi(script: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lion-diag-"));
	const binDir = path.join(dir, "bin");
	await fs.promises.mkdir(binDir);
	const fakePi = path.join(binDir, "pi");
	await fs.promises.writeFile(fakePi, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
	try {
		await fn(dir);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
}

const messageEnd = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

function runGit(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("LION json runner terminal diagnostics", () => {
	it("classifies a clean exit with an invalid final report candidate as protocol_parse_failure", async () => {
		const line = messageEnd("Done. Nothing else to report.") + "\n";
		const script = `process.stdout.write(${JSON.stringify(line)});`;
		await withFakePi(script, async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			assert.equal(out.settlement, "settled");
			if (out.settlement !== "settled") return;
			assert.equal(out.report, null);
			assert.equal(out.terminal?.reason, "protocol_parse_failure");
			assert.equal(out.terminal?.report_attempted, true);
			assert.equal(typeof out.terminal?.captured_at, "string");
		});
	});

	it("classifies a malformed protocol stream with no report as protocol_parse_failure", async () => {
		const line = "this is not json\n" + messageEnd("no report") + "\n";
		const script = `process.stdout.write(${JSON.stringify(line)});`;
		await withFakePi(script, async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			if (out.settlement !== "settled") throw new Error("expected settled");
			assert.equal(out.report, null);
			assert.equal(out.terminal?.reason, "protocol_parse_failure");
			assert.equal((out.terminal?.malformed_line_count ?? 0) > 0, true);
		});
	});

	it("classifies a clean no-output exit as result_collection_failure", async () => {
		await withFakePi("", async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			if (out.settlement !== "settled") throw new Error("expected settled");
			assert.equal(out.report, null);
			assert.equal(out.terminal?.reason, "result_collection_failure");
			assert.equal(out.terminal?.report_attempted, false);
		});
	});

	it("classifies a nonzero model process exit as model_exit", async () => {
		await withFakePi("process.exit(3);", async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			await assert.rejects(
				() => runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 }),
				(err) => err instanceof LionRunnerError && err.terminal.reason === "model_exit" && err.terminal.exit_code === 3,
			);
		});
	});

	it("rejects an incomplete report contract as protocol_parse_failure", async () => {
		const line = messageEnd(`\`\`\`json\n${JSON.stringify({ WORKER_REPORT: { outcome: "completed", summary: "missing arrays" } })}\n\`\`\``) + "\n";
		await withFakePi(`process.stdout.write(${JSON.stringify(line)});`, async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			if (out.settlement !== "settled") throw new Error("expected settled");
			assert.equal(out.report, null);
			assert.equal(out.terminal?.reason, "protocol_parse_failure");
		});
	});

	it("retains a complete report line after discarding an oversized malformed protocol line", async () => {
		const report = { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] };
		const line = "x".repeat(70_000) + "\n" + messageEnd(`\`\`\`json\n${JSON.stringify({ WORKER_REPORT: report })}\n\`\`\``) + "\n";
		await withFakePi(`process.stdout.write(${JSON.stringify(line)});`, async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			if (out.settlement !== "settled") throw new Error("expected settled");
			assert.equal(out.report?.summary, "done");
			assert.equal(out.terminal, null);
		});
	});

	it("returns a usable report with a null terminal on success", async () => {
		const report = { outcome: "completed", summary: "done", changed_files: [], tests_run: ["npm test"], blockers: [], next_steps: [] };
		const assistantText = "```json\n" + JSON.stringify({ WORKER_REPORT: report }) + "\n```";
		const line = messageEnd(assistantText) + "\n";
		const script = `process.stdout.write(${JSON.stringify(line)});`;
		await withFakePi(script, async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			const out = await runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 });
			if (out.settlement !== "settled") throw new Error("expected settled");
			assert.equal(out.report?.outcome, "completed");
			assert.equal(out.terminal, null);
		});
	});

	it("classifies a spawn error as spawn_failure", async () => {
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			const runner = createLionRunner({ cwd: process.cwd(), forcePiBinary: true });
			await assert.rejects(
				() => runner({ run: { ...run, steering_messages: [] }, timeout_ms: 1_000 }),
				(err) => {
					assert.ok(err instanceof LionRunnerError, "expected LionRunnerError");
					assert.equal((err as LionRunnerError).terminal.reason, "spawn_failure");
					return true;
				},
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("classifies a timeout with bounded observational partial evidence", async () => {
		const events = [
			JSON.stringify({ type: "tool_execution_start", toolName: "write", args: { path: "tracked.txt" } }),
			JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }),
		].join("\n") + "\n";
		await withFakePi(`process.stdout.write(${JSON.stringify(events)}); setInterval(() => {}, 60000);`, async (dir) => {
			runGit(dir, ["init", "--quiet"]);
			runGit(dir, ["config", "user.email", "lion@example.test"]);
			runGit(dir, ["config", "user.name", "LION test"]);
			await fs.promises.writeFile(path.join(dir, "tracked.txt"), "base\n");
			runGit(dir, ["add", "tracked.txt"]);
			runGit(dir, ["commit", "--quiet", "-m", "base"]);
			await fs.promises.writeFile(path.join(dir, "tracked.txt"), "changed\n");
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			await assert.rejects(
				() => runner({ run: { ...run, steering_messages: [] }, timeout_ms: 1_000 }),
				(err) => {
					assert.ok(err instanceof LionRunnerError);
					const terminal = (err as LionRunnerError).terminal;
					assert.equal(terminal.reason, "timeout");
					assert.equal(terminal.timed_out, true);
					assert.equal(terminal.partial_evidence?.observational, true);
					assert.match(terminal.partial_evidence?.git_head ?? "", /^[0-9a-f]{40}$/);
					assert.match(terminal.partial_evidence?.git_status ?? "", /tracked\.txt/);
					assert.ok(terminal.partial_evidence?.changed_files.includes("tracked.txt"));
					assert.deepEqual(terminal.partial_evidence?.tests_run, ["npm test"]);
					return true;
				},
			);
		});
	});

	it("classifies a no-output stderr-only exit as result_collection_failure", async () => {
		await withFakePi('process.stderr.write("boom\\n");', async (dir) => {
			const runner = createLionRunner({ cwd: dir, forcePiBinary: true });
			await assert.rejects(
				() => runner({ run: { ...run, steering_messages: [] }, timeout_ms: 5_000 }),
				(err) => {
					assert.ok(err instanceof LionRunnerError);
					assert.equal((err as LionRunnerError).terminal.reason, "result_collection_failure");
					assert.match((err as LionRunnerError).terminal.stderr_tail ?? "", /boom/);
					return true;
				},
			);
		});
	});
});

describe("LION diagnostic helpers", () => {
	it("sanitizes and bounds diagnostic tails and persisted output", () => {
		assert.equal(sanitizeDiagnosticTail("\x1b[31mred\x1b[0m\x00ctrl", 100), "red ctrl");
		assert.equal(sanitizeDiagnosticTail("x".repeat(10), 5).length, 5);
		assert.match(sanitizeDiagnosticTail("x".repeat(10), 5), /…$/);
		const secrets = sanitizeDiagnosticTail('OPENAI_API_KEY=super-secret GITHUB_TOKEN=second-secret {"api_key":"third-secret"}', 200);
		assert.equal(secrets.includes("super-secret") || secrets.includes("second-secret") || secrets.includes("third-secret"), false);
		assert.match(secrets, /OPENAI_API_KEY=\[REDACTED\]/i);
		assert.match(secrets, /GITHUB_TOKEN=\[REDACTED\]/i);
		assert.match(secrets, /api_key"\s*:\s*\[REDACTED\]/i);
		assert.equal(sanitizeDiagnosticTail('Authorization: "Bearer super-secret"', 100), "Authorization: [REDACTED]");
		assert.equal(boundedPersistedOutput("x".repeat(10), 5), "[truncated 5 leading characters]\nxxxxx");
	});

	it("builds a well-shaped terminal diagnostic", () => {
		const ctx: LionSubprocessDiagnosticContext = { stdoutTail: "a", stderrTail: "b", eventCount: 2, malformedLineCount: 1, turnCount: 0, toolUses: 4, messageCount: 1, exitCode: 0, signal: null, timedOut: false, lastToolAction: "running bash…", changedFiles: [], testsRun: [] };
		const d = buildTerminalDiagnostic("model_exit", ctx, { outputTail: "out", reportAttempted: true });
		assert.equal(d.reason, "model_exit");
		assert.equal(d.tool_uses, 4);
		assert.equal(d.last_tool_action, "running bash…");
		assert.equal(d.output_tail, "out");
		assert.equal(d.report_attempted, true);
		assert.equal(typeof d.captured_at, "string");
	});

	it("captures observational git safely and returns nulls in a non-git directory", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lion-nogit-"));
		const git = await captureObservationalGit(dir);
		assert.equal(git.head, null);
		assert.equal(git.status, null);
	});

	it("disables repository fsmonitor integration during observational git capture", async () => {
		if (process.platform === "win32") return;
		assert.deepEqual(OBSERVATIONAL_GIT_CONFIG_ARGS, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lion-fsmonitor-"));
		runGit(dir, ["init", "--quiet"]);
		runGit(dir, ["config", "user.email", "lion@example.test"]);
		runGit(dir, ["config", "user.name", "LION test"]);
		await fs.promises.writeFile(path.join(dir, "tracked.txt"), "base\n");
		const marker = path.join(dir, "fsmonitor-ran");
		const monitor = path.join(dir, "monitor.sh");
		await fs.promises.writeFile(monitor, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
		runGit(dir, ["add", "tracked.txt", "monitor.sh"]);
		runGit(dir, ["commit", "--quiet", "-m", "base"]);
		runGit(dir, ["config", "core.fsmonitor", monitor]);
		const git = await captureObservationalGit(dir);
		assert.match(git.head ?? "", /^[0-9a-f]{40}$/);
		assert.equal(git.status, null, "a clean porcelain result is represented as null");
		await assert.rejects(() => fs.promises.access(marker));
	});
});
