/** CEREBEL run_wave orchestration helper. */

import type { LionProgressSnapshot, LionReport, LionRun } from "@nervous-system/lion/extension/schema.ts";
import type { Assignment, AssignmentStatus, Wave } from "./schema.ts";
import { CerebelStore } from "./backend.ts";
import { isTerminalAssignmentStatus, normalizeParallelism, type RecordInput } from "./store.ts";

type ExactLionRun = LionRun & { incarnation_id: string };

function requireExactLionRun(run: LionRun): asserts run is ExactLionRun {
	if (typeof run.incarnation_id !== "string" || !run.incarnation_id.trim()) {
		throw new Error(`LION run ${run.id} did not provide a non-empty incarnation_id`);
	}
}

export interface RunWaveLionAdapter {
	createRun(assignment: Assignment): Promise<LionRun>;
	run(run: LionRun, assignment: Assignment, onProgress: (progress: LionProgressSnapshot) => void, signal?: AbortSignal): Promise<{ text: string; report: LionReport | null }>;
	finishRun(runId: string, result: { output: string; report: LionReport | null; status?: "completed" | "blocked" | "failed" | "aborted"; error?: string | null }): Promise<LionRun>;
	getRun?(runId: string): Promise<LionRun | undefined>;
	updateProgress?(runId: string, progress: LionProgressSnapshot): Promise<void>;
	createProgressUpdater(update: (progress: LionProgressSnapshot) => Promise<void>): { enqueue(progress: LionProgressSnapshot): void; drain(): Promise<void> };
}

export interface RunWaveOptions {
	wave_id?: string;
	max_parallel?: number;
	reservation_stale_ms?: number;
	signal?: AbortSignal;
}

export interface RunWaveAssignmentResult {
	assignment_id: string;
	lion_run_id?: string;
	lion_run_incarnation_id?: string;
	outcome: AssignmentStatus | "skipped";
	summary: string;
	blockers: string[];
}

export interface RunWaveResult {
	wave: Wave;
	assignment_results: RunWaveAssignmentResult[];
	summary: string;
}

export class RunWaveBatchError extends AggregateError {
	constructor(message: string, readonly result: RunWaveResult, readonly causes: unknown[]) {
		super(causes, message);
		this.name = "RunWaveBatchError";
	}
}

interface ReservationResult {
	wave: Wave;
	assignments: Assignment[];
}

export async function runWave(store: CerebelStore, adapter: RunWaveLionAdapter, options: RunWaveOptions = {}): Promise<RunWaveResult> {
	const results: RunWaveAssignmentResult[] = [];
	let wave = await loadWave(store, options.wave_id);
	const maxParallel = normalizeParallelism(options.max_parallel ?? wave.max_parallel);

	for (;;) {
		if (options.signal?.aborted) break;
		let reservation: ReservationResult;
		try {
			reservation = await reservePlannedAssignments(store, wave.id, maxParallel, options.reservation_stale_ms, options.signal);
		} catch (error) {
			throwPartialIfResults("run_wave reservation bookkeeping failed", error, wave, results);
			throw error;
		}
		wave = reservation.wave;
		if (options.signal?.aborted && reservation.assignments.length) {
			try { await releaseReservations(store, wave.id, reservation.assignments, "host aborted before LION creation"); }
			catch (error) { throw new RunWaveBatchError(`run_wave reservation release failed: ${errorMessage(error)}`, finalizeRunWave(wave, results), [error]); }
			break;
		}
		if (wave.assignments.some((a) => a.status === "blocked" || a.status === "failed")) break;
		if (!reservation.assignments.length) break;

		const settled = await Promise.allSettled(reservation.assignments.map((assignment) => createAndRunOne(store, adapter, wave.id, assignment, options.signal)));
		const failures: unknown[] = [];
		for (const outcome of settled) {
			if (outcome.status === "fulfilled") results.push(outcome.value);
			else failures.push(outcome.reason);
		}
		try { wave = await loadWave(store, wave.id); }
		catch (error) {
			const allFailures = [...failures, error];
			throw new RunWaveBatchError(`run_wave post-batch bookkeeping failed: ${allFailures.map(errorMessage).join("; ")}`, finalizeRunWave(wave, results), allFailures);
		}
		if (failures.length) {
			const partial = finalizeRunWave(wave, results);
			throw new RunWaveBatchError(`run_wave batch failed after all launched workers settled: ${failures.map(errorMessage).join("; ")}`, partial, failures);
		}
	}

	try { wave = await loadWave(store, wave.id); }
	catch (error) {
		throwPartialIfResults("run_wave final bookkeeping failed", error, wave, results);
		throw error;
	}
	return finalizeRunWave(wave, results);
}

function throwPartialIfResults(message: string, error: unknown, wave: Wave, results: RunWaveAssignmentResult[]): void {
	if (results.length) throw new RunWaveBatchError(`${message}: ${errorMessage(error)}`, finalizeRunWave(wave, results), [error]);
}

