import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory, { describeLionProgress, summarizeWaveProgress } from "../extension/index.ts";

function stubPi(): { pi: any; commands: Array<{ name: string; options: any }> } {
	const commands: Array<{ name: string; options: any }> = [];
	return {
		commands,
		pi: {
			registerCommand(name: string, options: any) {
				commands.push({ name, options });
			},
		},
	};
}

describe("dashboard extension factory", () => {
	it("registers the NERVous dashboard command", () => {
		const { pi, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const dashboard = commands.find((c) => c.name === "nervous:dashboard");
		assert.ok(dashboard, "/nervous:dashboard registered");
		assert.equal(typeof dashboard?.options.handler, "function");
		assert.ok(dashboard?.options.description);
		assert.equal(commands.some((c) => c.name === "nervous"), false, "/nervous prompt template remains unshadowed");
	});

	it("formats LION progress snapshots with activity and staleness", () => {
		const now = Date.parse("2026-07-08T12:05:00.000Z");
		const run = {
			id: "run-001",
			agent_id: "lion-a",
			status: "running",
			task_id: "task-001",
			objective: "Do work",
			context: "",
			started_at: "2026-07-08T12:00:00.000Z",
			updated_at: "2026-07-08T12:00:00.000Z",
			progress: {
				event: "tool_start",
				activity: "running bash…",
				active_tools: ["bash"],
				tool_uses: 2,
				turn_count: 1,
				token_total: 42,
				last_text: null,
				last_event_at: "2026-07-08T12:00:00.000Z",
			},
		} as any;
		const text = describeLionProgress(run, now);
		assert.match(text, /running bash/);
		assert.match(text, /tools:bash/);
		assert.match(text, /2 tools/);
		assert.match(text, /turns:1/);
		assert.match(text, /42 tokens/);
		assert.match(text, /stale 5m ago/);
	});

	it("formats missing progress defensively", () => {
		assert.equal(describeLionProgress({ status: "running" } as any), "no progress snapshot yet");
		assert.equal(describeLionProgress({ status: "completed" } as any), "no progress snapshot");
	});

	it("summarizes CEREBEL wave progress from linked LION runs", () => {
		const now = Date.parse("2026-07-08T12:00:10.000Z");
		const wave = {
			id: "wave-001",
			status: "collecting",
			assignments: [
				{ id: "assign-001", agent_id: "lion-a", status: "dispatched", lion_run_id: "run-001" },
				{ id: "assign-002", agent_id: "lion-b", status: "completed", lion_run_id: "run-002" },
			],
		} as any;
		const runs = [
			{ id: "run-001", status: "running", progress: { event: "message", activity: "writing tests", active_tools: [], tool_uses: 1, turn_count: 1, token_total: null, last_text: null, last_event_at: "2026-07-08T12:00:09.000Z" } },
			{ id: "run-002", status: "completed" },
		] as any;
		const text = summarizeWaveProgress(wave, runs, now);
		assert.match(text, /assignments completed:1 dispatched:1/);
		assert.match(text, /lion-running:1/);
		assert.match(text, /lion-completed:1/);
		assert.match(text, /active run-001: writing tests/);
	});
});
