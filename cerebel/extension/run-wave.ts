/** CEREBEL run_wave orchestration helper. */

import type { LionProgressSnapshot, LionReport, LionRun } from "../../lion/extension/schema.ts";
import type { Assignment, AssignmentStatus, Wave } from "./schema.ts";
import { CerebelStore } from "./backend.ts";

export interface RunWaveLionAdapter {
	createRun(assignment: Assignment): Promise<LionRun>;
	run(run: LionRun, assignment: Assignment, onProgress: (progress: LionProgressSnapshot) => void): Promise<{ text: string; report: LionReport | null }>;
	finishRun(runId: string, result: { output: string; report: LionReport | null; status?: "completed" | "blocked" | "failed" | "aborted"; error?: string | null }): Promise<LionRun>;
	updateProgress?(runId: string, progress: LionProgressSnapshot): Promise<void>;
}

export interface RunWaveOptions {
	wave_id?: string;
	max_parallel?: number;
}

export interface RunWaveAssignmentResult {
	assignment_id: string;
	lion_run_id?: string;
	outcome: AssignmentStatus | "skipped";
	summary: string;
	blockers: string[];
}

export interface RunWaveResult {
	wave: Wave;
	assignment_results: RunWaveAssignmentResult[];
	summary: string;
}

export async function runWave(store: CerebelStore, adapter: RunWaveLionAdapter, options: RunWaveOptions = {}): Promise<RunWaveResult> {
	const results: RunWaveAssignmentResult[] = [];
	let wave = await loadWave(store, options.wave_id);
	const maxParallel = clampParallel(options.max_parallel ?? wave.max_parallel);

	for (;;) {
		wave = await loadWave(store, wave.id);
		const blockedOrFailed = wave.assignments.find((a) => a.status === "blocked" || a.status === "failed");
		if (blockedOrFailed) break;
		const planned = wave.assignments.filter((a) => a.status === "planned").slice(0, maxParallel);
		if (!planned.length) break;

		const created = await Promise.all(planned.map(async (assignment) => ({ assignment, run: await adapter.createRun(assignment) })));
		wave = (await store.mutate((ledger) => ledger.dispatch(wave.id, {
			links: created.map(({ assignment, run }) => ({
				assignment_id: assignment.id,
				lion_run_id: run.id,
				ganglion_id: assignment.ganglion_id,
				ganglion_allocation_id: assignment.ganglion_allocation_id,
			})),
		}))).result;

		const batch = await Promise.all(created.map(({ assignment, run }) => runOne(store, adapter, wave.id, assignment, run)));
		results.push(...batch);
	}

	wave = await loadWave(store, wave.id);
	for (const assignment of wave.assignments) {
		if (assignment.status === "planned") {
			results.push({ assignment_id: assignment.id, outcome: "skipped", summary: "not dispatched in this run_wave invocation", blockers: [] });
		}
	}
	return { wave, assignment_results: results, summary: summarizeRunWave(wave, results) };
}

async function runOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: LionRun): Promise<RunWaveAssignmentResult> {
	try {
		const out = await adapter.run(run, assignment, (progress) => {
			void adapter.updateProgress?.(run.id, progress).catch(() => undefined);
		});
		const finished = await adapter.finishRun(run.id, { output: out.text, report: out.report });
		const outcome = assignmentStatusFromReport(out.report, finished.status);
		await store.mutate((ledger) => ledger.record(waveId, {
			assignment_id: assignment.id,
			lion_run_id: run.id,
			ganglion_id: assignment.ganglion_id,
			ganglion_allocation_id: assignment.ganglion_allocation_id,
			outcome,
			summary: out.report?.summary ?? (finished.error ? `failed: ${finished.error}` : "completed with unparsed report"),
			changed_files: out.report?.changed_files ?? [],
			tests_run: out.report?.tests_run ?? [],
			blockers: out.report?.blockers ?? (finished.error ? [finished.error] : []),
			next_steps: out.report?.next_steps ?? [],
		}));
		return { assignment_id: assignment.id, lion_run_id: run.id, outcome, summary: out.report?.summary ?? "completed with unparsed report", blockers: out.report?.blockers ?? [] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await adapter.finishRun(run.id, { output: "", report: null, status: "failed", error: message }).catch(() => undefined);
		await store.mutate((ledger) => ledger.record(waveId, {
			assignment_id: assignment.id,
			lion_run_id: run.id,
			ganglion_id: assignment.ganglion_id,
			ganglion_allocation_id: assignment.ganglion_allocation_id,
			outcome: "failed",
			summary: `LION run failed: ${message}`,
			blockers: [message],
		}));
		return { assignment_id: assignment.id, lion_run_id: run.id, outcome: "failed", summary: `LION run failed: ${message}`, blockers: [message] };
	}
}

async function loadWave(store: CerebelStore, waveId?: string): Promise<Wave> {
	const { result } = await store.query((ledger) => {
		const id = !waveId || waveId === "current" || waveId === "latest" ? ledger.current_wave_id ?? ledger.current()?.id : waveId;
		return id ? ledger.get(id) : ledger.current();
	});
	if (!result) throw new Error("run_wave requires wave_id or current wave.");
	return result;
}

function assignmentStatusFromReport(report: LionReport | null, fallback: LionRun["status"]): AssignmentStatus {
	if (report?.outcome === "blocked") return "blocked";
	if (report?.outcome === "failed") return "failed";
	if (report?.outcome === "partial") return "partial";
	if (fallback === "blocked") return "blocked";
	if (fallback === "failed" || fallback === "aborted") return "failed";
	return "completed";
}

function clampParallel(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 3;
}

export function summarizeRunWave(wave: Wave, results: RunWaveAssignmentResult[]): string {
	const completed = wave.assignments.filter((a) => a.status === "completed" || a.status === "partial").length;
	const blocked = wave.assignments.filter((a) => a.status === "blocked").length;
	const failed = wave.assignments.filter((a) => a.status === "failed").length;
	const planned = wave.assignments.filter((a) => a.status === "planned").length;
	const ran = results.filter((r) => r.outcome !== "skipped").length;
	return `${wave.id}: ${wave.status}; ran ${ran}; completed ${completed}/${wave.assignments.length}; blocked ${blocked}; failed ${failed}; planned ${planned}`;
}
