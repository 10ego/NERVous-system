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

	it("reserves assignments before creating LION runs", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 2, assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }] }))).result;
		const seenStatuses: string[] = [];
		const adapter = fakeAdapter({ "assign-001": completedReport("A done"), "assign-002": completedReport("B done") });
		const baseCreateRun = adapter.createRun.bind(adapter);
		adapter.createRun = async (assignment) => {
			const current = (await store.query((l) => l.get(wave.id))).result!;
			seenStatuses.push(current.assignments.find((a) => a.id === assignment.id)?.status ?? "missing");
			return baseCreateRun(assignment);
		};
		await runWave(store, adapter, { wave_id: wave.id });
		assert.deepEqual(seenStatuses, ["dispatched", "dispatched"]);
	});

	it("subtracts existing dispatched assignments from reservation capacity", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 2, assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }, { agent_id: "lion-c", objective: "C" }] }))).result;
		await store.mutate((l) => l.dispatch(wave.id, { links: [{ assignment_id: "assign-001", lion_run_id: "run-existing" }] }));
		const adapter = fakeAdapter({ "assign-002": { outcome: "blocked", summary: "pause", changed_files: [], tests_run: [], blockers: ["manual worker still running"], next_steps: [] }, "assign-003": completedReport("should not dispatch in same batch") });
		const result = await runWave(store, adapter, { wave_id: wave.id, max_parallel: 2 });
		assert.deepEqual(adapter.created, ["assign-002:run-001"]);
		assert.equal(result.wave.assignments[0]?.status, "dispatched");
		assert.equal(result.wave.assignments[1]?.status, "blocked");
		assert.equal(result.wave.assignments[2]?.status, "planned");
		assert.equal(result.assignment_results.at(-1)?.assignment_id, "assign-003");
		assert.equal(result.assignment_results.at(-1)?.outcome, "skipped");
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

	it("treats missing worker reports as failed", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": null as unknown as LionReport });
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.wave.status, "needs_replan");
		assert.equal(result.wave.assignments[0]?.status, "failed");
		assert.equal(result.assignment_results[0]?.outcome, "failed");
		assert.match(result.assignment_results[0]?.summary ?? "", /missing WORKER_REPORT/);
	});

	it("recovers stale reservations without run ids", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		await store.mutate((l) => l.dispatch(wave.id, { links: [{ assignment_id: "assign-001" }] }));
		const adapter = fakeAdapter({ "assign-001": completedReport("A done") });
		const result = await runWave(store, adapter, { wave_id: wave.id, reservation_stale_ms: 0 });
		assert.equal(result.wave.status, "completed");
		assert.equal(adapter.created.length, 1);
		assert.equal(result.wave.assignments[0]?.lion_run_id, "run-001");
	});

	it("stops without recording completion when LION finalization rejects", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("local done") });
		adapter.finishRun = async () => { throw new Error("LION finalization lock timeout"); };
		await assert.rejects(() => runWave(store, adapter, { wave_id: wave.id }), /finalization lock timeout/);
		const current = (await store.query((l) => l.get(wave.id))).result!;
		assert.equal(current.assignments[0]?.status, "dispatched");
		assert.equal(current.assignments[0]?.lion_run_id, "run-001");
		assert.equal(current.assignments[0]?.outcome_summary, null);
	});

	it("stops without recording failure when worker-error finalization rejects", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({});
		adapter.run = async () => { throw new Error("worker crashed"); };
		adapter.finishRun = async () => { throw new Error("LION error finalization failed"); };
		await assert.rejects(() => runWave(store, adapter, { wave_id: wave.id }), /error finalization failed/);
		const current = (await store.query((l) => l.get(wave.id))).result!;
		assert.equal(current.assignments[0]?.status, "dispatched");
		assert.equal(current.assignments[0]?.lion_run_id, "run-001");
	});

	it("records a host-aborted worker as aborted and cancelled", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const controller = new AbortController();
		const adapter = fakeAdapter({});
		let finishStatus: string | undefined;
		adapter.run = async () => {
			controller.abort();
			throw new Error("LION subprocess was aborted or timed out");
		};
		adapter.getRun = async (runId) => ({ id: runId, agent_id: "lion-a", status: "running", task_id: null, objective: "A", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), control: null } as LionRun);
		adapter.finishRun = async (runId, result) => {
			finishStatus = result.status;
			return { id: runId, agent_id: "lion", status: result.status ?? "failed", task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		};
		const result = await runWave(store, adapter, { wave_id: wave.id, signal: controller.signal });
		assert.equal(finishStatus, "aborted");
		assert.equal(result.assignment_results[0]?.outcome, "cancelled");
		assert.match(result.assignment_results[0]?.summary ?? "", /host aborted/i);
		assert.equal(result.wave.status, "cancelled");
	});

	it("records cancelled LION runs as aborted and cancelled assignments", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({});
		let finishStatus: string | undefined;
		adapter.run = async () => { throw new Error("runner stopped"); };
		adapter.getRun = async (runId) => ({
			id: runId,
			agent_id: "lion-a",
			status: "running",
			task_id: null,
			objective: "A",
			context: "",
			started_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			control: { cancel_requested_at: new Date().toISOString(), cancel_reason: "user requested" },
		} as LionRun);
		adapter.finishRun = async (runId, result) => {
			finishStatus = result.status;
			return { id: runId, agent_id: "lion", status: result.status ?? "failed", task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(finishStatus, "aborted");
		assert.equal(result.wave.status, "cancelled");
		assert.equal(result.wave.assignments[0]?.status, "cancelled");
		assert.equal(result.assignment_results[0]?.outcome, "cancelled");
		assert.match(result.assignment_results[0]?.summary ?? "", /user requested/);
	});

	it("stops dispatching remaining planned assignments after cancellation", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 1, assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }] }))).result;
		const adapter = fakeAdapter({});
		adapter.run = async (_run, assignment) => {
			if (assignment.id === "assign-001") throw new Error("runner stopped");
			throw new Error("should not run second assignment");
		};
		adapter.getRun = async (runId) => ({
			id: runId,
			agent_id: "lion-a",
			status: "running",
			task_id: null,
			objective: "A",
			context: "",
			started_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			control: { cancel_requested_at: new Date().toISOString(), cancel_reason: "user requested" },
		} as LionRun);
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.wave.status, "cancelled");
		assert.equal(result.wave.assignments[0]?.status, "cancelled");
		assert.equal(result.wave.assignments[1]?.status, "planned");
		assert.deepEqual(adapter.created, ["assign-001:run-001"]);
		assert.equal(result.assignment_results.at(-1)?.assignment_id, "assign-002");
		assert.equal(result.assignment_results.at(-1)?.outcome, "skipped");
	});

	it("finalizes a created LION run without overwriting a terminal assignment when linking fails", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("should not run") });
		const baseCreateRun = adapter.createRun.bind(adapter);
		let finishStatus: string | undefined;
		let finishError: string | null | undefined;
		let ran = false;
		adapter.createRun = async (assignment) => {
			const run = await baseCreateRun(assignment);
			await store.mutate((l) => l.record(wave.id, { assignment_id: assignment.id, outcome: "failed", summary: "became terminal before link" }));
			return run;
		};
		adapter.run = async () => {
			ran = true;
			return { text: "unexpected", report: completedReport("unexpected") };
		};
		adapter.finishRun = async (runId, result) => {
			finishStatus = result.status;
			finishError = result.error;
			return { id: runId, agent_id: "lion", status: result.status ?? "failed", task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(ran, false);
		assert.equal(finishStatus, "failed");
		assert.match(finishError ?? "", /dispatch\/link failed/);
		assert.equal(result.assignment_results[0]?.outcome, "skipped");
		assert.equal(result.wave.assignments[0]?.lion_run_id, null);
		assert.equal(result.wave.assignments[0]?.status, "failed");
	});

	it("does not overwrite a concurrent foreign LION link during setup recovery", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ max_parallel: 1, assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("should not run") });
		const baseCreateRun = adapter.createRun.bind(adapter);
		const trace: string[] = [];
		let ran = false;
		let finishStatus: string | undefined;
		adapter.createRun = async (assignment) => {
			trace.push("create-local");
			const run = await baseCreateRun(assignment);
			await store.mutate((l) => l.dispatch(wave.id, { links: [{ assignment_id: assignment.id, lion_run_id: "run-foreign" }] }));
			trace.push("link-foreign");
			return run;
		};
		adapter.run = async () => {
			ran = true;
			return { text: "unexpected", report: completedReport("unexpected") };
		};
		adapter.finishRun = async (runId, result) => {
			trace.push(`finish-local:${runId}`);
			finishStatus = result.status;
			return { id: runId, agent_id: "lion", status: result.status ?? "failed", task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.deepEqual(trace, ["create-local", "link-foreign", "finish-local:run-001"]);
		assert.equal(ran, false);
		assert.equal(finishStatus, "failed");
		assert.equal(result.assignment_results[0]?.outcome, "skipped");
		assert.equal(result.wave.assignments[0]?.status, "dispatched");
		assert.equal(result.wave.assignments[0]?.lion_run_id, "run-foreign");
	});

	it("does not overwrite a foreign terminal result recorded after local linking", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("local done") });
		let localFinishStatus: string | undefined;
		adapter.run = async (_run, assignment) => {
			await store.mutate((l) => l.record(wave.id, {
				assignment_id: assignment.id,
				lion_run_id: "run-foreign",
				outcome: "completed",
				summary: "foreign done",
			}));
			return { text: "local", report: completedReport("local done") };
		};
		adapter.finishRun = async (runId, result) => {
			localFinishStatus = result.status ?? "completed";
			return { id: runId, agent_id: "lion", status: result.status ?? "completed", task_id: null, objective: "", context: "", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), report: result.report, error: result.error ?? null } as LionRun;
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(localFinishStatus, "completed");
		assert.equal(result.assignment_results[0]?.outcome, "skipped");
		assert.match(result.assignment_results[0]?.summary ?? "", /owned by run-foreign/);
		assert.equal(result.wave.assignments[0]?.lion_run_id, "run-foreign");
		assert.equal(result.wave.assignments[0]?.status, "completed");
		assert.equal(result.wave.assignments[0]?.outcome_summary, "foreign done");
	});

	it("does not overwrite a foreign result when the local worker errors", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({});
		adapter.run = async (_run, assignment) => {
			await store.mutate((l) => l.record(wave.id, {
				assignment_id: assignment.id,
				lion_run_id: "run-foreign",
				outcome: "failed",
				summary: "foreign failed",
			}));
			throw new Error("local runner failed");
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.assignment_results[0]?.outcome, "skipped");
		assert.equal(result.wave.assignments[0]?.lion_run_id, "run-foreign");
		assert.equal(result.wave.assignments[0]?.status, "failed");
		assert.equal(result.wave.assignments[0]?.outcome_summary, "foreign failed");
	});

	it("treats wave cancellation during local execution as a superseded result", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({ "assign-001": completedReport("local done") });
		adapter.run = async () => {
			await store.mutate((l) => l.cancel(wave.id));
			return { text: "local", report: completedReport("local done") };
		};
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.assignment_results[0]?.outcome, "skipped");
		assert.equal(result.wave.status, "cancelled");
		assert.equal(result.wave.assignments[0]?.status, "cancelled");
	});

	it("surfaces cleanup failure for a created but unlinked LION run", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({});
		const baseCreateRun = adapter.createRun.bind(adapter);
		adapter.createRun = async (assignment) => {
			const run = await baseCreateRun(assignment);
			await store.mutate((l) => l.record(wave.id, { assignment_id: assignment.id, outcome: "failed", summary: "foreign terminal" }));
			return run;
		};
		adapter.finishRun = async () => { throw new Error("cleanup write failed"); };
		await assert.rejects(() => runWave(store, adapter, { wave_id: wave.id }), /cleanup write failed/);
		const current = (await store.query((l) => l.get(wave.id))).result!;
		assert.equal(current.assignments[0]?.status, "failed");
		assert.equal(current.assignments[0]?.lion_run_id, null);
		assert.equal(current.assignments[0]?.outcome_summary, "foreign terminal");
	});

	it("records createRun failures against reserved assignments", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		const adapter = fakeAdapter({});
		adapter.createRun = async () => { throw new Error("spawn unavailable"); };
		const result = await runWave(store, adapter, { wave_id: wave.id });
		assert.equal(result.wave.assignments[0]?.status, "failed");
		assert.equal(result.assignment_results[0]?.outcome, "failed");
		assert.match(result.assignment_results[0]?.summary ?? "", /creation failed/);
	});

	it("bounds progress update backpressure to latest pending snapshot", async () => {
		const store = await tmpStore();
		const wave = (await store.mutate((l) => l.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] }))).result;
		let updateCount = 0;
		let releaseFirst: (() => void) | null = null;
		const adapter = fakeAdapter({ "assign-001": completedReport("A done") });
		adapter.run = async (_run, assignment, onProgress) => {
			for (let i = 0; i < 5; i++) onProgress({ event: "message", activity: `step ${i}`, active_tools: [], tool_uses: 0, turn_count: i, token_total: null, last_text: null, last_event_at: new Date().toISOString() });
			releaseFirst?.();
			return { text: "ok", report: completedReport(`${assignment.id} done`) };
		};
		adapter.updateProgress = async () => {
			updateCount++;
			if (updateCount === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
		};
		await runWave(store, adapter, { wave_id: wave.id });
		assert.ok(updateCount < 5, `expected coalesced updates, saw ${updateCount}`);
		assert.ok(updateCount >= 1);
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
		assert.match(text, /\/nervous:dashboard/);
		assert.match(text, /A done/);
	});
});
