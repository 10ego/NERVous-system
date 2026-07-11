import * as assert from "node:assert";
import { describe, it } from "vitest";
import { lionEventPayload } from "../extension/index.ts";
import { terminalEventKind } from "../extension/lifecycle.ts";
import { summarizeSummary } from "../extension/render.ts";
import type { LionRun, LionSummary } from "../extension/schema.ts";

function run(overrides: Partial<LionRun> = {}): LionRun {
	return {
		id: "run-001",
		agent_id: "lion-001",
		status: "completed",
		task_id: null,
		objective: "Sensitive objective",
		context: "",
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:01.000Z",
		finished_at: "2026-01-01T00:00:01.000Z",
		duration_ms: 1000,
		output: null,
		report: null,
		progress: null,
		control: null,
		steering_messages: [],
		error: null,
		...overrides,
	};
}

describe("LION event and summary rendering", () => {
	it("maps every terminal status exhaustively", () => {
		assert.equal(terminalEventKind("completed"), "completed");
		assert.equal(terminalEventKind("blocked"), "blocked");
		assert.equal(terminalEventKind("failed"), "failed");
		assert.equal(terminalEventKind("aborted"), "failed");
	});

	it("redacts objectives from event payloads by default", () => {
		const old = process.env.LION_EVENT_INCLUDE_OBJECTIVE;
		delete process.env.LION_EVENT_INCLUDE_OBJECTIVE;
		try {
			const payload = lionEventPayload("progress", run());
			assert.equal(payload.objective, undefined);
			assert.equal(payload.objective_redacted, true);
		} finally {
			if (old === undefined) delete process.env.LION_EVENT_INCLUDE_OBJECTIVE;
			else process.env.LION_EVENT_INCLUDE_OBJECTIVE = old;
		}
	});

	it("allows explicit objective event opt-in", () => {
		const old = process.env.LION_EVENT_INCLUDE_OBJECTIVE;
		process.env.LION_EVENT_INCLUDE_OBJECTIVE = "true";
		try {
			const payload = lionEventPayload("progress", run());
			assert.equal(payload.objective, "Sensitive objective");
			assert.equal(payload.objective_redacted, false);
		} finally {
			if (old === undefined) delete process.env.LION_EVENT_INCLUDE_OBJECTIVE;
			else process.env.LION_EVENT_INCLUDE_OBJECTIVE = old;
		}
	});

	it("shows objectives for completed summary rows even when progress is generic", () => {
		const summary: LionSummary = {
			total: 1,
			by_status: { completed: 1 },
			running: [],
			recent: [run({ progress: { event: "turn_end", activity: "turn 2 complete", active_tools: [], tool_uses: 1, turn_count: 2, token_total: null, last_text: null, last_event_at: "2026-01-01T00:00:01.000Z" } })],
		};
		const text = summarizeSummary(summary);
		assert.match(text, /Sensitive objective/);
		assert.doesNotMatch(text, /turn 2 complete/);
	});
});
