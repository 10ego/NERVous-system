/**
 * In-memory ownership registry for live LION workers.
 *
 * Persisted PID/PGID values are observational metadata only. They are never
 * sufficient authority to signal a process after restart or stale ledger
 * recovery. Only a currently registered owner from the matching durable LION
 * namespace may deliver cancellation to a live worker.
 */

import { randomUUID } from "node:crypto";
import type { LionLedger } from "./store.ts";
import { isTerminalLionStatus, type LionRun, type LionRunnerMode } from "./schema.ts";
import { getProcessIdentity, isPidAlive, type LionProcessInfo } from "./subprocess.ts";

export type ActiveCancelSignal = "SIGTERM" | "SIGKILL";

export interface ActiveRunScope {
	namespaceId: string;
	runId: string;
	incarnationId?: string | null;
}

export interface ActiveRunProcessInfo extends Omit<LionProcessInfo, "cancel"> {
	/** Return true only when the owned cancellation primitive was actually issued. */
	cancel?: (signal: ActiveCancelSignal) => Promise<boolean> | boolean;
	isAlive?: () => boolean;
}

export interface ActiveRunOwner extends ActiveRunScope {
	ownerId: string;
}

interface ActiveRunEntry extends ActiveRunOwner {
	runnerMode?: LionRunnerMode | null;
	state: "starting" | "running" | "control_closed" | "exited";
	pid?: number;
	pgid?: number | null;
	cancel?: (signal: ActiveCancelSignal) => Promise<boolean> | boolean;
	isAlive?: () => boolean;
	cancelInFlight: Map<ActiveCancelSignal, Promise<ActiveCancelResult>>;
	cancelDelivered: Map<ActiveCancelSignal, ActiveCancelResult & { delivered: true }>;
	escalationTimer?: ReturnType<typeof setTimeout> | null;
}

export type ActiveCancelResult =
	| { delivered: true; owner: ActiveRunOwner; pid?: number; pgid?: number | null }
	| { delivered: false; owner?: ActiveRunOwner; reason: "not_attached" | "owner_replaced" | "already_exited" | "not_alive" | "no_cancel_handle" | "not_signaled" | "delivery_failed"; error?: string; pid?: number; pgid?: number | null };

const activeRuns = new Map<string, ActiveRunEntry>();
const MAX_CONCURRENT_CANCELLATION_DELIVERIES = 8;

async function mapBounded<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runWorker = async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
	return results;
}

function scopeKey(scope: ActiveRunScope): string {
	return `${scope.namespaceId}\u0000${scope.runId}`;
}

export function beginActiveRun(scope: ActiveRunScope, runnerMode?: LionRunnerMode | null): ActiveRunOwner {
	const key = scopeKey(scope);
	if (activeRuns.has(key)) throw new Error(`active LION owner already exists for ${scope.runId} in ${scope.namespaceId}`);
	const owner: ActiveRunOwner = { ...scope, ownerId: randomUUID() };
	activeRuns.set(key, {
		...owner,
		runnerMode,
		state: "starting",
		cancelInFlight: new Map(),
		cancelDelivered: new Map(),
	});
	return owner;
}

export function attachActiveRunProcess(owner: ActiveRunOwner, info: ActiveRunProcessInfo): void {
	const entry = activeRuns.get(scopeKey(owner));
	if (!entry || entry.ownerId !== owner.ownerId) return;
	entry.state = "running";
	entry.pid = info.pid;
	entry.pgid = info.pgid;
	entry.cancel = info.cancel;
	entry.isAlive = info.isAlive;
}

export function markActiveRunControlClosed(owner: ActiveRunOwner): void {
	const entry = activeRuns.get(scopeKey(owner));
	if (!entry || entry.ownerId !== owner.ownerId || entry.state === "exited") return;
	entry.state = "control_closed";
}

export function markActiveRunExited(owner: ActiveRunOwner): void {
	const entry = activeRuns.get(scopeKey(owner));
	if (!entry || entry.ownerId !== owner.ownerId) return;
	entry.state = "exited";
}

export function finishActiveRun(owner: ActiveRunOwner): void {
	const key = scopeKey(owner);
	const entry = activeRuns.get(key);
	if (entry?.ownerId === owner.ownerId) {
		if (entry.escalationTimer) clearTimeout(entry.escalationTimer);
		activeRuns.delete(key);
	}
}

