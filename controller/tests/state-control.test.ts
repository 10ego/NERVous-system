import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { installNervousStateControl, NERVOUS_RESET_REPORT_MESSAGE, NERVOUS_STATE_REPORT_MESSAGE } from "../extension/state-control.ts";

async function withStateRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-state-command-"));
	const old = { root: process.env.NERVOUS_STATE_ROOT, project: process.env.NERVOUS_PROJECT, context: process.env.NERVOUS_CONTEXT };
	process.env.NERVOUS_STATE_ROOT = root;
	process.env.NERVOUS_PROJECT = "test-project";
	process.env.NERVOUS_CONTEXT = "test-context";
	try { return await fn(root); }
	finally {
		if (old.root === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = old.root;
		if (old.project === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = old.project;
		if (old.context === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = old.context;
	}
}

function harness(root: string, hasUI = false, confirm: boolean | (() => Promise<boolean>) = false) {
	const commands = new Map<string, any>();
	const messages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi: any = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	installNervousStateControl(pi);
	const ctx: any = {
		cwd: root,
		hasUI,
		waitForIdle: async () => {},
		sessionManager: { getSessionId: () => "session-test" },
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			confirm: async () => typeof confirm === "function" ? confirm() : confirm,
		},
	};
	return { commands, messages, notifications, ctx };
}

describe("NERVous state control", () => {
	it("posts a non-triggering state report even when no component ledger exists", async () => {
		await withStateRoot(async (root) => {
			const h = harness(root);
			await h.commands.get("nervous:state").handler("", h.ctx);

			assert.equal(h.notifications.length, 0);
			assert.equal(h.messages.length, 1);
			assert.equal(h.messages[0]?.message.customType, NERVOUS_STATE_REPORT_MESSAGE);
			assert.equal(h.messages[0]?.options.triggerTurn, false);
			assert.match(h.messages[0]?.message.content, /Namespace: `test-project\/test-context`/);
			assert.match(h.messages[0]?.message.content, /remain until the whole context is explicitly reset/);
		});
	});

	it("requires explicit non-UI confirmation, then archives rejected raw state and reports the clean namespace", async () => {
		await withStateRoot(async (root) => {
			const contextDir = path.join(root, "test-project", "test-context");
			const cerebelPath = path.join(contextDir, "cerebel", "cerebel.json");
			fs.mkdirSync(path.dirname(cerebelPath), { recursive: true });
			fs.writeFileSync(cerebelPath, JSON.stringify({ waves: { "wave-001": { assignments: [{ id: "assign-001", lion_run_id: "run-001" }] } } }));
			const h = harness(root);

			await h.commands.get("nervous:reset").handler("", h.ctx);
			assert.equal(fs.existsSync(cerebelPath), true);
			assert.match(h.notifications.at(-1)?.message ?? "", /Confirmation required/);

			await h.commands.get("nervous:reset").handler("confirm", h.ctx);
			assert.equal(fs.existsSync(contextDir), false);
			assert.equal(h.messages.at(-1)?.message.customType, NERVOUS_RESET_REPORT_MESSAGE);
			assert.equal(h.messages.at(-1)?.options.triggerTurn, false);
			assert.match(h.messages.at(-1)?.message.content, /Active namespace: empty/);
			const archivePath = h.messages.at(-1)?.message.details.archivePath;
			assert.equal(fs.existsSync(path.join(archivePath, "cerebel", "cerebel.json")), true);
		});
	});

	it("refuses if the selected namespace changes while confirmation is open", async () => {
		await withStateRoot(async (root) => {
			const originalPath = path.join(root, "test-project", "test-context", "axon", "ledger.json");
			fs.mkdirSync(path.dirname(originalPath), { recursive: true });
			fs.writeFileSync(originalPath, JSON.stringify({ tasks: {} }));
			const h = harness(root, true, async () => {
				process.env.NERVOUS_CONTEXT = "different-context";
				return true;
			});
			await h.commands.get("nervous:reset").handler("", h.ctx);
			assert.equal(fs.existsSync(originalPath), true);
			assert.match(h.notifications.at(-1)?.message ?? "", /namespace changed after confirmation/);
		});
	});

	it("refuses active LION records unless force is explicit", async () => {
		await withStateRoot(async (root) => {
			const lionPath = path.join(root, "test-project", "test-context", "lion", "runs.json");
			fs.mkdirSync(path.dirname(lionPath), { recursive: true });
			fs.writeFileSync(lionPath, JSON.stringify({ runs: { "run-001": { id: "run-001", status: "running" } } }));
			const h = harness(root);
			await h.commands.get("nervous:reset").handler("confirm", h.ctx);
			assert.equal(fs.existsSync(lionPath), true);
			assert.match(h.notifications.at(-1)?.message ?? "", /Reset refused.*queued\/running LION records/);
			await h.commands.get("nervous:reset").handler("force confirm", h.ctx);
			assert.equal(fs.existsSync(lionPath), false);
		});
	});
});
