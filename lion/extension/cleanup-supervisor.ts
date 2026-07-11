/**
 * Process-local supervision for RPC children that outlive bounded foreground cleanup.
 *
 * The registry is intentionally ephemeral. Persisted PID/PGID metadata never grants
 * authority to recreate an entry, wait for, or signal a process after restart.
 */

import { isActiveRunOwner, type ActiveRunOwner } from "./active-runs.ts";
import { isTerminalLionStatus, type LionRun } from "./schema.ts";
import type { FinishRunInput, LionLedger } from "./store.ts";
import type { LionProcessInfo, LionRunOutput } from "./subprocess.ts";

export type LionTerminalIntent =
	| { kind: "result"; output: LionRunOutput }
	| { kind: "error"; error: Error };

export interface LionCleanupHandoff {
	namespaceId: string;
	runId: string;
	incarnationId: string | null;
	ownerId: string;
	process: LionProcessInfo;
	isAlive(): boolean;
	waitForExit(): Promise<void>;
	cleanup(): Promise<void>;
	terminalIntent: LionTerminalIntent;
}

export type LionCleanupFinalization =
	| { disposition: "terminal"; run: LionRun }
	| { disposition: "superseded"; run?: LionRun };

export interface LionFinalizationStore {
	query<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
	mutate<T>(fn: (ledger: LionLedger) => T): Promise<{ result: T }>;
}

/**
 * Durably records the exact cleanup-pending process observation before the
 * foreground owner may hand authority to the process-local supervisor.
 * Persisted metadata remains observational and grants no restart authority.
 */
export async function persistCleanupPendingObservation(
	store: LionFinalizationStore,
	owner: ActiveRunOwner,
	handoff: LionCleanupHandoff,
): Promise<LionRun> {
	if (handoff.namespaceId !== owner.namespaceId
		|| handoff.runId !== owner.runId
		|| (handoff.incarnationId ?? null) !== (owner.incarnationId ?? null)
		|| handoff.ownerId !== owner.ownerId
		|| !Number.isSafeInteger(handoff.process.pid)
		|| handoff.process.pid <= 0) {
		throw new Error("cleanup-pending observation does not match the exact active owner");
	}
	const observation = {
		observed_at: new Date().toISOString(),
		incarnation_id: owner.incarnationId ?? null,
		pid: handoff.process.pid,
		pgid: handoff.process.pgid,
		process_identity: handoff.process.process_identity ?? null,
	};
	const { result } = await store.mutate((ledger) => ledger.updateControlIfCurrent(owner.runId, owner.incarnationId, {
		pid: observation.pid,
		pgid: observation.pgid,
		process_identity: observation.process_identity,
		cleanup_pending: observation,
	}));
	const persisted = result.run?.control?.cleanup_pending;
	if (!result.committed || !result.run
		|| persisted?.observed_at !== observation.observed_at
		|| persisted.pid !== observation.pid
		|| (persisted.incarnation_id ?? null) !== (owner.incarnationId ?? null)) {
		throw new Error(`cleanup-pending observation persistence was superseded for ${owner.runId}/${owner.incarnationId ?? "null"}`);
	}
	return result.run;
}

/**
 * One exact-incarnation finalization attempt with authoritative-read handling.
 * Ambiguous writes that actually committed are accepted; active exact records
 * retry, and replacements are fenced without mutation.
 */
export async function finalizeExactLionRun(
	store: LionFinalizationStore,
	owner: ActiveRunOwner,
	input: FinishRunInput,
): Promise<LionCleanupFinalization> {
	try {
		const { result } = await store.mutate((ledger) => ledger.finishIfCurrent(owner.runId, owner.incarnationId, input));
		return classifyFinalization(owner, result.run, result.committed);
	} catch (writeError) {
		let current: LionRun | undefined;
		try { current = (await store.query((ledger) => ledger.get(owner.runId))).result; }
		catch { throw writeError; }
		const classified = classifyFinalization(owner, current, false, true);
		if (classified) return classified;
		throw writeError;
	}
}

