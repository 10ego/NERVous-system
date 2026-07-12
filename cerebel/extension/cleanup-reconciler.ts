/** Fresh-process reconciliation for durable cleanup-pending settlement obligations. */

import type { LionRun } from "@nervous-system/lion/extension/schema.ts";
import type { LionLedger } from "@nervous-system/lion/extension/store.ts";
import type { GanglionLedger } from "../../ganglion/extension/store.ts";
import { CerebelStore } from "./backend.ts";
import type { Assignment, AssignmentStatus } from "./schema.ts";
import { isTerminalAssignmentStatus, type RecordInput } from "./store.ts";

interface QueryStore<TLedger> {
	query<T>(fn: (ledger: TLedger) => T): Promise<{ result: T }>;
}
interface MutableStore<TLedger> extends QueryStore<TLedger> {
	mutate<T>(fn: (ledger: TLedger) => T): Promise<{ result: T }>;
}

export interface CleanupSettlementReconcilerDeps {
	cerebelStore?: CerebelStore;
	lionStore?: MutableStore<LionLedger>;
	ganglionStore?: MutableStore<GanglionLedger>;
	isLionPidAlive?: (pid: number) => boolean;
	getLionProcessIdentity?: (pid: number) => string | null;
	activeLionRunRefs?: Iterable<Pick<LionRun, "id" | "incarnation_id">>;
	lionReconcileNowMs?: number;
	lionReconcileStaleAfterMs?: number;
}

export interface CleanupSettlementReconcileResult {
	wave_id: string;
	assignment_id: string;
	lion_run_id: string;
	lion_run_incarnation_id: string;
	settled: boolean;
	reason: string;
}

function terminalAssignmentInput(assignment: Assignment, run: LionRun): RecordInput & { assignment_id: string } {
	const cancelled = run.status === "aborted";
	const outcome: AssignmentStatus = cancelled
		? "cancelled"
		: !run.report ? "failed"
			: run.report.outcome === "blocked" ? "blocked"
				: run.report.outcome === "failed" ? "failed"
					: run.report.outcome === "partial" ? "partial"
						: run.status === "blocked" ? "blocked"
							: run.status === "failed" ? "failed" : "completed";
	const summary = run.report?.summary
		?? (cancelled ? `LION run cancelled${run.error ? `: ${run.error}` : ""}` : `LION run failed: ${run.error ?? "missing WORKER_REPORT"}`);
	return {
		assignment_id: assignment.id,
		lion_run_id: run.id,
		lion_run_incarnation_id: run.incarnation_id!,
		ganglion_id: assignment.ganglion_id,
		ganglion_allocation_id: assignment.ganglion_allocation_id,
		outcome,
		summary,
		changed_files: run.report?.changed_files ?? [],
		tests_run: run.report?.tests_run ?? [],
		blockers: run.report?.blockers ?? (cancelled ? [] : [run.error ?? "missing WORKER_REPORT"]),
		next_steps: run.report?.next_steps ?? [],
	};
}

function ganglionStatus(status: AssignmentStatus): "completed" | "blocked" | "failed" | "cancelled" {
	return status === "blocked" ? "blocked" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";
}

function hasMatchingCleanupEvidence(run: LionRun, expected: { lion_run_id: string; lion_run_incarnation_id: string }): boolean {
	const control = run.control;
	const observation = control?.cleanup_pending;
	if (!observation) return false;
	return run.id === expected.lion_run_id
		&& run.incarnation_id === expected.lion_run_incarnation_id
		&& observation.incarnation_id === expected.lion_run_incarnation_id
		&& Number.isSafeInteger(observation.pid)
		&& observation.pid > 0
		&& control?.pid === observation.pid
		&& (control?.pgid ?? null) === observation.pgid
		&& (control?.process_identity ?? null) === observation.process_identity;
}

/**
 * Settles only exact terminal LION incarnations. Missing runs and replacement
 * incarnations are ignored without mutation. Repeated calls are idempotent.
 */