export function getActiveRunIds(namespaceId: string): string[] {
	return Array.from(activeRuns.values()).filter((entry) => entry.namespaceId === namespaceId).map((entry) => entry.runId);
}

export function getActiveRunRefs(namespaceId: string): Array<{ id: string; incarnation_id: string | null }> {
	return Array.from(activeRuns.values())
		.filter((entry) => entry.namespaceId === namespaceId)
		.map((entry) => ({ id: entry.runId, incarnation_id: entry.incarnationId ?? null }));
}

export function isActiveRunOwner(owner: ActiveRunOwner): boolean {
	return activeRuns.get(scopeKey(owner))?.ownerId === owner.ownerId;
}

export function isActiveRunAttached(scope: ActiveRunScope, runnerMode?: LionRunnerMode): boolean {
	const entry = activeRuns.get(scopeKey(scope));
	if (!entry || !Object.prototype.hasOwnProperty.call(scope, "incarnationId") || (entry.incarnationId ?? null) !== (scope.incarnationId ?? null)) return false;
	if (runnerMode && entry.runnerMode !== runnerMode) return false;
	if (entry.state !== "running") return false;
	return entry.isAlive ? entry.isAlive() : true;
}

export function isExactActiveRunLive(scope: ActiveRunScope): boolean {
	const entry = activeRuns.get(scopeKey(scope));
	if (!entry || !Object.prototype.hasOwnProperty.call(scope, "incarnationId") || (entry.incarnationId ?? null) !== (scope.incarnationId ?? null) || entry.state === "exited") return false;
	if (!entry.isAlive) return true;
	try { return entry.isAlive(); }
	catch { return true; }
}

export async function cancelActiveRun(scope: ActiveRunScope | ActiveRunOwner, signal: ActiveCancelSignal = "SIGTERM"): Promise<ActiveCancelResult> {
	const entry = activeRuns.get(scopeKey(scope));
	if (!entry) return { delivered: false, reason: "not_attached" };
	const ownerScoped = "ownerId" in scope;
	if (ownerScoped && entry.ownerId !== scope.ownerId) return { delivered: false, reason: "owner_replaced", pid: entry.pid, pgid: entry.pgid };
	const hasIncarnation = Object.prototype.hasOwnProperty.call(scope, "incarnationId");
	if ((!ownerScoped && !hasIncarnation) || (hasIncarnation && (entry.incarnationId ?? null) !== (scope.incarnationId ?? null))) {
		return { delivered: false, reason: "owner_replaced", pid: entry.pid, pgid: entry.pgid };
	}
	const delivered = entry.cancelDelivered.get(signal);
	if (delivered) return delivered;
	const inFlight = entry.cancelInFlight.get(signal);
	if (inFlight) return inFlight;

	const attempt = (async (): Promise<ActiveCancelResult> => {
		const owner = { namespaceId: entry.namespaceId, runId: entry.runId, incarnationId: entry.incarnationId, ownerId: entry.ownerId };
		try {
			if (entry.state === "exited") return { delivered: false, owner, reason: "already_exited", pid: entry.pid, pgid: entry.pgid };
			if (entry.isAlive && !entry.isAlive()) return { delivered: false, owner, reason: "not_alive", pid: entry.pid, pgid: entry.pgid };
			if (!entry.cancel) return { delivered: false, owner, reason: "no_cancel_handle", pid: entry.pid, pgid: entry.pgid };
			const signaled = await entry.cancel(signal);
			if (!signaled) return { delivered: false, owner, reason: "not_signaled", pid: entry.pid, pgid: entry.pgid };
			const result = { delivered: true, owner: { namespaceId: entry.namespaceId, runId: entry.runId, incarnationId: entry.incarnationId, ownerId: entry.ownerId }, pid: entry.pid, pgid: entry.pgid } as const;
			entry.cancelDelivered.set(signal, result);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { delivered: false, owner, reason: "delivery_failed", error: message.slice(0, 1_000), pid: entry.pid, pgid: entry.pgid };
		}
	})().finally(() => entry.cancelInFlight.delete(signal));
	entry.cancelInFlight.set(signal, attempt);
	return attempt;
}

