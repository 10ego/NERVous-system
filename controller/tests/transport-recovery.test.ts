import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, it } from "vitest";
import {
	installNervousTransportPauseNotice,
	isTransientTransportFailure,
	NERVOUS_TRANSPORT_PAUSE_MESSAGE,
} from "../extension/transport-recovery.ts";

type Handler = (event: any, ctx: any) => any;

function assistant(overrides: Record<string, unknown> = {}): any {
	return { role: "assistant", content: [], stopReason: "stop", timestamp: 1, ...overrides };
}

function harness(active = true) {
	let workflowActive = active;
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi: any = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	};
	installNervousTransportPauseNotice(pi, () => workflowActive);
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-transport-pause-"));
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
		extensionFactories: [(pi) => installNervousTransportPauseNotice(pi, () => true)],
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

function hasPauseMessage(messages: any[]): boolean {
	return messages.some((message) => message.role === "custom" && message.customType === NERVOUS_TRANSPORT_PAUSE_MESSAGE);
}

describe("NERVous settled transport pause", () => {
	it("waits for true settlement before showing a non-triggering release valve", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		assert.equal(h.sent.length, 0);

		await h.emit("agent_settled");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.message.customType, NERVOUS_TRANSPORT_PAUSE_MESSAGE);
		assert.match(h.sent[0]!.message.content, /\/nervous:resume/);
		assert.deepEqual(h.sent[0]!.message.details.unresolved_tool_call_ids, ["call-lion"]);
		assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });
	});

	it("lets native retry success clear the pending pause", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("agent_end", { messages: [assistant({ content: [{ type: "text", text: "recovered" }] })] });
		await h.emit("agent_settled");
		assert.deepEqual(h.sent, []);
	});

	it("does not mislabel a later non-transport failure", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("agent_end", { messages: [assistant({ stopReason: "error", errorMessage: "invalid API key" })] });
		await h.emit("agent_settled");
		assert.deepEqual(h.sent, []);
	});

	it("shows at most one notice and never starts a model turn", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [websocketFailure] });
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.options.triggerTurn, false);
	});

	it("does not notify inactive workflows", async () => {
		const h = harness(false);
		await h.emit("agent_end", { messages: [websocketFailure] });
		h.setActive(true);
		await h.emit("agent_settled");
		assert.deepEqual(h.sent, []);
	});

	it("recognizes canonical transport forms without broad policy matches", () => {
		for (const errorMessage of ["socket hang up", "read ECONNRESET", "connect ETIMEDOUT", "TypeError: terminated"]) {
			assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage })), true, errorMessage);
		}
		for (const errorMessage of ["invalid API key", "Invalid connection string", "Network access denied by policy", "premature end of JSON input"]) {
			assert.equal(isTransientTransportFailure(assistant({ stopReason: "error", errorMessage })), false, errorMessage);
		}
	});

	it("uses a safe error label instead of raw provider diagnostics", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [assistant({ stopReason: "error", errorMessage: "connection error: secret-provider-detail" })] });
		await h.emit("agent_settled");
		assert.match(h.sent[0]!.message.content, /connection error/);
		assert.doesNotMatch(h.sent[0]!.message.content, /secret-provider-detail/);
	});

	it("settles with a manual notice when native retry is disabled", async () => {
		const h = await createRecoverySession({ enabled: false, maxRetries: 3 }, [{ error: "WebSocket error" }]);
		try {
			await h.session.prompt("start workflow");
			assert.equal(h.callCount(), 1);
			assert.equal(hasPauseMessage(h.session.agent.state.messages as any[]), true);
		} finally { await h.cleanup(); }
	});

	it("does not notify when native retry succeeds", async () => {
		const h = await createRecoverySession({ enabled: true, maxRetries: 1, baseDelayMs: 1 }, [{ error: "WebSocket error" }, { text: "recovered" }]);
		try {
			await h.session.prompt("start workflow");
			assert.equal(h.callCount(), 2);
			assert.equal(hasPauseMessage(h.session.agent.state.messages as any[]), false);
		} finally { await h.cleanup(); }
	});

	it("turns retry cancellation into a manual notice rather than automatic work", async () => {
		const h = await createRecoverySession({ enabled: true, maxRetries: 3, baseDelayMs: 100 }, [{ error: "WebSocket error" }]);
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "auto_retry_start") queueMicrotask(() => h.session.abortRetry());
		});
		try {
			await h.session.prompt("start workflow");
			assert.equal(h.callCount(), 1);
			assert.equal(hasPauseMessage(h.session.agent.state.messages as any[]), true);
		} finally { unsubscribe(); await h.cleanup(); }
	});
});
