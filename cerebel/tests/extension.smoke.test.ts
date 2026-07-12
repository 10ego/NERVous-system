import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, it, vi } from "vitest";
import { GanglionStore } from "../../ganglion/extension/backend.ts";
import { LionStore } from "../../lion/extension/backend.ts";
import { attachActiveRunProcess, beginActiveRun, clearActiveRunsForTests, finishActiveRun } from "../../lion/extension/active-runs.ts";
import factory, { hasPendingCancellationAssignments, MAX_RUN_WAVE_TIMEOUT_MS, recordRunWaveGanglion, resolveCancelSettlementTimeout, runWaveBatchFailureResult, settleLinkedLionsBeforeCancel, validateRunWaveTimeoutMs } from "../extension/index.ts";
import { CerebelStore } from "../extension/backend.ts";
import { CerebelLedger } from "../extension/store.ts";
import { RunWaveBatchError } from "../extension/run-wave.ts";
import { renderCerebelResult } from "../extension/render.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

function isLionSpecifier(value: string): boolean {
	return /(^|\/)lion(?:\/|$)/.test(value);
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
	return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function exportClauseIsTypeOnly(node: ts.ExportDeclaration): boolean {
	if (node.isTypeOnly) return true;
	return Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
}

function runtimeLionReferences(source: string, fileName = "fixture.ts"): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const violations: string[] = [];
	const add = (node: ts.Node, kind: string) => {
		const position = file.getLineAndCharacterOfPosition(node.getStart(file));
		violations.push(`${fileName}:${position.line + 1}:${position.character + 1} ${kind}`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isLionSpecifier(node.moduleSpecifier.text)) {
			if (!importClauseIsTypeOnly(node.importClause)) add(node, "runtime import");
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isLionSpecifier(node.moduleSpecifier.text)) {
			if (!exportClauseIsTypeOnly(node)) add(node, "runtime export");
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression) && isLionSpecifier(node.moduleReference.expression.text)) {
			if (!node.isTypeOnly) add(node, "import equals");
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && isLionSpecifier(node.arguments[0]!.text)) {
			add(node, "static require");
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return violations;
}

async function extensionSources(): Promise<Array<{ path: string; source: string }>> {
	const extensionDir = path.resolve(__dirname, "../extension");
	const entries = await fs.readdir(extensionDir, { withFileTypes: true });
	return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts")).map(async (entry) => {
		const filePath = path.join(extensionDir, entry.name);
		return { path: filePath, source: await fs.readFile(filePath, "utf8") };
	}));
}

afterEach(() => vi.restoreAllMocks());

