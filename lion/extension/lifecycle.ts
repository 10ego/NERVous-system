import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LionProgressSnapshot, LionRun, LionRunStatus } from "./schema.ts";

export type LionEventKind = "started" | "progress" | "completed" | "blocked" | "failed";

function includeEventObjective(): boolean {
	return /^(1|true|yes)$/i.test(process.env.LION_EVENT_INCLUDE_OBJECTIVE ?? "");
}

export function lionEventPayload(kind: LionEventKind, run: LionRun, progress?: LionProgressSnapshot): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		component: "lion",
		event: kind,
		run_id: run.id,
		run_incarnation_id: run.incarnation_id ?? null,
		agent_id: run.agent_id,
		task_id: run.task_id,
		status: run.status,
		objective_redacted: true,
		progress: progress ?? run.progress ?? null,
		updated_at: run.updated_at,
	};
	if (includeEventObjective()) {
		payload.objective = run.objective;
		payload.objective_redacted = false;
	}
	return payload;
}

export function emitLionEvent(pi: ExtensionAPI | undefined, kind: LionEventKind, run: LionRun, progress?: LionProgressSnapshot): void {
	if (!pi) return;
	try {
		(pi as { events?: { emit(event: string, payload: unknown): void } }).events?.emit(`nervous:lion:${kind}`, lionEventPayload(kind, run, progress));
	} catch (error) {
		console.warn(`[nervous-system/lion] event emission failed for ${run.id}/${kind}:`, error);
	}
}

export function startedProgress(): LionProgressSnapshot {
	const ts = new Date().toISOString();
	return { event: "started", activity: "starting LION subprocess…", active_tools: [], tool_uses: 0, turn_count: 0, token_total: null, last_text: null, last_event_at: ts };
}

export function terminalEventKind(status: LionRunStatus): LionEventKind {
	if (status === "blocked") return "blocked";
	if (status === "failed" || status === "aborted") return "failed";
	return "completed";
}
