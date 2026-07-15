import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NERVOUS_TRANSPORT_PAUSE_MESSAGE = "nervous:transport-pause";
export const NERVOUS_TRANSPORT_RESUME_PROMPT = [
	"Resume the active NERVous workflow after a settled transport interruption.",
	"Before reissuing side-effecting work, inspect durable CORTEX, AXON, CEREBEL, and LION state; reuse committed results and active runs so workers or mutations are not duplicated.",
	"Continue all workable incomplete work, and report any remaining blocker explicitly.",
].join(" ");

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

interface PendingTransportPause {
	error: string;
	unresolvedToolCallIds: string[];
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

/**
 * Pi owns automatic retry. If a transport failure is still terminal when the
 * AgentSession truly settles, show a manual, non-triggering recovery valve.
 */
export function installNervousTransportPauseNotice(pi: ExtensionAPI, isWorkflowActive: () => boolean): void {
	let pending: PendingTransportPause | undefined;
	const reset = (): void => { pending = undefined; };

	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("agent_end", (event: AgentEndEvent) => {
		if (!isWorkflowActive()) return reset();
		const assistant = lastAssistant(event.messages);
		pending = assistant && isTransientTransportFailure(assistant)
			? { error: transportErrorLabel(assistant), unresolvedToolCallIds: unresolvedToolCallIds(event.messages, assistant) }
			: undefined;
	});
	pi.on("agent_settled", () => {
		if (!isWorkflowActive() || !pending) return reset();
		const paused = pending;
		reset();
		pi.sendMessage({
			customType: NERVOUS_TRANSPORT_PAUSE_MESSAGE,
			content: `NERVous paused after ${paused.error}. Pi native retry was disabled, exhausted, or cancelled. Run /nervous:resume to reconcile durable state and continue explicitly.`,
			display: true,
			details: {
				error: paused.error,
				resume_command: "/nervous:resume",
				unresolved_tool_call_ids: paused.unresolvedToolCallIds,
			},
		}, { triggerTurn: false });
	});
}