function classifyFinalization(
	owner: ActiveRunOwner,
	run: LionRun | undefined,
	committed: boolean,
	ambiguous = false,
): LionCleanupFinalization {
	if (!run || (run.incarnation_id ?? null) !== (owner.incarnationId ?? null)) return { disposition: "superseded", run };
	if (isTerminalLionStatus(run.status)) return { disposition: "terminal", run };
	if (!committed || ambiguous) throw new Error(`LION exact-incarnation finalization remains active for ${owner.runId}/${owner.incarnationId ?? "null"}`);
	throw new Error(`LION ${owner.runId} remained nonterminal after finalization`);
}

export interface LionCleanupSupervisorRegistration {
	owner: ActiveRunOwner;
	handoff: LionCleanupHandoff;
	/** Exact-incarnation finalization. Throwing requests an idempotent retry. */
	finalize(intent: LionTerminalIntent, cleanupError?: Error): Promise<LionCleanupFinalization>;
	/** Emits the process-local terminal event once; it is never retried. */
	emitTerminal?(result: LionCleanupFinalization): void;
	/** Late orchestration/capacity settlement. Throwing requests an idempotent retry. */
	onSettled?(result: LionCleanupFinalization): Promise<void> | void;
	/** Releases the exact process-local owner only after all settlement succeeds. */
	releaseOwner(): void;
	retryDelayMs?: number;
}

interface SupervisorEntry extends LionCleanupSupervisorRegistration {
	key: string;
	settlementEmitted: boolean;
}

const supervisors = new Map<string, SupervisorEntry>();
const DEFAULT_RETRY_DELAY_MS = 100;

export function cleanupSupervisorKey(owner: ActiveRunOwner): string {
	return JSON.stringify([owner.namespaceId, owner.runId, owner.incarnationId ?? null, owner.ownerId]);
}

function exactHandoff(registration: LionCleanupSupervisorRegistration): boolean {
	const { owner, handoff } = registration;
	return handoff.namespaceId === owner.namespaceId
		&& handoff.runId === owner.runId
		&& (handoff.incarnationId ?? null) === (owner.incarnationId ?? null)
		&& handoff.ownerId === owner.ownerId
		&& isActiveRunOwner(owner)
		&& handoff.process.pid > 0
		&& handoff.isAlive();
}

/**
 * Atomically admits an exact owner/handoff into the process-local registry.
 * False means the foreground caller must retain authority and continue waiting.
 */
export function registerLionCleanupSupervisor(registration: LionCleanupSupervisorRegistration): boolean {
	if (!exactHandoff(registration)) return false;
	const key = cleanupSupervisorKey(registration.owner);
	if (supervisors.has(key)) return false;
	const entry: SupervisorEntry = { ...registration, key, settlementEmitted: false };
	supervisors.set(key, entry);
	void supervise(entry);
	return true;
}

async function supervise(entry: SupervisorEntry): Promise<void> {
	try {
		await retry(entry, async () => {
			await entry.handoff.waitForExit();
			if (entry.handoff.isAlive()) throw new Error("cleanup child remains alive after exit observation");
		});
		await retry(entry, entry.handoff.cleanup);

		const finalized = await retry(entry, () => entry.finalize(entry.handoff.terminalIntent));
		if (!entry.settlementEmitted) {
			try { entry.emitTerminal?.(finalized); }
			catch { /* terminal emitters are best-effort and must never duplicate */ }
			finally { entry.settlementEmitted = true; }
		}
		await retry(entry, async () => { await entry.onSettled?.(finalized); });
		entry.releaseOwner();
	} finally {
		// Exact-key deletion cannot remove a replacement owner/supervisor.
		if (supervisors.get(entry.key) === entry) supervisors.delete(entry.key);
	}
}

async function retry<T>(entry: SupervisorEntry, operation: () => Promise<T>): Promise<T> {
	for (;;) {
		try { return await operation(); }
		catch {
			await delay(entry.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
		}
	}
}

function delay(ms: number): Promise<void> {
	// The supervisor owns unfinished lifecycle authority. Keep its retry timer
	// referenced so an otherwise-idle host cannot exit between retry attempts.
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function hasLionCleanupSupervisor(owner: ActiveRunOwner): boolean {
	return supervisors.has(cleanupSupervisorKey(owner));
}

/** Process-loss simulation/test helper. Deliberately performs no cleanup or signaling. */
export function clearLionCleanupSupervisorsForTests(): void {
	supervisors.clear();
}
