import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import factory, { createDashboardChangeDetector, describeLionProgress, loadDashboardData, NervousDashboard, summarizeWaveProgress } from "../extension/index.ts";
import { AxonStore } from "../../axon/extension/backend.ts";
import { LionStore } from "../../lion/extension/backend.ts";

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

const emptyDashboardData = (overrides: Record<string, unknown> = {}) => ({
	goals: [],
	magi: [],
	tasks: [],
	notes: [],
	runs: [],
	waves: [],
	ganglions: [],
	incidents: [],
	warnings: [],
	...overrides,
}) as any;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
} as any;

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

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

	it("auto-refreshes while open and cleans up its timer", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(emptyDashboardData({ runs: [{ id: "run-001", status: "running" }] }));
		const tui = { requestRender: vi.fn() } as any;
		const dashboard = new NervousDashboard(emptyDashboardData(), tui, theme, vi.fn(), refresh, { autoRefreshMs: 100 });
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(refresh.mock.calls.length, 1);
		dashboard.dispose();
		await vi.advanceTimersByTimeAsync(300);
		assert.equal(refresh.mock.calls.length, 1);
	});

	it("resolves dashboard state paths only once for repeated fingerprint checks", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-path-cache-"));
		const resolver = vi.fn((_cwd: string, component: string, file: string) => path.join(dir, component, file));
		const changed = await createDashboardChangeDetector(dir, resolver as never);
		assert.equal(resolver.mock.calls.length, 8);
		await changed();
		await changed();
		assert.equal(resolver.mock.calls.length, 8);
	});

	it("backs off without ledger reloads until state fingerprints change", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockResolvedValue(emptyDashboardData());
		const changeDetector = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, maxAutoRefreshMs: 800, changeDetector });
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(refresh.mock.calls.length, 0);
		await vi.advanceTimersByTimeAsync(199);
		assert.equal(changeDetector.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(refresh.mock.calls.length, 1);
		dashboard.dispose();
	});

	it("detects LION sidecar progress without a runs.json replacement", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-sidecar-fingerprint-"));
		const target = path.join(dir, "runs.json");
		const oldPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = target;
		try {
			const store = LionStore.fromCwd(dir);
			const run = (await store.mutate((ledger) => ledger.create({ objective: "dashboard progress" }))).result;
			const changed = await createDashboardChangeDetector(dir);
			await store.flushProgress(run, { event: "message", activity: "working", active_tools: [], tool_uses: 0, turn_count: 1, token_total: null, last_text: null, last_event_at: new Date().toISOString() });
			assert.deepEqual(await changed(), ["lion"]);
			assert.equal((await loadDashboardData(dir, ["lion"])).runs[0]?.progress?.activity, "working");
		} finally {
			if (oldPath === undefined) delete process.env.LION_RUNS_PATH; else process.env.LION_RUNS_PATH = oldPath;
		}
	});

	it("detects an atomic same-size replacement even when mtime is preserved", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-fingerprint-"));
		const target = path.join(dir, "runs.json");
		const replacement = path.join(dir, "replacement.json");
		const oldPath = process.env.LION_RUNS_PATH;
		process.env.LION_RUNS_PATH = target;
		try {
			await fs.writeFile(target, "aaaa");
			const original = await fs.stat(target);
			const changed = await createDashboardChangeDetector(dir);
			await fs.writeFile(replacement, "bbbb");
			await fs.utimes(replacement, original.atime, original.mtime);
			await fs.rename(replacement, target);
			assert.deepEqual(await changed(), ["lion"]);
		} finally {
			if (oldPath === undefined) delete process.env.LION_RUNS_PATH; else process.env.LION_RUNS_PATH = oldPath;
		}
	});

	it("reloads only the changed component and preserves other data and warnings", async () => {
		const run = { id: "run-new", status: "running" } as any;
		const previous = emptyDashboardData({
			tasks: [{ id: "task-kept" }],
			warnings: ["axon warning"],
			warningGroups: { axon: ["axon warning"] },
		});
		const lionFromCwd = vi.spyOn(LionStore, "fromCwd").mockReturnValue({ query: async () => ({ result: [run], warnings: ["lion warning"] }) } as any);
		const axonFromCwd = vi.spyOn(AxonStore, "fromCwd");
		const loaded = await loadDashboardData(process.cwd(), ["lion"], previous);
		assert.equal(lionFromCwd.mock.calls.length, 1);
		assert.equal(axonFromCwd.mock.calls.length, 0);
		assert.equal(loaded.runs[0]?.id, "run-new");
		assert.equal(loaded.tasks[0]?.id, "task-kept");
		assert.deepEqual(loaded.warnings, ["axon warning", "lion warning"]);
	});

	it("passes exact changed component keys to automatic refresh", async () => {
		vi.useFakeTimers();
		const changeDetector = vi.fn().mockResolvedValue(["lion"]);
		const refresh = vi.fn().mockResolvedValue(emptyDashboardData());
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, changeDetector });
		await vi.advanceTimersByTimeAsync(100);
		assert.deepEqual(refresh.mock.calls[0]?.[0], ["lion"]);
		dashboard.dispose();
	});

	it("retries a detected change after a transient reload failure", async () => {
		vi.useFakeTimers();
		const changeDetector = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
		const refresh = vi.fn().mockRejectedValueOnce(new Error("transient read failure")).mockResolvedValue(emptyDashboardData({ runs: [{ id: "latest" }] }));
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, changeDetector });
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(refresh.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(100);
		assert.equal(refresh.mock.calls.length, 2);
		assert.equal(changeDetector.mock.calls.length, 1, "dirty reload should retry without requiring another fingerprint change");
		assert.equal((dashboard as any).data.runs[0]?.id, "latest");
		dashboard.dispose();
	});

	it("stops pending change-detection work when disposed", async () => {
		vi.useFakeTimers();
		let resolveDetection!: (changed: boolean) => void;
		const changeDetector = vi.fn(() => new Promise<boolean>((resolve) => { resolveDetection = resolve; }));
		const refresh = vi.fn().mockResolvedValue(emptyDashboardData());
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, changeDetector });
		await vi.advanceTimersByTimeAsync(100);
		dashboard.dispose();
		resolveDetection(true);
		await vi.advanceTimersByTimeAsync(1000);
		assert.equal(refresh.mock.calls.length, 0);
		assert.equal(changeDetector.mock.calls.length, 1);
	});

	it("does not queue an empty follow-up while the current dirty version is loading", async () => {
		vi.useFakeTimers();
		const changeDetector = vi.fn().mockResolvedValueOnce(["lion"]).mockResolvedValue([]);
		let resolveRefresh!: (data: any) => void;
		const refresh = vi.fn(() => new Promise<any>((resolve) => { resolveRefresh = resolve; }));
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, changeDetector });
		await vi.advanceTimersByTimeAsync(200);
		assert.equal(refresh.mock.calls.length, 1);
		resolveRefresh(emptyDashboardData({ runs: [{ id: "latest" }] }));
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(refresh.mock.calls.length, 1);
		dashboard.dispose();
	});

	it("replays a change detected while the previous dashboard reload is in flight", async () => {
		vi.useFakeTimers();
		const changeDetector = vi.fn().mockResolvedValue(true);
		const refreshResolvers: Array<(data: any) => void> = [];
		const refresh = vi.fn(() => new Promise<any>((resolve) => { refreshResolvers.push(resolve); }));
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 100, changeDetector });
		await vi.advanceTimersByTimeAsync(200);
		assert.equal(refresh.mock.calls.length, 1, "second change should be latched while first reload runs");
		refreshResolvers[0]!(emptyDashboardData({ runs: [{ id: "old" }] }));
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(refresh.mock.calls.length, 2);
		refreshResolvers[1]!(emptyDashboardData({ runs: [{ id: "latest" }] }));
		await vi.advanceTimersByTimeAsync(0);
		assert.equal((dashboard as any).data.runs[0]?.id, "latest");
		dashboard.dispose();
	});

	it("derives the auto-refresh footer label from the configured interval", () => {
		const dashboard = new NervousDashboard(emptyDashboardData(), { requestRender: vi.fn() } as any, theme, vi.fn(), vi.fn(), { autoRefreshMs: 2500 });
		const text = dashboard.render(100).join("\n");
		assert.match(text, /auto 2\.5s/);
		dashboard.dispose();
	});

	it("preserves an open detail view across reloads", async () => {
		const oldRun = { id: "run-001", agent_id: "lion-a", status: "running", task_id: null, objective: "old", context: "", started_at: "2026-07-08T12:00:00.000Z", updated_at: "2026-07-08T12:00:00.000Z" } as any;
		const newRun = { ...oldRun, status: "completed", objective: "new", report: { outcome: "completed", summary: "done", changed_files: [], tests_run: [], blockers: [], next_steps: [] } } as any;
		const refresh = vi.fn().mockResolvedValue(emptyDashboardData({ runs: [newRun] }));
		const tui = { requestRender: vi.fn() } as any;
		const dashboard = new NervousDashboard(emptyDashboardData({ runs: [oldRun] }), tui, theme, vi.fn(), refresh, { autoRefreshMs: 0 });
		(dashboard as any).tabIndex = 5; // LION tab
		(dashboard as any).selected = 0;
		(dashboard as any).detail = { kind: "lion", item: oldRun };
		dashboard.handleInput("r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal((dashboard as any).detail?.item.status, "completed");
		assert.equal((dashboard as any).detail?.item.objective, "new");
		assert.equal((dashboard as any).selected, 0);
	});

	it("does not reopen a detail view the user closed during refresh", async () => {
		const oldRun = { id: "run-001", agent_id: "lion-a", status: "running", task_id: null, objective: "old", context: "", started_at: "2026-07-08T12:00:00.000Z", updated_at: "2026-07-08T12:00:00.000Z" } as any;
		const newRun = { ...oldRun, status: "completed" } as any;
		let resolveRefresh: ((value: any) => void) | undefined;
		const refresh = vi.fn((): Promise<any> => new Promise((resolve) => { resolveRefresh = resolve; }));
		const dashboard = new NervousDashboard(emptyDashboardData({ runs: [oldRun] }), { requestRender: vi.fn() } as any, theme, vi.fn(), refresh, { autoRefreshMs: 0 });
		(dashboard as any).tabIndex = 5; // LION tab
		(dashboard as any).selected = 0;
		(dashboard as any).detail = { kind: "lion", item: oldRun };
		dashboard.handleInput("r");
		dashboard.handleInput("\u001b");
		resolveRefresh?.(emptyDashboardData({ runs: [newRun] }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal((dashboard as any).detail, null);
	});

	it("shows objectives rather than stale progress activity for terminal LION rows", () => {
		const run = { id: "run-001", agent_id: "lion-a", status: "completed", task_id: null, objective: "Implement exact provenance", progress: { activity: "message complete", last_event_at: new Date().toISOString() } } as any;
		const dashboard = new NervousDashboard(emptyDashboardData({ runs: [run] }), { requestRender: vi.fn() } as any, theme, vi.fn(), vi.fn(), { autoRefreshMs: 0 });
		const row = (dashboard as any).row({ kind: "lion", item: run }, 120);
		assert.match(row, /Implement exact provenance/);
		assert.doesNotMatch(row, /message complete/);
		dashboard.dispose();
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
				{ id: "assign-001", agent_id: "lion-a", status: "dispatched", lion_run_id: "run-001", lion_run_incarnation_id: "inc-001" },
				{ id: "assign-002", agent_id: "lion-b", status: "completed", lion_run_id: "run-002", lion_run_incarnation_id: "inc-002" },
			],
		} as any;
		const runs = [
			{ id: "run-001", incarnation_id: "inc-001", status: "running", progress: { event: "message", activity: "writing tests", active_tools: [], tool_uses: 1, turn_count: 1, token_total: null, last_text: null, last_event_at: "2026-07-08T12:00:09.000Z" } },
			{ id: "run-002", incarnation_id: "inc-002", status: "completed" },
		] as any;
		const text = summarizeWaveProgress(wave, runs, now);
		assert.match(text, /assignments completed:1 dispatched:1/);
		assert.match(text, /lion-running:1/);
		assert.match(text, /lion-completed:1/);
		assert.match(text, /active run-001: writing tests/);
	});

	it("does not join a stale CEREBEL link to a reused LION id", () => {
		const wave = { assignments: [{ status: "dispatched", lion_run_id: "run-001", lion_run_incarnation_id: "inc-old" }] } as any;
		const runs = [{ id: "run-001", incarnation_id: "legacy", status: "running", progress: { activity: "secret replacement progress" } }] as any;
		const text = summarizeWaveProgress(wave, runs);
		assert.match(text, /no linked LION runs/);
		assert.doesNotMatch(text, /secret replacement/);
	});
});
