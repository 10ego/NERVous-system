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
import type { LionRun, LionRunnerMode } from "./schema.ts";
import type { LionProcessInfo } from "./subprocess.ts";

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
	registeredAt: string;
	state: "starting" | "running" | "exited";
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
	| { delivered: false; owner?: ActiveRunOwner; reason: "not_attached" | "owner_replaced" | "already_exited" | "not_alive" | "no_cancel_handle" | "not_signaled"; pid?: number; pgid?: number | null };

const activeRuns = new Map<string, ActiveRunEntry>();

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
		registeredAt: new Date().toISOString(),
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

export function isActiveRunOwner(owner: ActiveRunOwner): boolean {
	return activeRuns.get(scopeKey(owner))?.ownerId === owner.ownerId;
}

export function isActiveRunAttached(scope: ActiveRunScope, runnerMode?: LionRunnerMode): boolean {
	const entry = activeRuns.get(scopeKey(scope));
	if (!entry) return false;
	if (runnerMode && entry.runnerMode !== runnerMode) return false;
	if (entry.state !== "running") return false;
	return entry.isAlive ? entry.isAlive() : true;
}

export async function cancelActiveRun(scope: ActiveRunScope | ActiveRunOwner, signal: ActiveCancelSignal = "SIGTERM"): Promise<ActiveCancelResult> {
	const entry = activeRuns.get(scopeKey(scope));
	if (!entry) return { delivered: false, reason: "not_attached" };
	if ((scope.incarnationId ?? null) !== null && (entry.incarnationId ?? null) !== (scope.incarnationId ?? null)) return { delivered: false, reason: "owner_replaced", pid: entry.pid, pgid: entry.pgid };
	if ("ownerId" in scope && entry.ownerId !== scope.ownerId) return { delivered: false, reason: "owner_replaced", pid: entry.pid, pgid: entry.pgid };
	const delivered = entry.cancelDelivered.get(signal);
	if (delivered) return delivered;
	const inFlight = entry.cancelInFlight.get(signal);
	if (inFlight) return inFlight;

	const attempt = (async (): Promise<ActiveCancelResult> => {
		const owner = { namespaceId: entry.namespaceId, runId: entry.runId, incarnationId: entry.incarnationId, ownerId: entry.ownerId };
		if (entry.state === "exited") return { delivered: false, owner, reason: "already_exited", pid: entry.pid, pgid: entry.pgid };
		if (entry.isAlive && !entry.isAlive()) return { delivered: false, owner, reason: "not_alive", pid: entry.pid, pgid: entry.pgid };
		if (!entry.cancel) return { delivered: false, owner, reason: "no_cancel_handle", pid: entry.pid, pgid: entry.pgid };
		const signaled = await entry.cancel(signal);
		if (!signaled) return { delivered: false, owner, reason: "not_signaled", pid: entry.pid, pgid: entry.pgid };
		const result = { delivered: true, owner: { namespaceId: entry.namespaceId, runId: entry.runId, incarnationId: entry.incarnationId, ownerId: entry.ownerId }, pid: entry.pid, pgid: entry.pgid } as const;
		entry.cancelDelivered.set(signal, result);
		return result;
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
	await store.mutate((ledger) => isActiveRunOwner(owner)
		? ledger.markCancelDeliveryIfCurrent(owner.runId, owner.incarnationId, result.delivered ? "delivered" : result.reason).run
		: ledger.get(owner.runId));
	return result;
}

export interface LionControlStore {
	namespaceId: string;
	query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
	mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
}

export interface RunCancellationResult {
	run: LionRun | undefined;
	settled: boolean;
	superseded: boolean;
	delivery?: ActiveCancelResult;
}

export async function requestRunCancellation(store: LionControlStore, runId: string, reason?: string | null): Promise<RunCancellationResult> {
	const requested = (await store.mutate((ledger) => ledger.requestCancel(runId, reason))).result;
	if (requested.already_terminal || !requested.signal) return { run: requested.run, settled: true, superseded: false };
	const scope: ActiveRunScope = { namespaceId: store.namespaceId, runId, incarnationId: requested.run.incarnation_id ?? null };
	const delivery = await cancelActiveRunWithEscalation(scope, requested.signal);
	const status = delivery.delivered ? "delivered" : delivery.reason;
	const persisted = (await store.mutate((ledger) => ledger.markCancelDeliveryIfCurrent(runId, requested.run.incarnation_id, status))).result;
	return { run: persisted.run, settled: false, superseded: !persisted.committed, delivery };
}

export async function waitForRunSettlement(store: LionControlStore, run: Pick<LionRun, "id" | "incarnation_id">, timeoutMs = 15_000, pollMs = 25): Promise<RunCancellationResult> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	for (;;) {
		const current = (await store.query((ledger) => ledger.get(run.id))).result;
		if (!current || (current.incarnation_id ?? null) !== (run.incarnation_id ?? null)) {
			return { run: current, settled: true, superseded: true };
		}
		if (["completed", "blocked", "failed", "aborted"].includes(current.status)) return { run: current, settled: true, superseded: false };
		if (Date.now() >= deadline) return { run: current, settled: false, superseded: false };
		await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)));
	}
}

export function clearActiveRunsForTests(): void {
	for (const entry of activeRuns.values()) if (entry.escalationTimer) clearTimeout(entry.escalationTimer);
	activeRuns.clear();
}
