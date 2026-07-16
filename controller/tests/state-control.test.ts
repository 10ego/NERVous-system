import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { installNervousStateControl, NERVOUS_STATE_REPORT_MESSAGE } from "../extension/state-control.ts";

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

describe("NERVous state control", () => {
	it("posts a non-triggering state report even when no component ledger exists", async () => {
		await withStateRoot(async (root) => {
			const commands = new Map<string, any>();
			const messages: Array<{ message: any; options: any }> = [];
			const notifications: Array<{ message: string; level: string }> = [];
			const pi: any = {
				registerCommand(name: string, command: any) { commands.set(name, command); },
				sendMessage(message: any, options: any) { messages.push({ message, options }); },
			};
			installNervousStateControl(pi);
			await commands.get("nervous:state").handler("", {
				cwd: root,
				ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
			});

			assert.equal(notifications.length, 0);
			assert.equal(messages.length, 1);
			assert.equal(messages[0]?.message.customType, NERVOUS_STATE_REPORT_MESSAGE);
			assert.equal(messages[0]?.options.triggerTurn, false);
			assert.match(messages[0]?.message.content, /Namespace: `test-project\/test-context`/);
			assert.match(messages[0]?.message.content, /remain until the whole context is explicitly reset/);
		});
	});
});