export function scheduleActiveRunEscalation(owner: ActiveRunOwner, delayMs = 5000): boolean {
	const entry = activeRuns.get(scopeKey(owner));
	if (!entry || entry.ownerId !== owner.ownerId || entry.state === "exited" || entry.escalationTimer) return false;
	entry.escalationTimer = setTimeout(() => {
		entry.escalationTimer = null;
		void cancelActiveRun(owner, "SIGKILL").catch(() => undefined);
	}, Math.max(0, delayMs));
	entry.escalationTimer.unref?.();
	return true;
}

export async function cancelActiveRunWithEscalation(scope: ActiveRunScope | ActiveRunOwner, signal: ActiveCancelSignal = "SIGTERM", escalationDelayMs = 5000): Promise<ActiveCancelResult> {
	const result = await cancelActiveRun(scope, signal);
	if (signal === "SIGTERM" && result.delivered) scheduleActiveRunEscalation(result.owner, escalationDelayMs);
	return result;
}

/** Replay a durable cancellation that arrived before the live process handle attached. */
export async function replayPendingCancellation(owner: ActiveRunOwner, store: {
	query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
	mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
}, escalationDelayMs = 5000): Promise<ActiveCancelResult | null> {
	if (!isActiveRunOwner(owner)) return null;
	const current = (await store.query((ledger) => ledger.get(owner.runId))).result;
	if (!current?.control?.cancel_requested_at) return null;
	if (current.control.cancel_delivery_status === "delivered" || current.control.cancel_delivery_status === "not_needed") return null;
	const result = await cancelActiveRunWithEscalation(owner, "SIGTERM", escalationDelayMs);
	await store.mutate((ledger) => {
		const current = ledger.get(owner.runId);
		return isActiveRunOwner(owner) && current
			? ledger.markCancelDeliveryIfCurrent(owner.runId, owner.incarnationId, result.delivered ? "delivered" : result.reason, result.delivered ? undefined : result.error).run
			: current;
	});
	return result;
}

export interface LionControlStore {
	namespaceId: string;
	query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
	mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
	mutateMaybe<T>(fn: (ledger: LionLedger) => { result: T; changed: boolean }): Promise<{ result: T; changed: boolean }>;
}

export interface RunCancellationResult {
	run: LionRun | undefined;
	settled: boolean;
	superseded: boolean;
	delivery?: ActiveCancelResult;
}

export interface RunCancellationRequest {
	runId: string;
	reason?: string | null;
	expectedIncarnationId?: string | null;
	expectIncarnation?: boolean;
}

/** Admit all requests in one ledger transaction, deliver controls outside the lock, then persist all delivery outcomes together. */
export async function requestRunCancellations(store: LionControlStore, requests: RunCancellationRequest[]): Promise<RunCancellationResult[]> {
	if (!requests.length) return [];
	const admissions = (await store.mutate((ledger) => {
		ledger.reconcileControls(isPidAlive, { active_run_refs: getActiveRunRefs(store.namespaceId), get_process_identity: getProcessIdentity });
		return requests.map((request) => {
			const current = ledger.get(request.runId);
			if (!current) return { kind: "missing" as const, request };
			if (request.expectIncarnation && (current.incarnation_id ?? null) !== (request.expectedIncarnationId ?? null)) {
				return { kind: "superseded" as const, run: current };
			}
			return { kind: "requested" as const, requested: ledger.requestCancel(request.runId, request.reason) };
		});
	})).result;

	const deliveries = await mapBounded(admissions, MAX_CONCURRENT_CANCELLATION_DELIVERIES, async (admission) => {
		if (admission.kind !== "requested" || admission.requested.already_terminal || !admission.requested.signal) return undefined;
		const run = admission.requested.run;
		const scope: ActiveRunScope = { namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id ?? null };
		return cancelActiveRunWithEscalation(scope, admission.requested.signal);
	});

	const deliveryIndexes = admissions.flatMap((admission, index) => admission.kind === "requested" && deliveries[index] ? [index] : []);
	const persistedByIndex = new Map<number, { run: LionRun | undefined; committed: boolean }>();
	if (deliveryIndexes.length) {
		const persisted = (await store.mutate((ledger) => deliveryIndexes.map((index) => {
			const admission = admissions[index]!;
			if (admission.kind !== "requested") throw new Error("invalid cancellation admission index");
			const delivery = deliveries[index]!;
			const current = ledger.get(admission.requested.run.id);
			return current
				? ledger.markCancelDeliveryIfCurrent(admission.requested.run.id, admission.requested.run.incarnation_id, delivery.delivered ? "delivered" : delivery.reason, delivery.delivered ? undefined : delivery.error)
				: { run: undefined, committed: false };
		}))).result;
		deliveryIndexes.forEach((index, offset) => persistedByIndex.set(index, persisted[offset]!));
	}

	return admissions.map((admission, index): RunCancellationResult => {
		if (admission.kind === "missing") {
			const exactOwnerLive = Boolean(admission.request.expectIncarnation && isExactActiveRunLive({ namespaceId: store.namespaceId, runId: admission.request.runId, incarnationId: admission.request.expectedIncarnationId ?? null }));
			return { run: undefined, settled: !exactOwnerLive, superseded: !exactOwnerLive };
		}
		if (admission.kind === "superseded") return { run: admission.run, settled: true, superseded: true };
		const requested = admission.requested;
		const delivery = deliveries[index];
		if (!delivery) return { run: requested.run, settled: true, superseded: false };
		const persisted = persistedByIndex.get(index)!;
		const terminal = Boolean(persisted.run && isTerminalLionStatus(persisted.run.status));
		return { run: persisted.run, settled: !persisted.committed || terminal, superseded: !persisted.committed, delivery };
	});
}

