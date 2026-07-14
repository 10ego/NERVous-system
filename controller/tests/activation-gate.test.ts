import * as assert from "node:assert";
import { describe, it } from "vitest";
import { installNervousActivationGate, NERVOUS_TOOL_NAMES } from "../extension/activation-gate.ts";

type Handler = (event: any, ctx: any) => any;

function harness(initialActive: string[] = ["read", "bash", "other", ...NERVOUS_TOOL_NAMES]) {
	let active = [...initialActive];
	const handlers = new Map<string, Handler[]>();
	const all = [...new Set(["read", "bash", "other", ...NERVOUS_TOOL_NAMES])];
	const pi: any = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools: () => [...active],
		getAllTools: () => all.map((name) => ({ name })),
		setActiveTools(names: string[]) {
			active = [...names];
		},
	};
	installNervousActivationGate(pi);
	return {
		active: () => [...active],
		setActive(names: string[]) { active = [...names]; },
		async emit(event: string, payload: any = {}) {
			const results = [];
			for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, {}));
			return results;
		},
	};
}

describe("explicit NERVous activation gate", () => {
	it("hides every NERVous tool by default without changing unrelated tools", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});

	it("activates the suite for one exact /nervous invocation and restores afterward", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.emit("input", { text: "/nervous implement the feature", source: "interactive" });
		assert.deepEqual(h.active(), ["read", "bash", "other", ...NERVOUS_TOOL_NAMES]);

		const allowed = await h.emit("tool_call", { toolName: "cortex", toolCallId: "call-1", input: {} });
		assert.deepEqual(allowed, [undefined]);

		await h.emit("agent_end", { messages: [] });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});

	it("does not activate for mentions, sibling commands, or extension-injected input", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		for (const payload of [
			{ text: "please use /nervous for this", source: "interactive" },
			{ text: "/nervous:config show", source: "interactive" },
			{ text: "/nervous hidden request", source: "extension" },
		]) {
			await h.emit("input", payload);
			assert.deepEqual(h.active(), ["read", "bash", "other"]);
		}
	});

	it("hard-blocks unauthorized calls even if a NERVous tool is re-enabled elsewhere", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.setActive(["read", "cortex"]);
		const [result] = await h.emit("tool_call", { toolName: "cortex", toolCallId: "call-2", input: {} });
		assert.equal(result.block, true);
		assert.match(result.reason, /\/nervous/);
	});

	it("restores stale activation before a later idle ordinary prompt", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.emit("input", { text: "/nervous interrupted task", source: "rpc" });
		await h.emit("input", { text: "ordinary request", source: "rpc" });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});

	it("keeps the lease during steering and restores it at shutdown", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.emit("input", { text: "/nervous long task", source: "interactive" });
		await h.emit("input", { text: "focus on tests", source: "interactive", streamingBehavior: "steer" });
		assert.ok(h.active().includes("cortex"));
		await h.emit("session_shutdown", { reason: "reload" });
		assert.deepEqual(h.active(), ["read", "bash", "other"]);
	});
});
