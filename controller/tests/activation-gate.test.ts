import * as assert from "node:assert";
import { describe, it } from "vitest";
import { installNervousActivationGate, NERVOUS_TOOL_NAMES } from "../extension/activation-gate.ts";
import { NERVOUS_ACTIVATION_ENTRY, NERVOUS_PROMPT_SIGNATURE } from "../extension/nervous-command.ts";

type Handler = (event: any, ctx: any) => any;

function harness(options: { initialActive?: string[]; branch?: any[]; waitForIdle?: () => Promise<void> } = {}) {
	let active = [...(options.initialActive ?? ["read", "bash", "other", ...NERVOUS_TOOL_NAMES])];
	let branch = [...(options.branch ?? [])];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi: any = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) { active = [...names]; },
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
		sendUserMessage(text: string) { sent.push(text); },
	};
	installNervousActivationGate(pi);
	const ctx = {
		sessionManager: { getBranch: () => [...branch] },
		waitForIdle: options.waitForIdle ?? (async () => {}),
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
	};
	return {
		active: () => [...active],
		branch: () => [...branch],
		sent,
		notifications,
		setActive(names: string[]) { active = [...names]; },
		setBranch(entries: any[]) { branch = [...entries]; },
		async command(args: string) { await commands.get("nervous").handler(args, ctx); },
		async resume() { await commands.get("nervous:resume").handler("", ctx); },
		async emit(event: string, payload: any = {}) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
			return results;
		},
	};
}

const activationEntry = { type: "custom", customType: NERVOUS_ACTIVATION_ENTRY, data: { active: true } };

describe("explicit NERVous activation gate", () => {
	it("hides every NERVous tool in a fresh chain without changing unrelated tools", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});

	it("waits for the current run before activating and dispatching the workflow", async () => {
		let release!: () => void;
		const idle = new Promise<void>((resolve) => { release = resolve; });
		const h = harness({ waitForIdle: () => idle });
		await h.emit("session_start", { reason: "startup" });
		const invocation = h.command("implement the feature");
		await Promise.resolve();
		assert.deepEqual(h.active(), ["read", "bash", "other"], "queued command must not authorize the in-flight run");
		assert.deepEqual(h.sent, []);

		release();
		await invocation;
		assert.deepEqual(h.active(), ["read", "bash", "other", ...NERVOUS_TOOL_NAMES]);
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0]!, /Invocation arguments: implement the feature/);
		assert.match(h.sent[0]!, /one bounded task-framing pass before `cortex analyze`/);
		assert.match(h.sent[0]!, /Do not repeat it when resuming, replanning, retrying, or revisiting/);
		assert.ok(
			h.sent[0]!.indexOf("one bounded task-framing pass") < h.sent[0]!.indexOf("Persist the result in `cortex analyze.framing`"),
			"the invocation frames new work before durable analysis",
		);
		assert.ok(
			h.sent[0]!.indexOf("one bounded task-framing pass") < h.sent[0]!.indexOf("Use MAGI for hard"),
			"the invocation frames new work before MAGI deliberation",
		);
	});

	it("keeps the coordinated workflow active for later turns in the same chain", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.command("start durable work");
		await h.emit("agent_end", { messages: [] });
		assert.ok(h.active().includes("cortex"));
		assert.ok(h.branch().some((entry) => entry.customType === NERVOUS_ACTIVATION_ENTRY));

		const allowed = await h.emit("tool_call", { toolName: "axon", toolCallId: "call-1", input: {} });
		assert.deepEqual(allowed, [undefined]);
	});

	it("restores chain activation on resume and recognizes pre-marker workflow sessions", async () => {
		const resumed = harness({ branch: [activationEntry] });
		await resumed.emit("session_start", { reason: "resume" });
		assert.ok(resumed.active().includes("cortex"));

		const legacy = harness({ branch: [{ type: "message", message: { role: "user", content: [{ type: "text", text: `${NERVOUS_PROMPT_SIGNATURE}\n\nInvocation arguments: old work` }] } }] });
		await legacy.emit("session_start", { reason: "resume" });
		assert.ok(legacy.active().includes("cortex"));
	});

	it("syncs activation when tree navigation crosses the marker", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.setBranch([activationEntry]);
		await h.emit("session_tree", { newLeafId: "after", oldLeafId: "before" });
		assert.ok(h.active().includes("cortex"));

		h.setBranch([]);
		await h.emit("session_tree", { newLeafId: "before", oldLeafId: "after" });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});

	it("activates only the configured NERVous subset and blocks excluded tools", async () => {
		const h = harness({ initialActive: ["read", "bash", "cortex", "axon"] });
		await h.emit("session_start", { reason: "startup" });
		await h.command("restricted workflow");
		assert.deepEqual(h.active(), ["read", "bash", "axon", "cortex"]);

		const [result] = await h.emit("tool_call", { toolName: "magi", toolCallId: "call-2", input: {} });
		assert.equal(result.block, true);
		assert.match(result.reason, /excluded/);
	});

	it("does not overwrite tool revocations made after chain activation", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.command("long task");
		h.setActive(["read", "cortex"]);
		await h.emit("agent_end", { messages: [] });
		assert.deepEqual(h.active(), ["read", "cortex"]);
	});

	it("hard-blocks NERVous calls in a fresh chain even if a tool is made visible", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.setActive(["read", "cortex"]);
		const [result] = await h.emit("tool_call", { toolName: "cortex", toolCallId: "call-3", input: {} });
		assert.equal(result.block, true);
		assert.match(result.reason, /\/nervous/);
	});

	it("resumes an active workflow only through an explicit command", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.command("durable work");
		const before = h.sent.length;
		await h.resume();
		assert.equal(h.sent.length, before + 1);
		assert.match(h.sent.at(-1)!, /inspect durable CORTEX, AXON, CEREBEL, and LION state/);
	});

	it("rejects manual resume outside an active workflow", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.resume();
		assert.deepEqual(h.sent, []);
		assert.match(h.notifications[0]!.message, /No active NERVous workflow/);
	});

	it("reports disabled suite configuration instead of dispatching", async () => {
		const h = harness({ initialActive: ["read", "bash"] });
		await h.emit("session_start", { reason: "startup" });
		await h.command("cannot run");
		assert.deepEqual(h.sent, []);
		assert.match(h.notifications[0]!.message, /No NERVous tools/);
	});
});
