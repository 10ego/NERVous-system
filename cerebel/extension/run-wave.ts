/** CEREBEL run_wave orchestration helper. */

import type { LionProgressSnapshot, LionReport, LionRun } from "../../lion/extension/schema.ts";
import type { Assignment, AssignmentStatus, Wave } from "./schema.ts";
import { CerebelStore } from "./backend.ts";
import type { RecordInput } from "./store.ts";

export interface RunWaveLionAdapter {
	createRun(assignment: Assignment): Promise<LionRun>;
	run(run: LionRun, assignment: Assignment, onProgress: (progress: LionProgressSnapshot) => void): Promise<{ text: string; report: LionReport | null }>;
	finishRun(runId: string, result: { output: string; report: LionReport | null; status?: "completed" | "blocked" | "failed" | "aborted"; error?: string | null }): Promise<LionRun>;
	getRun?(runId: string): Promise<LionRun | undefined>;
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
		if (current.status === "cancelled" || current.status === "completed") return { wave: current, assignments: [] };
		if (current.assignments.some((a) => a.status === "blocked" || a.status === "failed" || a.status === "cancelled")) return { wave: current, assignments: [] };
		const dispatched = current.assignments.filter((a) => a.status === "dispatched").length;
		const remainingCapacity = Math.max(0, maxParallel - dispatched);
		if (remainingCapacity <= 0) return { wave: current, assignments: [] };
		const plannedIds = current.assignments.filter((a) => a.status === "planned").slice(0, remainingCapacity).map((a) => a.id);
		if (!plannedIds.length) return { wave: current, assignments: [] };
		const wave = ledger.dispatch(waveId, { links: plannedIds.map((assignment_id) => ({ assignment_id })) });
		return { wave, assignments: wave.assignments.filter((a) => plannedIds.includes(a.id)) };
	});
	return result;
}

async function createAndRunOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment): Promise<RunWaveAssignmentResult> {
	let run: LionRun | undefined;
	let linkedAssignment: Assignment | undefined;
	try {
		const createdRun = await adapter.createRun(assignment);
		run = createdRun;
		const { result: linkedWave } = await store.mutate((ledger) => ledger.dispatch(waveId, {
			links: [{
				assignment_id: assignment.id,
				lion_run_id: createdRun.id,
				ganglion_id: assignment.ganglion_id,
				ganglion_allocation_id: assignment.ganglion_allocation_id,
			}],
		}));
		linkedAssignment = linkedWave.assignments.find((a) => a.id === assignment.id) ?? assignment;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const summary = run ? `LION run setup failed: ${message}` : `LION run creation failed: ${message}`;
		if (run) {
			await adapter.finishRun(run.id, { output: "", report: null, status: "failed", error: `CEREBEL dispatch/link failed after run creation: ${message}` }).catch(() => undefined);
		}
		const recovery = await recoverSetupFailure(store, waveId, assignment, run, summary, message);
		if (recovery.superseded) return supersededResult(assignment, run?.id, recovery.assignment, summary);
		return { assignment_id: assignment.id, lion_run_id: run?.id, outcome: "failed", summary, blockers: [message] };
	}
	if (!run || !linkedAssignment) throw new Error(`LION run setup did not produce a linked run for ${assignment.id}`);
	return runOne(store, adapter, waveId, linkedAssignment, run);
}

async function recoverSetupFailure(store: CerebelStore, waveId: string, assignment: Assignment, run: LionRun | undefined, summary: string, message: string): Promise<{ superseded: boolean; assignment: Assignment }> {
	const { result } = await store.mutate((ledger) => {
		const current = ledger.get(waveId)?.assignments.find((a) => a.id === assignment.id);
		if (!current) throw new Error(`assignment ${assignment.id} not found in wave ${waveId} during LION setup recovery`);
		const ownedByOtherRun = Boolean(current.lion_run_id && current.lion_run_id !== run?.id);
		const terminal = ["completed", "partial", "blocked", "failed", "cancelled"].includes(current.status);
		if (ownedByOtherRun || terminal) return { superseded: true, assignment: current };
		const wave = ledger.record(waveId, {
			assignment_id: assignment.id,
			lion_run_id: run?.id,
			ganglion_id: assignment.ganglion_id,
			ganglion_allocation_id: assignment.ganglion_allocation_id,
			outcome: "failed",
			summary,
			blockers: [message],
		});
		return { superseded: false, assignment: wave.assignments.find((a) => a.id === assignment.id) ?? current };
	});
	return result;
}

