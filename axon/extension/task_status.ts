/**
 * AXON — task status state machine.
 *
 * Defines the legal transitions between {@link TaskStatus} values and the
 * helpers the store uses to guard mutations. The graph encodes the NERVous
 * workflow: a task starts pending → ready (deps satisfied) → in_progress,
 * then resolves to needs_review/completed/blocked/needs_amygdala/failed/cancelled.
 */

import { TERMINAL_STATUSES, type TaskStatus } from "./schema.ts";

/**
 * Allowed transitions. Read as: from-status → set of legal to-statuses.
 *
 * - completed is terminal (use needs_review for the pre-approval stage).
 * - failed/cancelled can be reopened to pending (replan).
 */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	pending: ["ready", "cancelled", "failed"],
	ready: ["in_progress", "pending", "cancelled", "failed"],
	in_progress: ["blocked", "needs_amygdala", "needs_review", "completed", "failed", "cancelled"],
	blocked: ["ready", "in_progress", "pending", "cancelled", "failed"],
	needs_amygdala: ["in_progress", "blocked", "pending", "cancelled", "failed"],
	needs_review: ["completed", "in_progress", "failed", "cancelled"],
	completed: [],
	failed: ["pending"],
	cancelled: ["pending"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	const allowed = TRANSITIONS[from];
	return allowed ? allowed.includes(to) : false;
}

export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

/**
 * Human-readable label for a status (used in rendering).
 */
export function statusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "Pending";
		case "ready":
			return "Ready";
		case "in_progress":
			return "In progress";
		case "blocked":
			return "Blocked";
		case "needs_amygdala":
			return "Needs AMYGDALA";
		case "needs_review":
			return "Needs review";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "cancelled":
			return "Cancelled";
	}
}

/** Allowed next statuses for a given status (for hints/error messages). */
export function nextStatuses(status: TaskStatus): readonly TaskStatus[] {
	return TRANSITIONS[status];
}
