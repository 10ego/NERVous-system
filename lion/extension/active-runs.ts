/**
 * In-memory ownership registry for live LION workers.
 *
 * Persisted PID/PGID values are observational metadata only. They are never
 * sufficient authority to signal a process after restart or stale ledger
 * recovery. Only a currently registered owner from this process may deliver
 * cancellation to a live worker.
 */

import { randomUUID } from "node:crypto";
import type { LionRunnerMode } from "./schema.ts";
import type { LionProcessInfo } from "./subprocess.ts";

export type ActiveCancelSignal = "SIGTERM" | "SIGKILL";

export interface ActiveRunProcessInfo extends Omit<LionProcessInfo, "cancel"> {
	cancel?: (signal: ActiveCancelSignal) => Promise<void> | void;
	isAlive?: () => boolean;
}

export interface ActiveRunOwner {
	runId: string;
	ownerId: string;
}

interface ActiveRunEntry {
	runId: string;
	ownerId: string;
	runnerMode?: LionRunnerMode | null;
	registeredAt: string;
	state: "starting" | "running" | "exited";
	pid?: number;
	pgid?: number | null;
	cancel?: (signal: ActiveCancelSignal) => Promise<void> | void;
	isAlive?: () => boolean;
}

export type ActiveCancelResult =
	| { delivered: true; pid?: number; pgid?: number | null }
	| { delivered: false; reason: "not_attached" | "already_exited" | "not_alive" | "no_cancel_handle"; pid?: number; pgid?: number | null };

const activeRuns = new Map<string, ActiveRunEntry>();

export function beginActiveRun(runId: string, runnerMode?: LionRunnerMode | null): ActiveRunOwner {
	const owner: ActiveRunOwner = { runId, ownerId: randomUUID() };
	activeRuns.set(runId, { ...owner, runnerMode, registeredAt: new Date().toISOString(), state: "starting" });
	return owner;
}

export function attachActiveRunProcess(owner: ActiveRunOwner, info: ActiveRunProcessInfo): void {
	const entry = activeRuns.get(owner.runId);
	if (!entry || entry.ownerId !== owner.ownerId) return;
	entry.state = "running";
	entry.pid = info.pid;
	entry.pgid = info.pgid;
	entry.cancel = info.cancel;
	entry.isAlive = info.isAlive;
}

export function markActiveRunExited(owner: ActiveRunOwner): void {
	const entry = activeRuns.get(owner.runId);
	if (!entry || entry.ownerId !== owner.ownerId) return;
	entry.state = "exited";
}

export function finishActiveRun(owner: ActiveRunOwner): void {
	const entry = activeRuns.get(owner.runId);
	if (entry?.ownerId === owner.ownerId) activeRuns.delete(owner.runId);
}

export function getActiveRunIds(): string[] {
	return Array.from(activeRuns.keys());
}

export function isActiveRunAttached(runId: string, runnerMode?: LionRunnerMode): boolean {
	const entry = activeRuns.get(runId);
	if (!entry) return false;
	if (runnerMode && entry.runnerMode !== runnerMode) return false;
	if (entry.state !== "running") return false;
	return entry.isAlive ? entry.isAlive() : true;
}

export async function cancelActiveRun(runId: string, signal: ActiveCancelSignal = "SIGTERM"): Promise<ActiveCancelResult> {
	const entry = activeRuns.get(runId);
	if (!entry) return { delivered: false, reason: "not_attached" };
	if (entry.state === "exited") return { delivered: false, reason: "already_exited", pid: entry.pid, pgid: entry.pgid };
	if (entry.isAlive && !entry.isAlive()) return { delivered: false, reason: "not_alive", pid: entry.pid, pgid: entry.pgid };
	if (!entry.cancel) return { delivered: false, reason: "no_cancel_handle", pid: entry.pid, pgid: entry.pgid };
	await entry.cancel(signal);
	return { delivered: true, pid: entry.pid, pgid: entry.pgid };
}

export function clearActiveRunsForTests(): void {
	activeRuns.clear();
}
