import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { describe, it } from "vitest";
import { GanglionStore } from "../../ganglion/extension/backend.ts";
import { LionStore } from "../../lion/extension/backend.ts";
import { attachActiveRunProcess, beginActiveRun, clearActiveRunsForTests, finishActiveRun } from "../../lion/extension/active-runs.ts";
import factory, { runWaveBatchFailureResult } from "../extension/index.ts";
import { CerebelLedger } from "../extension/store.ts";
import { RunWaveBatchError } from "../extension/run-wave.ts";

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
		const result = runWaveBatchFailureResult(new RunWaveBatchError("finish failed", partial, [new Error("finish failed")]));
		assert.equal(result.isError, true);
		assert.equal(result.details.wave?.id, wave.id);
		assert.equal(result.details.run_wave?.assignment_results[0]?.lion_run_id, "run-001");
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
			await cerebel.execute("tool", { action: "dispatch", links: [{ assignment_id: "assign-001", lion_run_id: "run-001" }] }, undefined, undefined, ctx);
			const result = await cerebel.execute("tool", { action: "record", assignment_id: "assign-001", lion_run_id: "run-001", outcome: "completed", summary: "done" }, undefined, undefined, ctx);
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
			const cancelling = cerebel.execute("cancel", { action: "cancel" }, undefined, undefined, ctx);
			await signalReceived;
			const beforeSettlement = (await ganglionStore.query((l) => l.get("ganglion-001"))).result;
			assert.equal(beforeSettlement?.members[0]?.status, "busy");
			await lionStore.mutate((l) => l.finish(lionRun.id, { output: "", report: null, status: "aborted", error: "cancelled" }));
			finishActiveRun(owner);
			const cancelled = await cancelling;
			assert.match(cancelled.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded/);
			const repeated = await cerebel.execute("cancel-again", { action: "cancel" }, undefined, undefined, ctx);
			assert.match(repeated.content[0].text, /GANGLION ganglion-001\/alloc-001 recorded/);
			const { result: ganglion } = await ganglionStore.query((l) => l.get("ganglion-001"));
			assert.equal(ganglion?.members[0]?.status, "available");
			assert.equal(ganglion?.members[0]?.current_allocation_id, null);
			assert.equal(ganglion?.allocations[0]?.status, "cancelled");
		} finally {
			clearActiveRunsForTests();
			if (oldRoot === undefined) delete process.env.NERVOUS_STATE_ROOT; else process.env.NERVOUS_STATE_ROOT = oldRoot;
			if (oldProject === undefined) delete process.env.NERVOUS_PROJECT; else process.env.NERVOUS_PROJECT = oldProject;
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
		}
	});
});
