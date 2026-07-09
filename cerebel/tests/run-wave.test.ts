import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { CerebelStore, FileBackend } from "../extension/backend.ts";
import { runWave, type RunWaveLionAdapter } from "../extension/run-wave.ts";
import type { LionReport, LionRun } from "../../lion/extension/schema.ts";
import { summarizeAssignmentGroup, summarizeRunWaveResult } from "../extension/render.ts";

async function tmpStore(): Promise<CerebelStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-run-wave-"));
	return new CerebelStore(new FileBackend({ cerebelPath: path.join(dir, "cerebel.json"), dir }));
}

function fakeAdapter(reports: Record<string, LionReport | Error>): RunWaveLionAdapter & { created: string[] } {
	let next = 1;
	const created: string[] = [];
	return {
		created,
		async createRun(assignment) {
			const id = `run-${String(next++).padStart(3, "0")}`;
			created.push(`${assignment.id}:${id}`);
			return {
				id,
				agent_id: assignment.agent_id,
				status: "running",
				task_id: assignment.task_id,
				objective: assignment.objective,
				context: assignment.context,
				started_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			} as LionRun;
		},
		async run(_run, assignment, onProgress) {
			onProgress({ event: "message", activity: `working ${assignment.id}`, active_tools: [], tool_uses: 0, turn_count: 1, token_total: null, last_text: null, last_event_at: new Date().toISOString() });
			const report = reports[assignment.id];
			if (report instanceof Error) throw report;
			return { text: JSON.stringify({ WORKER_REPORT: report }), report: report ?? null };
		},
		async finishRun(runId, result) {
			return { id: runId, agent_id: "lion", status: result.status ?? (result.report?.outcome === "blocked" ? "blocked" : result.report?.outcome === "failed" ? "failed" : "completed"), task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		},
		async updateProgress() {},
	};
}

const completedReport = (summary: string): LionReport => ({ outcome: "completed", summary, changed_files: [], tests_run: ["npm test"], blockers: [], next_steps: [] });

describe("runWave", () => {
	it("runs planned assignments in bounded batches and records results", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 1, assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("A done"), "assign-002": completedReport("B done") });
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.wave.status, "completed");
		assert.equal(result.assignment_results.length, 2);
		assert.deepEqual(adapter.created, ["assign-001:run-001", "assign-002:run-002"]);
		assert.equal(result.wave.assignments[0]?.lion_run_id, "run-001");
		assert.equal(result.wave.assignments[1]?.lion_run_id, "run-002");
		assert.match(result.summary, /completed 2\/2/);
	});

	it("records blocked and failed reports as terminal wave states", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 1, assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": { outcome: "blocked", summary: "need secret", changed_files: [], tests_run: [], blockers: ["missing secret"], next_steps: [] }, "assign-002": completedReport("B skipped") });
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.wave.status, "blocked");
		assert.equal(result.wave.assignments[0]?.status, "blocked");
		assert.equal(result.wave.assignments[1]?.status, "planned");
		assert.equal(result.assignment_results.at(-1)?.outcome, "skipped");
	});

	it("does not rerun already terminal assignments", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		await store.mutate((l) => { l.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-existing" }] }); return l.record(wave.id, { assignment_id: "assign-001", lion_run_id: "run-existing", outcome: "completed", summary: "done" }); });
		const adapter = fakeAdapter({});
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(adapter.created.length, 0);
		assert.equal(result.wave.status, "completed");
		assert.equal(result.assignment_results.length, 0);
	});

	it("renders grouped run_wave summaries", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("A done") });
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(summarizeAssignmentGroup(result.wave), "completed:1");
		const text = summarizeRunWaveResult(result);
		assert.match(text, /CEREBEL run_wave/);
		assert.match(text, /A done/);
	});
});