function finalizeRunWave(wave: Wave, completedResults: RunWaveAssignmentResult[]): RunWaveResult {
	const results = [...completedResults];
	const seen = new Set(results.map((result) => result.assignment_id));
	for (const assignment of wave.assignments) {
		if (assignment.status === "planned" && !seen.has(assignment.id)) {
			results.push({ assignment_id: assignment.id, outcome: "skipped", summary: "not dispatched in this run_wave invocation", blockers: [] });
		}
	}
	return { wave, assignment_results: results, summary: summarizeRunWave(wave, results) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function releaseReservations(store: CerebelStore, waveId: string, assignments: Assignment[], reason: string): Promise<void> {
	await store.mutate((ledger) => ledger.releaseReservations(waveId, assignments.map((assignment) => assignment.id), reason));
}

async function reservePlannedAssignments(store: CerebelStore, waveId: string, maxParallel: number, reservationStaleMs = 30_000, signal?: AbortSignal): Promise<ReservationResult> {
	if (signal?.aborted) return { wave: await loadWave(store, waveId), assignments: [] };
	const { result } = await store.mutate((ledger) => {
		const currentBeforeRecovery = ledger.get(waveId);
		if (!currentBeforeRecovery) throw new Error(`wave ${waveId} not found`);
		if (signal?.aborted) return { wave: currentBeforeRecovery, assignments: [] };
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

async function createAndRunOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, signal?: AbortSignal): Promise<RunWaveAssignmentResult> {
	if (signal?.aborted) {
		await releaseReservations(store, waveId, [assignment], "host aborted before LION creation");
		return { assignment_id: assignment.id, outcome: "skipped", summary: "host aborted before LION creation", blockers: [] };
	}
	let run: ExactLionRun | undefined;
	let linkedAssignment: Assignment | undefined;
	let abortCleanupAttempted = false;
	try {
		const createdRun = await adapter.createRun(assignment);
		requireExactLionRun(createdRun);
		run = createdRun;
		if (signal?.aborted) {
			abortCleanupAttempted = true;
			await adapter.finishRun(run.id, { output: "", report: null, status: "aborted", error: "Host aborted before LION launch" });
			await releaseReservations(store, waveId, [assignment], "host aborted before LION launch");
			return { assignment_id: assignment.id, lion_run_id: run.id, lion_run_incarnation_id: run.incarnation_id, outcome: "skipped", summary: "host aborted before LION launch", blockers: [] };
		}
		const { result: linkedWave } = await store.mutate((ledger) => ledger.dispatch(waveId, {
			links: [{
				assignment_id: assignment.id,
				lion_run_id: createdRun.id,
				lion_run_incarnation_id: createdRun.incarnation_id,
				ganglion_id: assignment.ganglion_id,
				ganglion_allocation_id: assignment.ganglion_allocation_id,
			}],
		}));
		linkedAssignment = linkedWave.assignments.find((a) => a.id === assignment.id) ?? assignment;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (abortCleanupAttempted && run) throw new Error(`LION cleanup failed for unlinked ${run.id} after host abort: ${message}`, { cause: err });
		const summary = run ? `LION run setup failed: ${message}` : `LION run creation failed: ${message}`;
		if (run) {
			try {
				await adapter.finishRun(run.id, { output: "", report: null, status: "failed", error: `CEREBEL dispatch/link failed after run creation: ${message}` });
			} catch (cleanupErr) {
				throw new Error(`LION cleanup failed for unlinked ${run.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}; setup failure: ${message}`, { cause: cleanupErr });
			}
		}
		const recovery = await recoverSetupFailure(store, waveId, assignment, run, summary, message);
		if (recovery.superseded) return supersededResult(assignment, run, recovery.assignment, summary);
		return { assignment_id: assignment.id, lion_run_id: run?.id, lion_run_incarnation_id: run?.incarnation_id, outcome: "failed", summary, blockers: [message] };
	}
	if (!run || !linkedAssignment) throw new Error(`LION run setup did not produce a linked run for ${assignment.id}`);
	return runOne(store, adapter, waveId, linkedAssignment, run, signal);
}

async function recoverSetupFailure(store: CerebelStore, waveId: string, assignment: Assignment, run: ExactLionRun | undefined, summary: string, message: string): Promise<{ superseded: boolean; assignment: Assignment }> {
	const { result } = await store.mutate((ledger) => {
		const current = ledger.get(waveId)?.assignments.find((a) => a.id === assignment.id);
		if (!current) throw new Error(`assignment ${assignment.id} not found in wave ${waveId} during LION setup recovery`);
		const ownedByOtherRun = Boolean(current.lion_run_id && (current.lion_run_id !== run?.id
			|| (current.lion_run_incarnation_id ?? null) !== (run?.incarnation_id ?? null)));
		const terminal = isTerminalAssignmentStatus(current.status);
		if (ownedByOtherRun || terminal) return { superseded: true, assignment: current };
		const wave = ledger.record(waveId, {
			assignment_id: assignment.id,
			lion_run_id: run?.id,
			lion_run_incarnation_id: run?.incarnation_id,
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

async function runOne(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: ExactLionRun, signal?: AbortSignal): Promise<RunWaveAssignmentResult> {
	if (signal?.aborted) return recordWorkerError(store, adapter, waveId, assignment, run, new Error("Host aborted before LION launch"), signal);
	const progress = adapter.createProgressUpdater((snapshot) => adapter.updateProgress?.(run.id, snapshot) ?? Promise.resolve());
	let out: { text: string; report: LionReport | null };
	try {
		out = await adapter.run(run, assignment, progress.enqueue, signal);
		if (signal?.aborted) throw new Error("Host aborted run_wave");
		await progress.drain();
		if (signal?.aborted) throw new Error("Host aborted run_wave during progress drain");
	} catch (err) {
		await progress.drain().catch(() => undefined);
		return recordWorkerError(store, adapter, waveId, assignment, run, err, signal);
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
	});
	const outcome = assignmentStatusFromReport(out.report, finished.status ?? intendedStatus);
	const summary = out.report?.summary ?? (finished.error ? `failed: ${finished.error}` : "failed: missing WORKER_REPORT");
	const blockers = out.report?.blockers ?? (finished.error ? [finished.error] : ["missing WORKER_REPORT"]);
	return recordOwnedResult(store, waveId, assignment, run, {
		assignment_id: assignment.id,
		lion_run_id: run.id,
		lion_run_incarnation_id: run.incarnation_id,
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

async function recordWorkerError(store: CerebelStore, adapter: RunWaveLionAdapter, waveId: string, assignment: Assignment, run: ExactLionRun, err: unknown, signal?: AbortSignal): Promise<RunWaveAssignmentResult> {
	const message = err instanceof Error ? err.message : String(err);
	const current = await adapter.getRun?.(run.id).catch(() => undefined);
	const durableCancellation = Boolean(current?.control?.cancel_requested_at);
	const hostAborted = Boolean(signal?.aborted);
	const cancelled = durableCancellation || hostAborted;
	const finishStatus = cancelled ? "aborted" : "failed";
	const outcome: AssignmentStatus = cancelled ? "cancelled" : "failed";
	const summary = durableCancellation
		? `LION run cancelled${current?.control?.cancel_reason ? `: ${current.control.cancel_reason}` : ""}`
		: hostAborted ? "LION run host aborted" : `LION run failed: ${message}`;
	const blockers = cancelled ? [] : [message];
	const finishError = durableCancellation ? (current?.control?.cancel_reason ?? "Cancelled") : hostAborted ? "Host aborted run_wave" : message;
	await adapter.finishRun(run.id, { output: "", report: null, status: finishStatus, error: finishError });
	return recordOwnedResult(store, waveId, assignment, run, {
		assignment_id: assignment.id,
		lion_run_id: run.id,
		lion_run_incarnation_id: run.incarnation_id,
		ganglion_id: assignment.ganglion_id,
		ganglion_allocation_id: assignment.ganglion_allocation_id,
		outcome,
		summary,
		blockers,
	});
}

async function recordOwnedResult(store: CerebelStore, waveId: string, assignment: Assignment, run: ExactLionRun, input: RecordInput & { assignment_id: string }): Promise<RunWaveAssignmentResult> {
	const { result } = await store.mutate((ledger) => ledger.recordIfOwned(waveId, run.id, run.incarnation_id, input));
	if (!result.committed) return supersededResult(assignment, run, result.assignment, input.summary ?? "LION run result not recorded");
	return {
		assignment_id: assignment.id,
		lion_run_id: run.id,
		lion_run_incarnation_id: run.incarnation_id,
		outcome: input.outcome,
		summary: input.summary ?? "",
		blockers: input.blockers ?? [],
	};
}

function supersededResult(assignment: Assignment, run: Pick<ExactLionRun, "id" | "incarnation_id"> | undefined, current: Assignment, localSummary: string): RunWaveAssignmentResult {
	const differentOwner = current.lion_run_id && (current.lion_run_id !== run?.id
		|| (current.lion_run_incarnation_id ?? null) !== (run?.incarnation_id ?? null));
	const reason = differentOwner
		? `assignment is owned by ${current.lion_run_id}/${current.lion_run_incarnation_id}`
		: `assignment is already ${current.status}`;
	return {
		assignment_id: assignment.id,
		lion_run_id: run?.id,
		lion_run_incarnation_id: run?.incarnation_id,
		outcome: "skipped",
		summary: `${localSummary}; local attempt superseded because ${reason}`,
		blockers: [],
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

export function summarizeRunWave(wave: Wave, results: RunWaveAssignmentResult[]): string {
	const completed = wave.assignments.filter((a) => a.status === "completed" || a.status === "partial").length;
	const blocked = wave.assignments.filter((a) => a.status === "blocked").length;
	const failed = wave.assignments.filter((a) => a.status === "failed").length;
	const planned = wave.assignments.filter((a) => a.status === "planned").length;
	const ran = results.filter((r) => r.outcome !== "skipped").length;
	return `${wave.id}: ${wave.status}; ran ${ran}; completed ${completed}/${wave.assignments.length}; blocked ${blocked}; failed ${failed}; planned ${planned}`;
}
