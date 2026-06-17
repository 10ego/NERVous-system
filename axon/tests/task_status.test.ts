import * as assert from "node:assert";
import { describe, it } from "vitest";
import { canTransition, isTerminal, nextStatuses, TRANSITIONS } from "../extension/task_status.ts";
import { TASK_STATUSES, type TaskStatus } from "../extension/schema.ts";

describe("task_status — transitions", () => {
	it("allows the canonical happy path", () => {
		assert.ok(canTransition("pending", "ready"));
		assert.ok(canTransition("ready", "in_progress"));
		assert.ok(canTransition("in_progress", "needs_review"));
		assert.ok(canTransition("needs_review", "completed"));
	});

	it("allows blocking / risk / failure from in_progress", () => {
		for (const to of ["blocked", "needs_amygdala", "needs_review", "completed", "failed", "cancelled"] as const) {
			assert.ok(canTransition("in_progress", to), `in_progress -> ${to}`);
		}
	});

	it("treats same-status as a no-op transition", () => {
		for (const s of TASK_STATUSES) assert.ok(canTransition(s, s), `${s} -> ${s}`);
	});

	it("rejects illegal transitions", () => {
		assert.ok(!canTransition("pending", "in_progress"), "must go pending->ready first");
		assert.ok(!canTransition("pending", "completed"), "no skipping");
		assert.ok(!canTransition("ready", "needs_review"), "no skipping in_progress");
		assert.ok(!canTransition("needs_amygdala", "completed"), "must resume to in_progress first");
	});

	it("marks completed as terminal with no outgoing", () => {
		assert.ok(isTerminal("completed"));
		assert.deepEqual(nextStatuses("completed"), []);
		// and disallows leaving completed
		for (const s of TASK_STATUSES) {
			if (s === "completed") continue;
			assert.ok(!canTransition("completed", s));
		}
	});

	it("allows reopening failed/cancelled to pending", () => {
		assert.ok(canTransition("failed", "pending"));
		assert.ok(canTransition("cancelled", "pending"));
	});

	it("TRANSITIONS covers every status", () => {
		for (const s of TASK_STATUSES) assert.ok(Array.isArray((TRANSITIONS as Record<string, unknown>)[s]));
	});

	it("blocked can return to ready/in_progress/pending", () => {
		for (const to of ["ready", "in_progress", "pending", "cancelled", "failed"] as TaskStatus[]) {
			assert.ok(canTransition("blocked", to));
		}
	});
});