describe("cerebel extension factory", () => {
	it("does not statically load LION runtime modules", async () => {
		const violations = (await extensionSources()).flatMap((file) => runtimeLionReferences(file.source, file.path));
		assert.deepEqual(violations, []);
	});

	it("distinguishes erased type imports from runtime LION dependencies", () => {
		assert.deepEqual(runtimeLionReferences(`
			import type { LionRun } from "../../lion/extension/schema.ts";
			import { type LionReport, type LionProgressSnapshot } from "../../lion/extension/schema.ts";
			export type { LionRunStatus } from "../../lion/extension/schema.ts";
			async function load() { return import("../../lion/extension/backend.ts"); }
		`), []);
		const violations = runtimeLionReferences(`
			import/* comment */ "../../lion/extension/schema.ts";
			import { type LionRun, LionError } from "../../lion/extension/schema.ts";
			export { LionStore } from "../../lion/extension/backend.ts";
			import Lion = require("../../lion/extension/backend.ts");
			const runtime = require("../../lion/extension/store.ts");
		`);
		assert.equal(violations.length, 5);
	});

	it("validates run_wave timeout boundaries", () => {
		assert.equal(validateRunWaveTimeoutMs(undefined), 600_000);
		assert.equal(validateRunWaveTimeoutMs(1), 1);
		assert.equal(validateRunWaveTimeoutMs(MAX_RUN_WAVE_TIMEOUT_MS), MAX_RUN_WAVE_TIMEOUT_MS);
		for (const invalid of [0, -1, 1.5, MAX_RUN_WAVE_TIMEOUT_MS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => validateRunWaveTimeoutMs(invalid), /must be an integer from 1 through 2147483647/);
		}
	});

	it("rejects invalid run_wave timeouts before creating a LION worker", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-invalid-timeout-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const result = await cerebel.execute("run", { action: "run_wave", timeout_ms: 0 }, undefined, undefined, { cwd: dir });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /failed \(invalid_arg\).*timeout_ms/);
			assert.deepEqual((await LionStore.fromCwd(dir).query((ledger) => ledger.all())).result, []);
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("validates cancellation settlement timeouts and skips LION loading for unlinked waves", async () => {
		assert.equal(resolveCancelSettlementTimeout("250"), 250);
		assert.equal(resolveCancelSettlementTimeout("bogus"), 15_000);
		assert.equal(resolveCancelSettlementTimeout("Infinity"), 15_000);
		assert.equal(resolveCancelSettlementTimeout("0"), 15_000);
		assert.equal(resolveCancelSettlementTimeout("120001"), 15_000);
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] });
		let runtimeLoads = 0;
		const settlements = await settleLinkedLionsBeforeCancel(process.cwd(), wave, "cancel", 10, async () => {
			runtimeLoads++;
			throw new Error("LION unavailable");
		});
		assert.deepEqual(settlements, []);
		assert.equal(runtimeLoads, 0);
	});

	it("fails closed instead of cancelling across a fresh unlinked run_wave reservation", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-unlinked-cancel-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [{ agent_id: "lion-a", objective: "A" }] }, undefined, undefined, ctx);
			await cerebel.execute("reserve", { action: "dispatch" }, undefined, undefined, ctx);
			const cancelled = await cerebel.execute("cancel", { action: "cancel", reason: "stop" }, undefined, undefined, ctx);
			assert.equal(cancelled.isError, true);
			assert.match(cancelled.content[0].text, /stable settled assignment set; no capacity was released/);
			const current = (await CerebelStore.fromCwd(dir).query((ledger) => ledger.current())).result;
			assert.equal(current?.status, "dispatched");
			assert.equal(current?.assignments[0]?.status, "dispatched");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("recovers a stale unlinked reservation before cancelling", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-stale-unlinked-cancel-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [{ agent_id: "lion-a", objective: "A" }] }, undefined, undefined, ctx);
			await cerebel.execute("reserve", { action: "dispatch" }, undefined, undefined, ctx);
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + 31_000);
			const cancelled = await cerebel.execute("cancel", { action: "cancel", reason: "stop" }, undefined, undefined, ctx);
			assert.equal(cancelled.isError, undefined);
			assert.equal(cancelled.details.wave?.status, "cancelled");
		} finally {
			vi.useRealTimers();
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("settles exact linked LIONs even after an assignment becomes terminal", async () => {
		const ledger = new CerebelLedger();
		const planned = ledger.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }, { agent_id: "lion-b", objective: "B" }] });
		const wave = ledger.dispatch(planned.id, { links: planned.assignments.map((assignment, index) => ({ assignment_id: assignment.id, lion_run_id: `run-${index}`, lion_run_incarnation_id: `inc-${index}` })) });
		ledger.record(wave.id, { assignment_id: wave.assignments[0]!.id, lion_run_id: "run-0", lion_run_incarnation_id: "inc-0", outcome: "failed", summary: "recorded before worker exit" });
		const current = ledger.get(wave.id)!;
		let requestedIds: string[] = [];
		const controls = {
			async requestRunCancellations(_store: unknown, requests: Array<{ runId: string }>) {
				requestedIds = requests.map(({ runId }) => runId);
				return requests.map(({ runId }) => ({ run: { id: runId, status: "aborted" }, settled: true, superseded: false }));
			},
		};
		const settlements = await settleLinkedLionsBeforeCancel(process.cwd(), current, "stop", 100, async () => [{ LionStore: { fromCwd: () => ({}) } }, controls] as never);
		assert.deepEqual(requestedIds, ["run-0", "run-1"]);
		assert.equal(settlements.length, 2);
		assert.equal(hasPendingCancellationAssignments(current, new Set([JSON.stringify(["run-1", "inc-1"])])), true, "terminal links added during cancellation must remain gated until their exact run settles");
		assert.equal(hasPendingCancellationAssignments(current, new Set([JSON.stringify(["run-0", "inc-0"]), JSON.stringify(["run-1", "inc-1"])])), false);
	});

	it("polls owner-only exact references when the durable LION run is missing", async () => {
		const ledger = new CerebelLedger();
		const planned = ledger.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] });
		const wave = ledger.dispatch(planned.id, { links: [{ assignment_id: planned.assignments[0]!.id, lion_run_id: "run-1", lion_run_incarnation_id: "inc-1" }] });
		let waited: Array<{ id: string; incarnation_id?: string | null }> = [];
		const controls = {
			async requestRunCancellations() { return [{ run: undefined, run_ref: { id: "run-1", incarnation_id: "inc-1" }, settled: false, superseded: false }]; },
			async waitForRunSettlements(_store: unknown, runs: Array<{ id: string; incarnation_id?: string | null }>) {
				waited = runs;
				return [{ run: undefined, settled: true, superseded: true }];
			},
		};
		const settlements = await settleLinkedLionsBeforeCancel(process.cwd(), wave, "stop", 100, async () => [{ LionStore: { fromCwd: () => ({}) } }, controls] as never);
		assert.deepEqual(waited, [{ id: "run-1", incarnation_id: "inc-1" }]);
		assert.equal(settlements[0]?.settled, true);
	});

	it("admits whole-wave linked cancellation in one batch", async () => {
		const ledger = new CerebelLedger();
		const planned = ledger.planWave({ assignments: Array.from({ length: 4 }, (_, index) => ({ agent_id: `lion-${index}`, objective: `work ${index}` })) });
		const wave = ledger.dispatch(planned.id, { links: planned.assignments.map((assignment, index) => ({ assignment_id: assignment.id, lion_run_id: `run-${index}`, lion_run_incarnation_id: `inc-${index}` })) });
		let batchCalls = 0;
		const controls = {
			async requestRunCancellations(_store: unknown, requests: Array<{ runId: string }>) {
				batchCalls++;
				return requests.map(({ runId }) => ({ run: { id: runId, status: "aborted" }, settled: true, superseded: false }));
			},
		};
		const settlements = await settleLinkedLionsBeforeCancel(process.cwd(), wave, "stop", 100, async () => [{ LionStore: { fromCwd: () => ({}) } }, controls] as never);
		assert.equal(settlements.every((settlement) => settlement.settled), true);
		assert.equal(batchCalls, 1);
	});

	it("registers the cerebel tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const cerebel = tools.find((t) => t.name === "cerebel");
		assert.ok(cerebel);
		assert.equal(typeof cerebel.execute, "function");
		assert.equal(typeof cerebel.renderCall, "function");
		assert.equal(typeof cerebel.renderResult, "function");
		assert.ok(cerebel.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("cerebel"));
		assert.ok(names.includes("cerebel:waves"));
	});

	it("preserves partial run_wave results in failed tool details", () => {
		const ledger = new CerebelLedger();
		const wave = ledger.planWave({ assignments: [{ agent_id: "lion-a", objective: "A" }] });
		const partial = { wave, assignment_results: [{ assignment_id: "assign-001", lion_run_id: "run-001", outcome: "completed" as const, summary: "done", blockers: [] }], summary: "partial" };
		const batchError = new RunWaveBatchError("finish failed", partial, [new Error("finish failed")]);
		const result = runWaveBatchFailureResult(batchError);
		assert.equal(result.isError, true);
		assert.equal(result.details.wave?.id, wave.id);
		assert.equal(result.details.run_wave?.assignment_results[0]?.lion_run_id, "run-001");
		assert.equal(batchError instanceof AggregateError, true);
		assert.deepEqual(batchError.errors, batchError.causes);
		const rendered = renderCerebelResult(result, { expanded: true }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
		assert.equal(rendered.constructor.name, "Container");
	});

	it("returns structured tool errors when cancellation is invalid", async () => {
		const previous = process.env.CEREBEL_PATH;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-structured-cancel-"));
		process.env.CEREBEL_PATH = path.join(dir, "cerebel.json");
		try {
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [{ agent_id: "lion-a", objective: "A" }] }, undefined, undefined, ctx);
			await cerebel.execute("record", { action: "record", assignment_id: "assign-001", outcome: "completed", summary: "done" }, undefined, undefined, ctx);
			const result = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(result.details.error, /cerebel cancel failed \(invalid_transition\)/);
		} finally {
			if (previous === undefined) delete process.env.CEREBEL_PATH; else process.env.CEREBEL_PATH = previous;
		}
	});

	it("batches run_wave GANGLION records into one mutation per group", async () => {
		const previous = process.env.GANGLION_PATH;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-batch-ganglion-"));
		process.env.GANGLION_PATH = path.join(dir, "ganglion.json");
		try {
			const store = GanglionStore.fromCwd(dir);
			await store.mutate((ledger) => { const group = ledger.create({ members: [{ id: "lion-a" }, { id: "lion-b" }] }); ledger.allocate(group.id, { tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] }); });
			const original = GanglionStore.prototype.mutate;
			let mutations = 0;
			vi.spyOn(GanglionStore.prototype, "mutate").mockImplementation(function (this: GanglionStore, fn: any) { mutations++; return original.call(this, fn); });
			const wave = new CerebelLedger().planWave({ assignments: [
				{ task_id: "task-a", agent_id: "lion-a", objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" },
				{ task_id: "task-b", agent_id: "lion-b", objective: "B", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-002" },
			] });
			const messages = await recordRunWaveGanglion(dir, { wave, summary: "done", assignment_results: wave.assignments.map((assignment, index) => ({ assignment_id: assignment.id, lion_run_id: `run-${index}`, outcome: "completed", summary: "done", blockers: [] })) });
			assert.equal(mutations, 1);
			assert.equal(messages.length, 2);
		} finally {
			if (previous === undefined) delete process.env.GANGLION_PATH; else process.env.GANGLION_PATH = previous;
		}
	});

	it("batches cancellation reconciliation once per GANGLION with exact provenance and fencing", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-cancel-batch-ganglion-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((ledger) => {
				const group = ledger.create({ members: [{ id: "lion-a" }, { id: "lion-b" }] });
				ledger.allocate(group.id, { tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] });
				ledger.record(group.id, { allocation_id: "alloc-001", lion_run_id: "run-stale", status: "completed" });
				ledger.allocate(group.id, { tasks: [{ id: "task-new", title: "New" }] });
			});
			const lionStore = LionStore.fromCwd(dir);
			const runA = (await lionStore.mutate((ledger) => {
				const run = ledger.create({ objective: "A" });
				return ledger.finish(run.id, { output: "", report: null, status: "completed" });
			})).result;
			const runB = (await lionStore.mutate((ledger) => {
				const run = ledger.create({ objective: "B" });
				return ledger.finish(run.id, { output: "", report: null, status: "failed" });
			})).result;
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			await cerebel.execute("plan", { action: "plan_wave", assignments: [
				{ task_id: "task-a", agent_id: "lion-a", objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" },
				{ task_id: "task-b", agent_id: "lion-b", objective: "B", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-002" },
			] }, undefined, undefined, { cwd: dir });
			await cerebel.execute("dispatch", { action: "dispatch", links: [
				{ assignment_id: "assign-001", lion_run_id: runA.id, lion_run_incarnation_id: runA.incarnation_id },
				{ assignment_id: "assign-002", lion_run_id: runB.id, lion_run_incarnation_id: runB.incarnation_id },
			] }, undefined, undefined, { cwd: dir });
			const originalMutate = GanglionStore.prototype.mutate;
			let mutations = 0;
			vi.spyOn(GanglionStore.prototype, "mutate").mockImplementation(function (this: GanglionStore, fn: any) { mutations++; return originalMutate.call(this, fn); });

			const cancelled = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, { cwd: dir });

			assert.equal(mutations, 1);
			assert.match(cancelled.content[0].text, /ganglion-001\/alloc-001 recorded; capacity retained by a newer allocation/);
			assert.match(cancelled.content[0].text, /ganglion-001\/alloc-002 recorded; capacity released/);
			const group = (await ganglionStore.query((ledger) => ledger.get("ganglion-001"))).result!;
			assert.deepEqual(group.allocations.slice(0, 2).map((allocation) => allocation.lion_run_id), [runA.id, runB.id]);
			assert.deepEqual(group.allocations.slice(0, 2).map((allocation) => allocation.status), ["cancelled", "cancelled"]);
			assert.equal(group.members.find((member) => member.id === "lion-a")?.current_allocation_id, "alloc-003");
			assert.equal(group.members.find((member) => member.id === "lion-b")?.status, "available");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("releases valid cancellation siblings when one allocation is missing", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-cancel-invalid-allocation-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((ledger) => {
				const group = ledger.create({ members: [{ id: "lion-a" }, { id: "lion-b" }] });
				ledger.allocate(group.id, { tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] });
			});
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			await cerebel.execute("plan", { action: "plan_wave", assignments: [
				{ task_id: "task-a", agent_id: "lion-a", objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-missing" },
				{ task_id: "task-b", agent_id: "lion-b", objective: "B", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-002" },
			] }, undefined, undefined, { cwd: dir });
			const originalMutate = GanglionStore.prototype.mutate;
			let mutations = 0;
			vi.spyOn(GanglionStore.prototype, "mutate").mockImplementation(function (this: GanglionStore, fn: any) { mutations++; return originalMutate.call(this, fn); });

			const cancelled = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, { cwd: dir });

			assert.equal(mutations, 1);
			assert.match(cancelled.content[0].text, /release failed for ganglion-001\/alloc-missing: allocation alloc-missing not found/);
			assert.match(cancelled.content[0].text, /ganglion-001\/alloc-002 recorded; capacity released/);
			const group = (await ganglionStore.query((ledger) => ledger.get("ganglion-001"))).result!;
			assert.equal(group.members.find((member) => member.id === "lion-a")?.status, "busy");
			assert.equal(group.members.find((member) => member.id === "lion-b")?.status, "available");
			assert.equal(group.allocations.find((allocation) => allocation.id === "alloc-002")?.status, "cancelled");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("reports per-allocation cancellation errors while continuing other GANGLION groups", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-cancel-group-failure-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((ledger) => {
				const first = ledger.create({ members: [{ id: "lion-a" }, { id: "lion-b" }] });
				ledger.allocate(first.id, { tasks: [{ id: "task-a", title: "A" }, { id: "task-b", title: "B" }] });
				const second = ledger.create({ members: [{ id: "lion-c" }] });
				ledger.allocate(second.id, { tasks: [{ id: "task-c", title: "C" }] });
			});
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			await cerebel.execute("plan", { action: "plan_wave", assignments: [
				{ task_id: "task-a", agent_id: "lion-a", objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" },
				{ task_id: "task-b", agent_id: "lion-b", objective: "B", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-002" },
				{ task_id: "task-c", agent_id: "lion-c", objective: "C", ganglion_id: "ganglion-002", ganglion_allocation_id: "alloc-001" },
			] }, undefined, undefined, { cwd: dir });
			const originalMutate = GanglionStore.prototype.mutate;
			let mutations = 0;
			vi.spyOn(GanglionStore.prototype, "mutate").mockImplementation(function (this: GanglionStore, fn: any) {
				mutations++;
				if (mutations === 1) return Promise.reject(new Error("group write failed"));
				return originalMutate.call(this, fn);
			});

			const cancelled = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, { cwd: dir });

			assert.equal(mutations, 2);
			assert.match(cancelled.content[0].text, /release failed for ganglion-001\/alloc-001: group write failed/);
			assert.match(cancelled.content[0].text, /release failed for ganglion-001\/alloc-002: group write failed/);
			assert.match(cancelled.content[0].text, /ganglion-002\/alloc-001 recorded; capacity released/);
			assert.deepEqual((await ganglionStore.query((ledger) => ledger.get("ganglion-001"))).result?.members.map((member) => member.status), ["busy", "busy"]);
			assert.equal((await ganglionStore.query((ledger) => ledger.get("ganglion-002"))).result?.members[0]?.status, "available");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("releases linked GANGLION capacity when recording a terminal assignment", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-ganglion-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const cwd = dir;
			const ganglionStore = GanglionStore.fromCwd(cwd);
			await ganglionStore.mutate((l) => { const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] }); l.allocate(g.id, { tasks: [{ id: "task-api", title: "API" }] }); });
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((t) => t.name === "cerebel");
			const ctx = { cwd };
			await cerebel.execute("tool", { action: "plan_wave", assignments: [{ task_id: "task-api", agent_id: "lion-api", objective: "API", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] }, undefined, undefined, ctx);
			await cerebel.execute("tool", { action: "dispatch", links: [{ assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" }] }, undefined, undefined, ctx);
			const result = await cerebel.execute("tool", { action: "record", assignment_id: "assign-001", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001", outcome: "completed", summary: "done" }, undefined, undefined, ctx);
			assert.match(result.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded/);
			const { result: ganglion } = await ganglionStore.query((l) => l.get("ganglion-001"));
			assert.equal(ganglion?.members[0]?.status, "available");
			assert.equal(ganglion?.members[0]?.last_run_id, "run-001");
			assert.equal(ganglion?.allocations[0]?.status, "completed");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("retries an unreleased terminal GANGLION lease during wave cancellation", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-retry-terminal-lease-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((ledger) => {
				const group = ledger.create({ members: [{ id: "lion-a" }] });
				ledger.allocate(group.id, { tasks: [{ id: "task-a", title: "A" }] });
			});
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [
				{ task_id: "task-a", agent_id: "lion-a", objective: "A", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" },
				{ task_id: "task-b", agent_id: "lion-b", objective: "B" },
			] }, undefined, undefined, ctx);
			await cerebel.execute("dispatch", { action: "dispatch", links: [{ assignment_id: "assign-001" }] }, undefined, undefined, ctx);
			const originalMutate = GanglionStore.prototype.mutate;
			const failedRelease = vi.spyOn(GanglionStore.prototype, "mutate")
				.mockImplementationOnce(async () => { throw new Error("temporary GANGLION write failure"); })
				.mockImplementation(function (this: GanglionStore, fn: any) { return originalMutate.call(this, fn); });
			const recorded = await cerebel.execute("record", { action: "record", assignment_id: "assign-001", outcome: "completed", summary: "done" }, undefined, undefined, ctx);
			assert.match(recorded.content[0].text, /GANGLION release failed/);
			assert.equal((await ganglionStore.query((ledger) => ledger.get("ganglion-001"))).result?.members[0]?.status, "busy");
			failedRelease.mockRestore();
			const cancelled = await cerebel.execute("cancel", { action: "cancel", reason: "stop remaining work" }, undefined, undefined, ctx);
			assert.match(cancelled.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded; capacity released/);
			const group = (await ganglionStore.query((ledger) => ledger.get("ganglion-001"))).result;
			assert.equal(group?.members[0]?.status, "available");
			assert.equal(group?.allocations[0]?.status, "completed");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("does not release a recreated GANGLION identity from a stale terminal assignment", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-stale-ganglion-identity-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((ledger) => {
				const group = ledger.create({ members: [{ id: "lion-old" }] });
				ledger.allocate(group.id, { tasks: [{ id: "task-old", title: "Old" }] });
			});
			const cerebelStore = CerebelStore.fromCwd(dir);
			await cerebelStore.mutate((ledger) => {
				const wave = ledger.planWave({ assignments: [
					{ task_id: "task-old", agent_id: "lion-old", objective: "Old", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" },
					{ task_id: "task-pending", agent_id: "lion-pending", objective: "Pending" },
				] });
				ledger.dispatch(wave.id, { links: [{ assignment_id: "assign-001" }] });
				ledger.record(wave.id, { assignment_id: "assign-001", outcome: "completed", summary: "done" });
			});
			await ganglionStore.mutate((ledger) => {
				ledger.delete("ganglion-001");
				const replacement = ledger.create({ members: [{ id: "lion-new" }] });
				ledger.allocate(replacement.id, { tasks: [{ id: "task-new", title: "New" }] });
			});
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((tool) => tool.name === "cerebel");
			const cancelled = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, { cwd: dir });
			assert.match(cancelled.content[0].text, /GANGLION release failed for ganglion-001\/alloc-001/);
			const replacement = (await ganglionStore.query((ledger) => ledger.get("ganglion-002"))).result;
			assert.equal(replacement?.members[0]?.status, "busy");
			assert.equal(replacement?.members[0]?.current_allocation_id, "alloc-001");
		} finally {
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("never cancels a replacement LION incarnation through a stale wave link", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-stale-incarnation-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const lionStore = LionStore.fromCwd(dir);
			const original = (await lionStore.mutate((l) => l.create({ objective: "original" }))).result;
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((t) => t.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [{ agent_id: "lion-a", objective: "A" }] }, undefined, undefined, ctx);
			await cerebel.execute("dispatch", { action: "dispatch", links: [{ assignment_id: "assign-001", lion_run_id: original.id, lion_run_incarnation_id: original.incarnation_id }] }, undefined, undefined, ctx);
			await lionStore.mutate((l) => { l.finish(original.id, { output: "", report: null, status: "failed", error: "done" }); l.delete(original.id); });
			const replacement = (await lionStore.mutate((l) => l.create({ objective: "replacement" }))).result;
			let replacementSignals = 0;
			const owner = beginActiveRun({ namespaceId: lionStore.namespaceId, runId: replacement.id, incarnationId: replacement.incarnation_id }, "json");
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { replacementSignals++; return true; } });
			const cancelled = await cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, ctx);
			assert.equal(cancelled.isError, undefined);
			assert.equal(replacementSignals, 0);
			assert.equal((await lionStore.query((l) => l.get(replacement.id))).result?.control?.cancel_requested_at, undefined);
			finishActiveRun(owner);
		} finally {
			clearActiveRunsForTests();
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});

	it("releases linked GANGLION capacity when cancelling a wave", async () => {
		const oldRoot = process.env.NERVOUS_STATE_ROOT, oldProject = process.env.NERVOUS_PROJECT, oldContext = process.env.NERVOUS_CONTEXT;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cerebel-cancel-ganglion-"));
		process.env.NERVOUS_STATE_ROOT = dir; process.env.NERVOUS_PROJECT = "proj"; process.env.NERVOUS_CONTEXT = "ctx";
		try {
			const ganglionStore = GanglionStore.fromCwd(dir);
			await ganglionStore.mutate((l) => { const g = l.create({ members: [{ id: "lion-api", capabilities: ["api"] }] }); l.allocate(g.id, { tasks: [{ id: "task-api", title: "API" }] }); });
			const { pi, tools } = stubPi();
			factory(pi);
			const cerebel = tools.find((t) => t.name === "cerebel");
			const ctx = { cwd: dir };
			await cerebel.execute("plan", { action: "plan_wave", assignments: [{ task_id: "task-api", agent_id: "lion-api", objective: "API", ganglion_id: "ganglion-001", ganglion_allocation_id: "alloc-001" }] }, undefined, undefined, ctx);
			const lionStore = LionStore.fromCwd(dir);
			const lionRun = (await lionStore.mutate((l) => l.create({ objective: "active API work" }))).result;
			assert.equal(lionRun.id, "run-001");
			await cerebel.execute("dispatch", { action: "dispatch", links: [{ assignment_id: "assign-001", lion_run_id: lionRun.id, lion_run_incarnation_id: lionRun.incarnation_id }] }, undefined, undefined, ctx);
			const owner = beginActiveRun({ namespaceId: lionStore.namespaceId, runId: lionRun.id, incarnationId: lionRun.incarnation_id }, "json");
			let signalResolve!: () => void;
			const signalReceived = new Promise<void>((resolve) => { signalResolve = resolve; });
			attachActiveRunProcess(owner, { pid: process.pid, pgid: null, isAlive: () => true, cancel: () => { signalResolve(); return true; } });
			const cancelling = cerebel.execute("cancel", { action: "cancel", reason: "operator requested wave stop" }, undefined, undefined, ctx);
			await signalReceived;
			const beforeSettlement = (await ganglionStore.query((l) => l.get("ganglion-001"))).result;
			assert.equal(beforeSettlement?.members[0]?.status, "busy");
			assert.equal((await lionStore.query((l) => l.get(lionRun.id))).result?.control?.cancel_reason, "operator requested wave stop");
			await lionStore.mutate((l) => l.finish(lionRun.id, { output: "", report: null, status: "aborted", error: "cancelled" }));
			finishActiveRun(owner);
			const cancelled = await cancelling;
			assert.match(cancelled.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded; capacity released/);
			await ganglionStore.mutate((l) => l.allocate("ganglion-001", { tasks: [{ id: "task-new", title: "New work" }] }));
			const repeated = await cerebel.execute("cancel-again", { action: "cancel" }, undefined, undefined, ctx);
			assert.match(repeated.content[0].text, /capacity retained by a newer allocation/);
			const { result: ganglion } = await ganglionStore.query((l) => l.get("ganglion-001"));
			assert.equal(ganglion?.members[0]?.status, "busy");
			assert.equal(ganglion?.members[0]?.current_allocation_id, "alloc-002");
			assert.equal(ganglion?.allocations[0]?.status, "cancelled");
		} finally {
			clearActiveRunsForTests();
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});
});