export async function reconcileCleanupPendingSettlements(
	cwd: string,
	deps: CleanupSettlementReconcilerDeps = {},
): Promise<CleanupSettlementReconcileResult[]> {
	const cerebelStore = deps.cerebelStore ?? CerebelStore.fromCwd(cwd);
	const obligations = (await cerebelStore.query((ledger) => ledger.cleanupPendingSettlements())).result;
	if (!obligations.length) return [];
	let lionStore = deps.lionStore;
	let isLionPidAlive = deps.isLionPidAlive;
	let getLionProcessIdentity = deps.getLionProcessIdentity;
	let activeLionRunRefs = deps.activeLionRunRefs;
	if (!lionStore) {
		try {
			const [{ LionStore }, subprocess, activeRuns] = await Promise.all([
				import("@nervous-system/lion/extension/backend.ts"),
				import("@nervous-system/lion/extension/subprocess.ts"),
				import("@nervous-system/lion/extension/active-runs.ts"),
			]);
			const loadedLionStore = LionStore.fromCwd(cwd);
			lionStore = loadedLionStore;
			isLionPidAlive ??= subprocess.isPidAlive;
			getLionProcessIdentity ??= subprocess.getProcessIdentity;
			activeLionRunRefs ??= activeRuns.getActiveRunRefs(loadedLionStore.namespaceId);
		} catch {
			return [];
		}
	}
	if (isLionPidAlive) {
		await lionStore.mutate((ledger) => ledger.reconcileControls(isLionPidAlive!, {
			active_run_refs: activeLionRunRefs,
			target_run_refs: obligations.map((obligation) => ({ id: obligation.settlement.lion_run_id, incarnation_id: obligation.settlement.lion_run_incarnation_id })),
			get_process_identity: getLionProcessIdentity,
			now_ms: deps.lionReconcileNowMs,
			stale_after_ms: deps.lionReconcileStaleAfterMs,
		}));
	}
	const results: CleanupSettlementReconcileResult[] = [];
	for (const obligation of obligations) {
		const expected = obligation.settlement;
		if (obligation.assignment.ganglion_id !== expected.ganglion_id
			|| obligation.assignment.ganglion_allocation_id !== expected.ganglion_allocation_id) {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "CEREBEL assignment capacity provenance differs from its cleanup obligation" });
			continue;
		}
		const run = (await lionStore.query((ledger) => ledger.get(expected.lion_run_id))).result;
		if (!run || run.incarnation_id !== expected.lion_run_incarnation_id) {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: run ? "exact LION incarnation is not terminal" : "exact LION run is unavailable" });
			continue;
		}
		if (!hasMatchingCleanupEvidence(run, expected)) {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "exact LION run lacks matching durable cleanup evidence; capacity retained without exit proof" });
			continue;
		}
		if (run.status === "queued" || run.status === "running") {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "exact LION incarnation is not terminal" });
			continue;
		}
		const input = terminalAssignmentInput(obligation.assignment, run);
		const { result: cerebelResult } = await cerebelStore.mutate((ledger) => ledger.recordIfOwned(
			obligation.wave_id,
			expected.lion_run_id,
			expected.lion_run_incarnation_id,
			input,
		));
		const sameExactTerminal = cerebelResult.assignment.lion_run_id === expected.lion_run_id
			&& cerebelResult.assignment.lion_run_incarnation_id === expected.lion_run_incarnation_id
			&& isTerminalAssignmentStatus(cerebelResult.assignment.status);
		if (!cerebelResult.committed && !sameExactTerminal) {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "CEREBEL assignment ownership was superseded" });
			continue;
		}

		const ganglionId = expected.ganglion_id;
		const allocationId = expected.ganglion_allocation_id;
		if (allocationId) {
			if (!ganglionId) {
				results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "GANGLION allocation has no ganglion id" });
				continue;
			}
			let ganglionStore = deps.ganglionStore;
			if (!ganglionStore) {
				try {
					const { GanglionStore } = await import("../../ganglion/extension/backend.ts");
					ganglionStore = GanglionStore.fromCwd(cwd);
				} catch {
					results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "GANGLION runtime unavailable" });
					continue;
				}
			}
			const { result: linkResult } = await ganglionStore.mutate((ledger) => ledger.linkRunIfUnlinked(
				ganglionId,
				allocationId,
				expected.lion_run_id,
				expected.lion_run_incarnation_id,
			));
			if (!linkResult.committed) {
				results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "GANGLION allocation provenance was superseded" });
				continue;
			}
			const { result: allocationResult } = await ganglionStore.mutate((ledger) => ledger.recordIfOwned(
				ganglionId,
				allocationId,
				expected.lion_run_id,
				expected.lion_run_incarnation_id,
				{ status: ganglionStatus(input.outcome), summary: input.summary },
			));
			const allocationSettled = allocationResult.allocation.lion_run_id === expected.lion_run_id
				&& allocationResult.allocation.lion_run_incarnation_id === expected.lion_run_incarnation_id
				&& ["completed", "blocked", "failed", "cancelled"].includes(allocationResult.allocation.status);
			if (!allocationResult.committed && !allocationSettled) {
				results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "GANGLION allocation ownership was superseded" });
				continue;
			}
		}
		const { result: completed } = await cerebelStore.mutate((ledger) => ledger.completeCleanupPendingSettlementIfOwned(obligation.wave_id, obligation.assignment.id, expected.lion_run_id, expected.lion_run_incarnation_id));
		if (!completed) {
			results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: false, reason: "CEREBEL cleanup obligation changed before completion" });
			continue;
		}
		results.push({ wave_id: obligation.wave_id, assignment_id: obligation.assignment.id, lion_run_id: expected.lion_run_id, lion_run_incarnation_id: expected.lion_run_incarnation_id, settled: true, reason: "exact cleanup settlement reconciled" });
	}
	return results;
}