export async function requestRunCancellation(
	store: LionControlStore,
	runId: string,
	reason?: string | null,
	options: { expectedIncarnationId?: string | null } = {},
): Promise<RunCancellationResult> {
	return (await requestRunCancellations(store, [{
		runId,
		reason,
		expectedIncarnationId: options.expectedIncarnationId,
		expectIncarnation: Object.prototype.hasOwnProperty.call(options, "expectedIncarnationId"),
	}]))[0]!;
}

export async function waitForRunSettlements(
	store: LionControlStore,
	runs: Array<Pick<LionRun, "id" | "incarnation_id">>,
	timeoutMs = 15_000,
	pollMs = 100,
	maxPollMs = 1_000,
): Promise<RunCancellationResult[]> {
	if (!runs.length) return [];
	const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 15_000;
	const boundedPoll = Number.isFinite(pollMs) ? Math.max(1, pollMs) : 100;
	const boundedMaxPoll = Number.isFinite(maxPollMs) ? Math.max(boundedPoll, maxPollMs) : 1_000;
	let nextPoll = boundedPoll;
	const deadline = Date.now() + boundedTimeout;
	for (;;) {
		const { result: currentRuns } = await store.mutateMaybe((ledger) => {
			const changed = ledger.reconcileControls(isPidAlive, { active_run_refs: getActiveRunRefs(store.namespaceId), get_process_identity: getProcessIdentity });
			return { result: runs.map((run) => ledger.get(run.id)), changed: changed.length > 0 };
		});
		const results = runs.map((run, index): RunCancellationResult => {
			const current = currentRuns[index];
			if (!current || (current.incarnation_id ?? null) !== (run.incarnation_id ?? null)) {
				const exactOwnerLive = !current && isExactActiveRunLive({ namespaceId: store.namespaceId, runId: run.id, incarnationId: run.incarnation_id ?? null });
				return { run: current, settled: !exactOwnerLive, superseded: !exactOwnerLive };
			}
			return {
				run: current,
				settled: isTerminalLionStatus(current.status),
				superseded: false,
			};
		});
		const remaining = deadline - Date.now();
		if (results.every((result) => result.settled) || remaining <= 0) return results;
		await new Promise((resolve) => setTimeout(resolve, Math.min(nextPoll, remaining)));
		nextPoll = Math.min(boundedMaxPoll, nextPoll * 2);
	}
}

export async function waitForRunSettlement(store: LionControlStore, run: Pick<LionRun, "id" | "incarnation_id">, timeoutMs = 15_000, pollMs = 100, maxPollMs = 1_000): Promise<RunCancellationResult> {
	return (await waitForRunSettlements(store, [run], timeoutMs, pollMs, maxPollMs))[0]!;
}

export function clearActiveRunsForTests(): void {
	for (const entry of activeRuns.values()) if (entry.escalationTimer) clearTimeout(entry.escalationTimer);
	activeRuns.clear();
}
