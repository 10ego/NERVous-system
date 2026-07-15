import { SettingsManager, type AgentEndEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const NERVOUS_TRANSPORT_RECOVERY_MESSAGE = "nervous:transport-recovery";

const TRANSPORT_ERROR_PATTERNS = [
	/websocket/i,
	/\bnetwork (?:error|failure|connection (?:lost|closed|reset|refused))\b/i,
	/\bconnection (?:error|lost|closed|reset|refused|timed? out)\b/i,
	/socket hang up|fetch failed|other side closed|reset before headers|stream ended before|ended without|http2 request did not get a response/i,
	/premature(?:ly)?\s+(?:closed|ended|end of (?:stream|response))/i,
	/(?:stream|connection|socket|response)(?:\s+was)?\s+terminated/i,
	/(?:^|typeerror:\s*)terminated\s*$/i,
	/timed? out|timeout/i,
	/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b/i,
];

interface AssistantFailure {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	diagnostics?: Array<{ type?: string }>;
	content?: Array<{ type?: string; id?: string }>;
}

function lastAssistant(messages: readonly unknown[]): AssistantFailure | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as AssistantFailure | undefined;
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

export function isTransientTransportFailure(message: AssistantFailure | undefined): boolean {
	if (!message || message.stopReason !== "error") return false;
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === "provider_transport_failure")) return true;
	return typeof message.errorMessage === "string" && TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message.errorMessage!));
}

function unresolvedToolCallIds(messages: readonly unknown[], assistant: AssistantFailure): string[] {
	const completed = new Set(messages.flatMap((message: any) => message?.role === "toolResult" && typeof message.toolCallId === "string" ? [message.toolCallId] : []));
	return (assistant.content ?? [])
		.filter((part) => part.type === "toolCall" && typeof part.id === "string" && !completed.has(part.id))
		.map((part) => part.id!);
}

function transportErrorLabel(message: AssistantFailure): string {
	const error = message.errorMessage ?? "";
	if (/websocket/i.test(error)) return "WebSocket error";
	if (/timed? out|timeout|ETIMEDOUT/i.test(error)) return "transport timeout";
	if (/connection|socket|other side closed|reset before headers|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH/i.test(error)) return "connection error";
	if (/network|fetch failed/i.test(error)) return "network error";
	return "provider transport failure";
}

interface RetryPolicy { enabled: boolean; maxRetries: number }

function effectiveRetryPolicy(ctx: ExtensionContext): RetryPolicy {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getRetrySettings();
		return { enabled: settings.enabled, maxRetries: Math.max(0, settings.maxRetries) };
	} catch (error) {
		console.warn(`[nervous-system/controller] transport recovery could not read retry policy: ${error instanceof Error ? error.message : String(error)}`);
		// Fail closed: never bypass a native retry/cancellation path when its policy
		// cannot be established.
		return { enabled: true, maxRetries: Number.MAX_SAFE_INTEGER };
	}
}

/**
 * Queue one workflow-scoped continuation when the provider transport terminates
 * an active NERVous turn. Native retry owns its configured attempt budget; NERVous
 * intervenes only when native retries are disabled or all attempts are exhausted.
 */
export function installNervousTransportRecovery(
	pi: ExtensionAPI,
	isWorkflowActive: () => boolean,
	options: { getRetryPolicy?: (ctx: ExtensionContext) => RetryPolicy } = {},
): void {
	let recoveryQueued = false;
	let recoveryStarted = false;
	let consecutiveTransportFailures = 0;

	const reset = (): void => { recoveryQueued = false; recoveryStarted = false; consecutiveTransportFailures = 0; };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("message_start", (event) => {
		if (event.message.role === "user") reset();
		if (event.message.role === "custom" && event.message.customType === NERVOUS_TRANSPORT_RECOVERY_MESSAGE) recoveryStarted = true;
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || event.message.stopReason === "error") return;
		consecutiveTransportFailures = 0;
		// Do not reopen a queued one-shot until its recovery message has actually
		// started; unrelated successful messages cannot create a duplicate nudge.
		if (recoveryStarted) reset();
	});
	pi.on("agent_end", (event: AgentEndEvent, ctx) => {
		if (!isWorkflowActive() || recoveryQueued) return;
		const assistant = lastAssistant(event.messages);
		if (!assistant || !isTransientTransportFailure(assistant)) return;

		consecutiveTransportFailures++;
		const retryPolicy = (options.getRetryPolicy ?? effectiveRetryPolicy)(ctx);
		if (retryPolicy.enabled && consecutiveTransportFailures <= retryPolicy.maxRetries) return;

		recoveryQueued = true;
		const unresolved = unresolvedToolCallIds(event.messages, assistant);
		const errorLabel = transportErrorLabel(assistant);
		const replayGuard = unresolved.length
			? " The interrupted response contained unresolved tool calls; do not assume they ran."
			: "";
		pi.sendMessage({
			customType: NERVOUS_TRANSPORT_RECOVERY_MESSAGE,
			content: [
				`NERVous automatic recovery: the previous turn ended because of a transient transport failure (${errorLabel}).`,
				`Continue the active workflow from durable state.${replayGuard}`,
				"Before reissuing side-effecting work, inspect durable state and reuse any committed result so workers or mutations are not duplicated.",
			].join(" "),
			display: true,
			details: { attempt: 1, max_attempts: 1, error: errorLabel, unresolved_tool_call_ids: unresolved },
		}, { triggerTurn: true, deliverAs: "steer" });
	});
}