async function runOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: LionRun): Promise<RunWaveAssignmentResult> {
	const progress = createProgressUpdater((snapshot) => adapter.updateProgress?.(run.id, snapshot) ?? Promise.resolve());
	let out: { text: string; report: LionReport | null };
	try {
		out = await adapter.run(run, assignment, progress.enqueue);
		await progress.drain();
	} catch (err) {
		await progress.drain().catch(() => undefined);
		return recordWorkerError(store, adapter, waveId, assignment, run, err);
	}

	const missingReport = !out.report;
	const intendedStatus: LionRun["status"] = missingReport
		? "failed"
		: out.report?.outcome === "blocked" ? "blocked" : out.report?.outcome === "failed" ? "failed" : "completed";
	const finished = await adapter.finishRun(run.id, {
		output: out.text,
		report: out.report,
		status: missingReport ? "failed" : undefined,
		error: missingReport ? "missing WORKER_REPORT" : null,
	}).catch(() => undefined);
	const outcome = assignmentStatusFromReport(out.report, finished?.status ?? intendedStatus);
	const summary = out.report?.summary ?? (finished?.error ? `failed: ${finished.error}` : "failed: missing WORKER_REPORT");
	const blockers = out.report?.blockers ?? (finished?.error ? [finished.error] : ["missing WORKER_REPORT"]);
	return recordOwnedResult(store, waveId, assignment, run.id, {
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
	});
}

async function recordWorkerError(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: LionRun, err: unknown): Promise<RunWaveAssignmentResult> {
	const message = err instanceof Error ? err.message : String(err);
	const current = await adapter.getRun?.(run.id).catch(() => undefined);
	const cancelled = Boolean(current?.control?.cancel_requested_at);
	const finishStatus = cancelled ? "aborted" : "failed";
	const outcome: AssignmentStatus = cancelled ? "cancelled" : "failed";
	const summary = cancelled
		? `LION run cancelled${current?.control?.cancel_reason ? `: ${current.control.cancel_reason}` : ""}`
		: `LION run failed: ${message}`;
	const blockers = cancelled ? [] : [message];
	await adapter.finishRun(run.id, { output: "", report: null, status: finishStatus, error: cancelled ? (current?.control?.cancel_reason ?? "Cancelled") : message }).catch(() => undefined);
	return recordOwnedResult(store, waveId, assignment, run.id, {
		assignment_id: assignment.id,
		lion_run_id: run.id,
		ganglion_id: assignment.ganglion_id,
		ganglion_allocation_id: assignment.ganglion_allocation_id,
		outcome,
		summary,
		blockers,
	});
}

async function recordOwnedResult(store: CerebelStore, waveId: string, assignment: Assignment, runId: string, input: RecordInput): Promise<RunWaveAssignmentResult> {
	const { result } = await store.mutate((ledger) => ledger.recordIfOwned(waveId, runId, input));
	if (!result.committed) return supersededResult(assignment, runId, result.assignment, input.summary ?? "LION run result not recorded");
	return {
		assignment_id: assignment.id,
		lion_run_id: runId,
		outcome: input.outcome,
		summary: input.summary ?? "",
		blockers: input.blockers ?? [],
	};
}

function supersededResult(assignment: Assignment, runId: string | undefined, current: Assignment, localSummary: string): RunWaveAssignmentResult {
	const reason = current.lion_run_id && current.lion_run_id !== runId
		? `assignment is owned by ${current.lion_run_id}`
		: `assignment is already ${current.status}`;
	return { assignment_id: assignment.id, lion_run_id: runId, outcome: "skipped", summary: `${localSummary}; local attempt superseded because ${reason}`, blockers: [] };
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
