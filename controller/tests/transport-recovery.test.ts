import * as assert from "node:assert";
import { describe, it } from "vitest";
import {
	installNervousTransportRecovery,
	isTransientTransportFailure,
	NERVOUS_TRANSPORT_RECOVERY_MESSAGE,
} from "../extension/transport-recovery.ts";

type Handler = (event: any, ctx: any) => any;

function assistant(overrides: Record<string, unknown> = {}): any {
	return {
		role: "assistant",
		content: [],
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function harness(active = true) {
	let workflowActive = active;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi: any = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	};
	installNervousTransportRecovery(pi, () => workflowActive);
	return {
		sent,
		setActive(value: boolean) { workflowActive = value; },
		async emit(type: string, payload: Record<string, unknown> = {}) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...payload }, {});
		},
	};
}

const websocketFailure = assistant({
	stopReason: "error",
	errorMessage: "WebSocket error",
	diagnostics: [{ type: "provider_transport_failure" }],
	content: [{ type: "toolCall", id: "call-lion", name: "lion", arguments: { action: "run" } }],
});

describe("NERVous transport recovery", () => {
	it("queues one visible steering nudge for an active workflow transport failure", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });

		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.message.customType, NERVOUS_TRANSPORT_RECOVERY_MESSAGE);
		assert.equal(h.sent[0]!.message.display, true);
		assert.match(h.sent[0]!.message.content, /Continue the active workflow from durable state/);
		assert.match(h.sent[0]!.message.content, /do not assume they ran/);
		assert.deepEqual(h.sent[0]!.message.details.unresolved_tool_call_ids, ["call-lion"]);
		assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
	});

	it("recognizes diagnostic and common transport failures but not arbitrary errors", () => {
		assert.equal(isTransientTransportFailure(websocketFailure), true);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "socket hang up" })), true);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "invalid API key" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "aborted", errorMessage: "WebSocket error" })), false);
	});

	it("does not reinject raw provider diagnostics into the recovery prompt", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [assistant({ stopReason: "error", errorMessage: "connection error: secret-provider-detail" })] });
		assert.match(h.sent[0]!.message.content, /connection error/);
		assert.doesNotMatch(h.sent[0]!.message.content, /secret-provider-detail/);
		assert.equal(h.sent[0]!.message.details.error, "connection error");
	});

	it("does not recover inactive workflows or successful turns", async () => {
		const h = harness(false);
		await h.emit("agent_end", { messages: [websocketFailure] });
		h.setActive(true);
		await h.emit("agent_end", { messages: [assistant()] });
		assert.deepEqual(h.sent, []);
	});

	it("stays one-shot across native retries and a failed recovery attempt", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("message_end", { message: assistant() });
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("message_start", { message: { role: "custom", customType: NERVOUS_TRANSPORT_RECOVERY_MESSAGE } });
		await h.emit("agent_end", { messages: [websocketFailure] });
		assert.equal(h.sent.length, 1, "native or recovery failures must not recursively queue nudges");
	});

	it("re-arms after recovery succeeds or a human starts a new turn", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("message_start", { message: { role: "custom", customType: NERVOUS_TRANSPORT_RECOVERY_MESSAGE } });
		await h.emit("message_end", { message: assistant() });
		await h.emit("agent_end", { messages: [websocketFailure] });
		assert.equal(h.sent.length, 2);

		await h.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "continue" }] } });
		await h.emit("agent_end", { messages: [websocketFailure] });
		assert.equal(h.sent.length, 3);
	});

	it("does not label a tool call unresolved when its result is already present", async () => {
		const h = harness();
		await h.emit("agent_end", {
			messages: [websocketFailure, { role: "toolResult", toolCallId: "call-lion", toolName: "lion", content: [], isError: false }],
		});
		assert.deepEqual(h.sent[0]!.message.details.unresolved_tool_call_ids, []);
		assert.doesNotMatch(h.sent[0]!.message.content, /do not assume they ran/);
	});
});
