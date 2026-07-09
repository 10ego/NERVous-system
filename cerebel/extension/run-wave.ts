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
	reservation_stale_ms?: number;
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

interface ReservationResult {
	wave: Wave;
	assignments: Assignment[];
}

export async function runWave(store: CerebelStore, adapter: RunWaveLionAdapter, options: RunWaveOptions = {}): Promise<RunWaveResult> {
	const results: RunWaveAssignmentResult[] = [];
	let wave = await loadWave(store, options.wave_id);
	const maxParallel = clampParallel(options.max_parallel ?? wave.max_parallel);

	for (;;) {
		const reservation = await reservePlannedAssignments(store, wave.id, maxParallel, options.reservation_stale_ms);
		wave = reservation.wave;
		if (wave.assignments.some((a) => a.status === "blocked" || a.status === "failed")) break;
		if (!reservation.assignments.length) break;

		const batch = await Promise.all(reservation.assignments.map((assignment) => createAndRunOne(store, adapter, wave.id, assignment)));
		results.push(...batch);
		wave = await loadWave(store, wave.id);
	}

	wave = await loadWave(store, wave.id);
	for (const assignment of wave.assignments) {
		if (assignment.status === "planned") {
			results.push({ assignment_id: assignment.id, outcome: "skipped", summary: "not dispatched in this run_wave invocation", blockers: [] });
		}
	}
	return { wave, assignment_results: results, summary: summarizeRunWave(wave, results) };
}

async function reservePlannedAssignments(store: CerebelStore, waveId: string, maxParallel: number, reservationStaleMs = 30_000): Promise<ReservationResult> {
	const { result } = await store.mutate((ledger) => {
		ledger.recoverOrphanedReservations(waveId, { stale_after_ms: reservationStaleMs });
		const current = ledger.get(waveId);
		if (!current) throw new Error(`wave ${waveId} not found`);
		if (current.assignments.some((a) => a.status === "blocked" || a.status === "failed")) return { wave: current, assignments: [] };
		const plannedIds = current.assignments.filter((a) => a.status === "planned").slice(0, maxParallel).map((a) => a.id);
		if (!plannedIds.length) return { wave: current, assignments: [] };
		const wave = ledger.dispatch(waveId, { links: plannedIds.map((assignment_id) => ({ assignment_id })) });
		return { wave, assignments: wave.assignments.filter((a) => plannedIds.includes(a.id)) };
	});
	return result;
}

async function createAndRunOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment): Promise<RunWaveAssignmentResult> {
	let run: LionRun;
	try {
		run = await adapter.createRun(assignment);
		const { result: linkedWave } = await store.mutate((ledger) => ledger.dispatch(waveId, {
			links: [{
				assignment_id: assignment.id,
				lion_run_id: run.id,
				ganglion_id: assignment.ganglion_id,
				ganglion_allocation_id: assignment.ganglion_allocation_id,
			}],
		}));
		const linkedAssignment = linkedWave.assignments.find((a) => a.id === assignment.id) ?? assignment;
		return runOne(store, adapter, waveId, linkedAssignment, run);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await store.mutate((ledger) => ledger.record(waveId, {
			assignment_id: assignment.id,
			ganglion_id: assignment.ganglion_id,
			ganglion_allocation_id: assignment.ganglion_allocation_id,
			outcome: "failed",
			summary: `LION run creation failed: ${message}`,
			blockers: [message],
		}));
		return { assignment_id: assignment.id, outcome: "failed", summary: `LION run creation failed: ${message}`, blockers: [message] };
	}
}

async function runOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: LionRun): Promise<RunWaveAssignmentResult> {
	const progress = createProgressUpdater((snapshot) => adapter.updateProgress?.(run.id, snapshot) ?? Promise.resolve());
	try {
		const out = await adapter.run(run, assignment, progress.enqueue);
		await progress.drain();
		const missingReport = !out.report;
		const finished = await adapter.finishRun(run.id, {
			output: out.text,
			report: out.report,
			status: missingReport ? "failed" : undefined,
			error: missingReport ? "missing WORKER_REPORT" : null,
		});
		const outcome = assignmentStatusFromReport(out.report, finished.status);
		const summary = out.report?.summary ?? (finished.error ? `failed: ${finished.error}` : "failed: missing WORKER_REPORT");
		const blockers = out.report?.blockers ?? (finished.error ? [finished.error] : ["missing WORKER_REPORT"]);
		await store.mutate((ledger) => ledger.record(waveId, {
			assignment_id: assignment.id,
			lion_run_id: run.id,
			ganglion_id: assignment.ganglion_id,
			ganglion_allocation_id: assignment.ganglion_allocation_id,
			outcome,
			summary,
			changed_files: out.report?.changed_files ?? [],
			tests_run: out.report?.tests_run ?? [],
			blockers,
			next_steps: out.report?.next_steps ?? [],
		}));
		return { assignment_id: assignment.id, lion_run_id: run.id, outcome, summary, blockers };
	} catch (err) {
		await progress.drain().catch(() => undefined);
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

function createProgressUpdater(update: (progress: LionProgressSnapshot) => Promise<void>) {
	let inFlight: Promise<void> | null = null;
	let pending: LionProgressSnapshot | null = null;
	const flush = () => {
		if (inFlight || !pending) return;
		const next = pending;
		pending = null;
		inFlight = update(next).catch(() => undefined).finally(() => {
			inFlight = null;
			flush();
		});
	};
	return {
		enqueue(progress: LionProgressSnapshot) {
			pending = progress;
			flush();
		},
		async drain() {
			for (;;) {
				flush();
				if (!inFlight && !pending) return;
				await (inFlight ?? Promise.resolve());
			}
		},
	};
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
	if (!report) return "failed";
	if (report.outcome === "blocked") return "blocked";
	if (report.outcome === "failed") return "failed";
	if (report.outcome === "partial") return "partial";
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
