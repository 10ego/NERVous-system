import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LionProgressSnapshot, LionRun, LionRunStatus } from "./schema.ts";

export type LionEventKind = "started" | "progress" | "completed" | "blocked" | "failed";
export const MAX_PROGRESS_TEXT = 1_000;
export const DEFAULT_PROGRESS_PERSIST_INTERVAL_MS = 500;

export interface ProgressUpdater {
	enqueue(progress: LionProgressSnapshot): void;
	drain(): Promise<void>;
}

/** Latest-wins, non-overlapping progress persistence with a mandatory final drain. */
export function createProgressUpdater(
	update: (progress: LionProgressSnapshot) => Promise<void>,
	options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): ProgressUpdater {
	const intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_PERSIST_INTERVAL_MS;
	let inFlight: Promise<void> | null = null;
	let pending: LionProgressSnapshot | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastPersistAt = 0;
	const flush = () => {
		if (inFlight || !pending) return;
		if (timer) { clearTimeout(timer); timer = null; }
		const next = pending;
		pending = null;
		lastPersistAt = Date.now();
		inFlight = update(next).catch((error) => { options.onError?.(error); }).finally(() => {
			inFlight = null;
			if (pending) schedule();
		});
	};
	const schedule = () => {
		if (!pending || inFlight || timer) return;
		const delay = Math.max(0, intervalMs - (Date.now() - lastPersistAt));
		if (delay === 0) flush();
		else {
			timer = setTimeout(() => { timer = null; flush(); }, delay);
			timer.unref?.();
		}
	};
	return {
		enqueue(progress) { pending = progress; schedule(); },
		async drain() {
			if (timer) { clearTimeout(timer); timer = null; }
			for (;;) {
				flush();
				if (!inFlight && !pending) return;
				await (inFlight ?? Promise.resolve());
			}
		},
	};
}

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
