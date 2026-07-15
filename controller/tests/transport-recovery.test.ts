import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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

function harness(active = true, retryPolicy = { enabled: false, maxRetries: 0 }) {
	let workflowActive = active;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi: any = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	};
	installNervousTransportRecovery(pi, () => workflowActive, { getRetryPolicy: () => retryPolicy });
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

interface IntegrationResponse { text?: string; error?: string }

async function createRecoverySession(retry: { enabled: boolean; maxRetries: number; baseDelayMs?: number }, responses: IntegrationResponse[]) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-transport-recovery-"));
	const model: any = {
		id: "recovery-test", name: "Recovery Test", api: "recovery-test", provider: "recovery-test", baseUrl: "http://localhost",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
	};
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const settingsManager = SettingsManager.inMemory({ retry, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		extensionFactories: [(pi) => installNervousTransportRecovery(pi, () => true, {
			getRetryPolicy: () => ({ enabled: retry.enabled, maxRetries: retry.maxRetries }),
		})],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	let callCount = 0;
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		authStorage,
		modelRegistry,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		noTools: "all",
	});
	session.agent.streamFn = () => {
		const responseSpec = responses[callCount++] ?? { error: "unexpected extra model call" };
		const response: any = {
			role: "assistant",
			content: responseSpec.text === undefined ? [] : [{ type: "text", text: responseSpec.text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: responseSpec.error ? "error" : "stop",
			errorMessage: responseSpec.error,
			timestamp: Date.now(),
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
			else stream.push({ type: "done", reason: "stop", message: response });
			stream.end(response);
		});
		return stream;
	};
	await session.bindExtensions({ mode: "rpc" });
	return {
		session,
		callCount: () => callCount,
		async cleanup() { session.dispose(); await fs.rm(dir, { recursive: true, force: true }); },
	};
}

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

	it("recognizes diagnostic, phrase, and canonical Node transport failures", () => {
		assert.equal(isTransientTransportFailure(websocketFailure), true);
		for (const errorMessage of ["socket hang up", "read ECONNRESET", "connect ECONNREFUSED", "connect ETIMEDOUT"]) {
			assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage })), true, errorMessage);
		}
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "invalid API key" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "aborted", errorMessage: "WebSocket error" })), false);
	});

	it("recognizes exact undici termination without broad network or connection matches", () => {
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "TypeError: terminated" })), true);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "invalid request terminated by validator" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "premature end of JSON input" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "Invalid connection string" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "Network access denied by policy" })), false);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "response was terminated" })), true);
		assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage: "prematurely closed response" })), true);
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

	it("starts a continuation from agent_end steering when native retries are disabled", async () => {
		const h = await createRecoverySession({ enabled: false, maxRetries: 3 }, [{ error: "WebSocket error" }, { text: "recovered" }]);
		try {
			await h.session.prompt("start workflow");
			const messages = h.session.agent.state.messages as any[];
			assert.equal(h.callCount(), 2, "agent_end steering must drive one continuation");
			assert.ok(messages.some((message) => message.role === "custom" && message.customType === NERVOUS_TRANSPORT_RECOVERY_MESSAGE));
			assert.equal(messages.at(-1)?.content?.[0]?.text, "recovered");
		} finally { await h.cleanup(); }
	});

	it("does not continue when an operator cancels native retry backoff", async () => {
		const h = await createRecoverySession({ enabled: true, maxRetries: 3, baseDelayMs: 100 }, [{ error: "WebSocket error" }]);
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "auto_retry_start") queueMicrotask(() => h.session.abortRetry());
		});
		try {
			await h.session.prompt("start workflow");
			const messages = h.session.agent.state.messages as any[];
			assert.equal(h.callCount(), 1);
			assert.equal(messages.some((message) => message.role === "custom" && message.customType === NERVOUS_TRANSPORT_RECOVERY_MESSAGE), false);
		} finally { unsubscribe(); await h.cleanup(); }
	});

	it("continues only after the configured native retry budget is exhausted", async () => {
		const h = await createRecoverySession(
			{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
			[{ error: "WebSocket error" }, { error: "read ECONNRESET" }, { text: "recovered" }],
		);
		try {
			await h.session.prompt("start workflow");
			const messages = h.session.agent.state.messages as any[];
			assert.equal(h.callCount(), 3);
			assert.ok(messages.some((message) => message.role === "custom" && message.customType === NERVOUS_TRANSPORT_RECOVERY_MESSAGE));
			assert.equal(messages.at(-1)?.content?.[0]?.text, "recovered");
		} finally { await h.cleanup(); }
	});
});
