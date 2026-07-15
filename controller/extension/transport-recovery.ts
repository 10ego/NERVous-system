import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NERVOUS_TRANSPORT_RECOVERY_MESSAGE = "nervous:transport-recovery";

const TRANSPORT_ERROR_RE = /websocket|network(?:\s+error)?|connection(?:\s+(?:error|lost|closed|reset|refused))?|socket hang up|fetch failed|other side closed|reset before headers|stream ended before|ended without|http2 request did not get a response|premature|terminated|timed? out|timeout/i;

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
	return typeof message.errorMessage === "string" && TRANSPORT_ERROR_RE.test(message.errorMessage);
}

function unresolvedToolCallIds(messages: readonly unknown[], assistant: AssistantFailure): string[] {
	const completed = new Set(messages.flatMap((message: any) => message?.role === "toolResult" && typeof message.toolCallId === "string" ? [message.toolCallId] : []));
	return (assistant.content ?? [])
		.filter((part) => part.type === "toolCall" && typeof part.id === "string" && !completed.has(part.id))
		.map((part) => part.id!);
}

function boundedError(message: AssistantFailure): string {
	const error = message.errorMessage?.trim() || "provider transport failure";
	return error.length > 200 ? `${error.slice(0, 199)}…` : error;
}

/**
 * Queue one workflow-scoped continuation when the provider transport terminates
 * an active NERVous turn. A steering message joins Pi's native retry when enabled
 * and drives a continuation itself when native retries are disabled or exhausted.
 */
export function installNervousTransportRecovery(pi: ExtensionAPI, isWorkflowActive: () => boolean): void {
	let recoveryQueued = false;
	let recoveryStarted = false;

	const reset = (): void => { recoveryQueued = false; recoveryStarted = false; };
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("message_start", (event) => {
		if (event.message.role === "user") reset();
		if (event.message.role === "custom" && event.message.customType === NERVOUS_TRANSPORT_RECOVERY_MESSAGE) recoveryStarted = true;
	});
	pi.on("message_end", (event) => {
		// A native retry may succeed before the queued fallback is consumed. Only
		// reopen the one-shot gate after the recovery message itself has started.
		if (recoveryStarted && event.message.role === "assistant" && event.message.stopReason !== "error") reset();
	});
	pi.on("agent_end", (event: AgentEndEvent) => {
		if (!isWorkflowActive() || recoveryQueued) return;
		const assistant = lastAssistant(event.messages);
		if (!assistant || !isTransientTransportFailure(assistant)) return;

		recoveryQueued = true;
		const unresolved = unresolvedToolCallIds(event.messages, assistant);
		const replayGuard = unresolved.length
			? " The interrupted response contained unresolved tool calls; do not assume they ran."
			: "";
		pi.sendMessage({
			customType: NERVOUS_TRANSPORT_RECOVERY_MESSAGE,
			content: [
				`NERVous automatic recovery: the previous turn ended because of a transient transport failure (${boundedError(assistant)}).`,
				`Continue the active workflow from durable state.${replayGuard}`,
				"Before reissuing side-effecting work, inspect durable state and reuse any committed result so workers or mutations are not duplicated.",
			].join(" "),
			display: true,
			details: { attempt: 1, max_attempts: 1, error: boundedError(assistant), unresolved_tool_call_ids: unresolved },
		}, { triggerTurn: true, deliverAs: "steer" });
	});
}
