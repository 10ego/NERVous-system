import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { resolveNervousStateFile } from "@nervous-system/state";
import { Key, matchesKey, truncateToWidth, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { AmygdalaStore } from "../../amygdala/extension/backend.ts";
import type { Incident } from "../../amygdala/extension/schema.ts";
import { AxonStore } from "../../axon/extension/backend.ts";
import type { Task } from "../../axon/extension/schema.ts";
import { CerebelStore } from "../../cerebel/extension/backend.ts";
import type { Wave } from "../../cerebel/extension/schema.ts";
import { CortexStore } from "../../cortex/extension/backend.ts";
import type { Goal } from "../../cortex/extension/schema.ts";
import { GanglionStore } from "../../ganglion/extension/backend.ts";
import type { Ganglion } from "../../ganglion/extension/schema.ts";
import { canonicalLionNamespace, LionStore } from "../../lion/extension/backend.ts";
import type { LionRun } from "../../lion/extension/schema.ts";
import { MagiHistoryStore, type MagiRecord } from "../../magi/extension/history.ts";
import { SynapseStore } from "../../synapse/extension/backend.ts";
import type { Note } from "../../synapse/extension/schema.ts";

type Tab = "cortex" | "magi" | "axon" | "synapse" | "lion" | "cerebel" | "ganglion" | "amygdala";
const TABS: Tab[] = ["cortex", "magi", "axon", "synapse", "ganglion", "lion", "cerebel", "amygdala"];
export const DASHBOARD_AUTO_REFRESH_MS = 1000;

function formatRefreshInterval(ms: number): string {
	if (ms <= 0) return "manual";
	if (ms < 1000) return `auto ${ms}ms`;
	const seconds = ms / 1000;
	const label = Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
	return `auto ${label}`;
}

type Detail =
	| { kind: "cortex"; item: Goal }
	| { kind: "magi"; item: MagiRecord }
	| { kind: "axon"; item: Task }
	| { kind: "synapse"; item: Note }
	| { kind: "lion"; item: LionRun }
	| { kind: "cerebel"; item: Wave }
	| { kind: "ganglion"; item: Ganglion }
	| { kind: "amygdala"; item: Incident };

type RefreshTimer = ReturnType<typeof setTimeout>;

interface DashboardRefreshOptions {
	autoRefreshMs?: number;
	maxAutoRefreshMs?: number;
	changeDetector?: () => Promise<boolean | Tab[]>;
}

export interface DashboardData {
	goals: Goal[];
	magi: MagiRecord[];
	tasks: Task[];
	notes: Note[];
	runs: LionRun[];
	waves: Wave[];
	ganglions: Ganglion[];
	incidents: Incident[];
	warnings: string[];
	warningGroups?: Partial<Record<Tab, string[]>>;
	failedComponents?: Tab[];
}

export interface DashboardLoadOptions {
	retryAttempts?: number;
	retryDelayMs?: number;
}

const DASHBOARD_STATE_FILES = [
	["cortex", "cortex.json", "CORTEX_PATH"],
	["axon", "ledger.json", "AXON_LEDGER_PATH"],
	["synapse", "synapse.json", "SYNAPSE_PATH"],
	["lion", "runs.json", "LION_RUNS_PATH"],
	["cerebel", "cerebel.json", "CEREBEL_PATH"],
	["ganglion", "ganglion.json", "GANGLION_PATH"],
	["amygdala", "amygdala.json", "AMYGDALA_PATH"],
	["magi", "history.json", "MAGI_HISTORY_PATH"],
] as const;

const DASHBOARD_COMPONENTS = DASHBOARD_STATE_FILES.map(([component]) => component) as Tab[];

interface DashboardStateEntry { component: Tab; statePath: string }
function resolveDashboardStateEntries(cwd: string, resolveFile = resolveNervousStateFile): DashboardStateEntry[] {
	const canonical = DASHBOARD_STATE_FILES.map(([component, file, env]) => ({ component, statePath: resolveFile(cwd, component, file, env) })) as DashboardStateEntry[];
	const lionRuns = canonicalLionNamespace(canonical.find((entry) => entry.component === "lion")!.statePath);
	// Atomic sidecar replacement changes the directory fingerprint without touching
	// runs.json, so dashboard refresh observes coherent overlaid progress promptly.
	return [...canonical, { component: "lion", statePath: `${lionRuns}.progress` }];
}

async function dashboardStateFingerprints(entries: DashboardStateEntry[]): Promise<string[]> {
	return Promise.all(entries.map(async ({ statePath }) => {
		try { const stat = await fs.stat(statePath); return `${statePath}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
		catch (error) { return `${statePath}:${(error as NodeJS.ErrnoException).code ?? "missing"}`; }
	}));
}

export async function createDashboardChangeDetector(cwd: string, resolveFile = resolveNervousStateFile): Promise<() => Promise<Tab[]>> {
	const entries = resolveDashboardStateEntries(cwd, resolveFile);
	let previous = await dashboardStateFingerprints(entries);
	return async () => {
		const current = await dashboardStateFingerprints(entries);
		const changed = [...new Set(entries.flatMap((entry, index) => current[index] !== previous[index] ? [entry.component] : []))];
		previous = current;
		return changed;
	};
}

function clearDashboardComponent(data: DashboardData, component: Tab): void {
	switch (component) {
		case "cortex": data.goals = []; return;
		case "magi": data.magi = []; return;
		case "axon": data.tasks = []; return;
		case "synapse": data.notes = []; return;
		case "lion": data.runs = []; return;
		case "cerebel": data.waves = []; return;
		case "ganglion": data.ganglions = []; return;
		case "amygdala": data.incidents = []; return;
	}
}

function dashboardLoadWarning(component: Tab, error: unknown): string {
	const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 700);
	return `${component.toUpperCase()} unavailable (state unchanged). Recovery: /nervous:state or /nervous:reset. Reason: ${reason}`;
}

export async function loadDashboardData(
	cwd: string,
	components: Tab[] = DASHBOARD_COMPONENTS,
	previous?: DashboardData,
	options: DashboardLoadOptions = {},
): Promise<DashboardData> {
	const data: DashboardData = previous ? {
		...previous,
		goals: [...previous.goals], magi: [...previous.magi], tasks: [...previous.tasks], notes: [...previous.notes],
		runs: [...previous.runs], waves: [...previous.waves], ganglions: [...previous.ganglions], incidents: [...previous.incidents],
		warningGroups: { ...(previous.warningGroups ?? {}) },
	} : { goals: [], magi: [], tasks: [], notes: [], runs: [], waves: [], ganglions: [], incidents: [], warnings: [], warningGroups: {} };
	const warningGroups = data.warningGroups!;
	const failedComponents = new Set(previous?.failedComponents ?? []);
	await Promise.all([...new Set(components)].map(async (component) => {
		try {
			await retryDashboardRead(async () => {
				switch (component) {
				case "cortex": {
					const loaded = await CortexStore.fromCwd(cwd).query((store) => store.all().sort((a, b) => b.created_at.localeCompare(a.created_at)));
					data.goals = loaded.result; warningGroups.cortex = loaded.warnings; return;
				}
				case "magi": data.magi = await MagiHistoryStore.fromCwd(cwd).list(100); warningGroups.magi = []; return;
				case "axon": {
					const loaded = await AxonStore.fromCwd(cwd).query((ledger) => ledger.all());
					data.tasks = loaded.result; warningGroups.axon = loaded.warnings; return;
				}
				case "synapse": {
					const loaded = await SynapseStore.fromCwd(cwd).query((log) => log.list({ limit: 100 }));
					data.notes = loaded.result; warningGroups.synapse = loaded.warnings; return;
				}
				case "lion": {
					const loaded = await LionStore.fromCwd(cwd).query((ledger) => ledger.list({ limit: 100 }));
					data.runs = loaded.result; warningGroups.lion = loaded.warnings; return;
				}
				case "cerebel": {
					const loaded = await CerebelStore.fromCwd(cwd).query((ledger) => ledger.list({ limit: 100 }));
					data.waves = loaded.result; warningGroups.cerebel = loaded.warnings; return;
				}
				case "ganglion": {
					const loaded = await GanglionStore.fromCwd(cwd).query((ledger) => ledger.list({ limit: 100 }));
					data.ganglions = loaded.result; warningGroups.ganglion = loaded.warnings; return;
				}
				case "amygdala": {
					const loaded = await AmygdalaStore.fromCwd(cwd).query((ledger) => ledger.list({ limit: 100 }));
					data.incidents = loaded.result; warningGroups.amygdala = loaded.warnings; return;
				}
				}
			}, options);
			failedComponents.delete(component);
		} catch (error) {
			clearDashboardComponent(data, component);
			warningGroups[component] = [dashboardLoadWarning(component, error)];
			failedComponents.add(component);
		}
	}));
	data.warnings = DASHBOARD_COMPONENTS.flatMap((component) => warningGroups[component] ?? []);
	data.failedComponents = [...failedComponents];
	return data;
}

async function retryDashboardRead<T>(load: () => Promise<T>, options: DashboardLoadOptions): Promise<T> {
	const attempts = Math.max(1, Math.floor(options.retryAttempts ?? 3));
	const retryDelayMs = Math.max(0, options.retryDelayMs ?? 20);
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try { return await load(); }
		catch (error) {
			lastError = error;
			if (attempt < attempts && retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	throw lastError;
}

function countByStatus(items: Array<{ status?: string }>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) {
		const status = item.status ?? "unknown";
		out[status] = (out[status] ?? 0) + 1;
	}
	return out;
}

function statusOrder(status: string): number {
	const order = ["critical", "open", "needs_amygdala", "blocked", "failed", "escalated", "mitigating", "running", "in_progress", "ready", "queued", "needs_review", "planned", "pending", "analyzed", "verified", "completed", "resolved", "accepted", "cancelled", "aborted"];
	const i = order.indexOf(status);
	return i === -1 ? 999 : i;
}

function sortTasks(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || b.updated_at.localeCompare(a.updated_at));
}

function styleStatus(theme: Theme, status: string): string {
	if (["completed", "verified", "resolved", "accepted", "approved"].includes(status)) return theme.fg("success", status);
	if (["blocked", "failed", "needs_amygdala", "critical", "open", "aborted", "escalated"].includes(status)) return theme.fg("error", status);
	if (["in_progress", "running", "needs_review", "queued", "planned", "mitigating", "acknowledged"].includes(status)) return theme.fg("warning", status);
	return theme.fg("muted", status);
}

function styleEventType(theme: Theme, type: string): string {
	return theme.fg("muted", type);
}

function padVisible(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function hline(theme: Theme, width: number, left: string, right: string): string {
	return theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
}

function frameLine(content: string, width: number, theme: Theme, selected = false): string {
	const innerWidth = Math.max(0, width - 4);
	const padded = padVisible(content, innerWidth);
	const body = selected ? theme.bg("selectedBg", padded) : padded;
	return theme.fg("border", "│ ") + body + theme.fg("border", " │");
}

function emptyText(theme: Theme): string { return theme.italic(theme.fg("muted", "—")); }

function pushWrapped(lines: string[], label: string, value: string | null | undefined, width: number, theme: Theme): void {
	const inner = Math.max(8, width - 4);
	let rest = value?.trim() || "—";
	const isEmpty = rest === "—";
	const isBullet = label === "•";
	const rawPrefix = label ? (isBullet ? "• " : `${label}: `) : "";
	const styledPrefix = label ? (isBullet ? `${theme.fg("mdListBullet", "•")} ` : `${theme.fg("accent", theme.bold(label))}${theme.fg("muted", ": ")}`) : "";
	let first = true;
	let guard = 0;
	while (rest.length > 0 && guard++ < 40) {
		const prefixWidth = first ? visibleWidth(rawPrefix) : rawPrefix.length;
		const partWidth = Math.max(1, inner - prefixWidth);
		const part = truncateToWidth(rest, partWidth, "");
		const prefix = first ? styledPrefix : theme.fg("dim", " ".repeat(rawPrefix.length));
		const body = isEmpty ? emptyText(theme) : part;
		lines.push(frameLine(`${prefix}${body}`, width, theme));
		rest = rest.slice(Math.max(1, part.length)).trimStart();
		first = false;
	}
}

function pushParagraph(lines: string[], value: string | null | undefined, width: number, theme: Theme, color: "text" | "toolOutput" | "muted" = "text"): void {
	const inner = Math.max(8, width - 4);
	let rest = value?.trim() || "—";
	const isEmpty = rest === "—";
	let guard = 0;
	while (rest.length > 0 && guard++ < 60) {
		const part = truncateToWidth(rest, inner, "");
		lines.push(frameLine(isEmpty ? emptyText(theme) : theme.fg(color, part), width, theme));
		rest = rest.slice(Math.max(1, part.length)).trimStart();
	}
}

function pushSection(lines: string[], title: string, width: number, theme: Theme): void {
	if (lines.length > 0) lines.push(frameLine("", width, theme));
	const inner = Math.max(8, width - 4);
	const label = ` ${title.toUpperCase()} `;
	const left = "╾";
	const right = "─".repeat(Math.max(0, inner - visibleWidth(label) - visibleWidth(left)));
	lines.push(frameLine(`${theme.fg("borderAccent", left)}${theme.fg("accent", theme.bold(label))}${theme.fg("borderMuted", right)}`, width, theme));
}

function pushBullets(lines: string[], label: string, items: string[], width: number, theme: Theme): void {
	pushSection(lines, label, width, theme);
	if (!items.length) {
		lines.push(frameLine(emptyText(theme), width, theme));
		return;
	}
	for (const item of items) pushWrapped(lines, "•", item, width, theme);
}

function terminalRunForMember(g: Ganglion, member: Ganglion["members"][number], runs: LionRun[]): LionRun | undefined {
	if (member.status !== "busy" || !member.current_allocation_id) return undefined;
	const allocation = g.allocations.find((a) => a.id === member.current_allocation_id);
	if (!allocation) return undefined;
	const terminal = runs.filter((run) => ["completed", "blocked", "failed", "aborted"].includes(run.status));
	if (allocation.lion_run_id) return terminal.find((run) => run.id === allocation.lion_run_id);
	return terminal
		.filter((run) => run.agent_id === member.id && run.task_id === allocation.task_id)
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

function activeGanglionAllocations(g: Ganglion): Ganglion["allocations"] {
	return g.allocations.filter((a) => !["completed", "blocked", "failed", "cancelled"].includes(a.status));
}

function ganglionConsistencyNote(g: Ganglion, runs: LionRun[], goals: Goal[]): string | null {
	const busy = g.members.filter((m) => m.status === "busy");
	const staleBusy = busy.filter((m) => terminalRunForMember(g, m, runs));
	if (staleBusy.length) return `${staleBusy.length} busy member(s) have terminal LION runs; run ganglion reconcile.`;
	const activeAllocations = activeGanglionAllocations(g);
	const allGoalsTerminal = goals.length > 0 && goals.every((goal) => ["completed", "cancelled"].includes(goal.status));
	if (g.status !== "completed" && allGoalsTerminal && busy.length === 0 && activeAllocations.length === 0) {
		return `Stored status is ${g.status}, but all CORTEX goals are terminal and GANGLION has no busy members or active allocations.`;
	}
	return null;
}

function pushGanglionMembersBox(lines: string[], width: number, theme: Theme, ganglion: Ganglion, runs: LionRun[]): void {
	lines.push(frameLine(theme.fg("accent", "Members"), width, theme));
	if (ganglion.members.length === 0) {
		lines.push(frameLine("No LION members registered.", width, theme));
		return;
	}

	const available = Math.max(16, width - 4);
	const statusCol = Math.min(18, Math.max(8, available - 12));
	const nameCol = Math.max(8, available - statusCol - 7);
	const top = `┌${"─".repeat(nameCol + 2)}┬${"─".repeat(statusCol + 2)}┐`;
	const mid = `├${"─".repeat(nameCol + 2)}┼${"─".repeat(statusCol + 2)}┤`;
	const bottom = `└${"─".repeat(nameCol + 2)}┴${"─".repeat(statusCol + 2)}┘`;
	const row = (name: string, status: string, styledStatus = status) => `│ ${padVisible(name, nameCol)} │ ${padVisible(styledStatus, statusCol)} │`;

	lines.push(frameLine(theme.fg("border", top), width, theme));
	lines.push(frameLine(row(theme.bold("LION"), theme.bold("STATUS")), width, theme));
	lines.push(frameLine(theme.fg("border", mid), width, theme));
	for (const member of ganglion.members) {
		const staleRun = terminalRunForMember(ganglion, member, runs);
		const status = staleRun ? `${member.status} ⚠ ${staleRun.status}` : member.status;
		lines.push(frameLine(row(member.id, status, staleRun ? theme.fg("warning", status) : styleStatus(theme, member.status)), width, theme));
	}
	lines.push(frameLine(theme.fg("border", bottom), width, theme));
}

function summary(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort((a, b) => statusOrder(a[0]) - statusOrder(b[0]) || a[0].localeCompare(b[0]))
		.slice(0, 2)
		.map(([k, v]) => `${k}:${v}`)
		.join(" ") || "empty";
}

const PROGRESS_STALE_MS = 2 * 60_000;

function relativeAge(iso: string | null | undefined, nowMs = Date.now()): { label: string; stale: boolean } {
	if (!iso) return { label: "unknown age", stale: false };
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return { label: "unknown age", stale: false };
	const delta = Math.max(0, nowMs - ts);
	const seconds = Math.floor(delta / 1000);
	const label = seconds < 5 ? "just now"
		: seconds < 60 ? `${seconds}s ago`
		: seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
		: `${Math.floor(seconds / 3600)}h ago`;
	return { label, stale: delta > PROGRESS_STALE_MS };
}

export function describeLionProgress(run: LionRun, nowMs = Date.now()): string {
	const p = run.progress;
	if (!p) return run.status === "running" || run.status === "queued" ? "no progress snapshot yet" : "no progress snapshot";
	const age = relativeAge(p.last_event_at, nowMs);
	const bits = [p.activity || p.event];
	if (p.active_tools.length) bits.push(`tools:${p.active_tools.join(",")}`);
	if (p.tool_uses > 0) bits.push(`${p.tool_uses} tool${p.tool_uses === 1 ? "" : "s"}`);
	if (p.turn_count > 0) bits.push(`turns:${p.turn_count}`);
	if (typeof p.token_total === "number" && p.token_total > 0) bits.push(`${p.token_total} tokens`);
	bits.push(`${age.stale && (run.status === "running" || run.status === "queued") ? "stale " : ""}${age.label}`);
	return bits.join(" · ");
}

function lionRunRefKey(runId: string, incarnationId: string | null | undefined): string {
	return JSON.stringify([runId, incarnationId ?? null]);
}

export function summarizeWaveProgress(wave: Wave, runs: LionRun[], nowMs = Date.now()): string {
	if (!wave.assignments.length) return "no assignments";
	const runsByRef = new Map(runs.map((run) => [lionRunRefKey(run.id, run.incarnation_id), run]));
	const linkedRuns = wave.assignments
		.map((a) => a.lion_run_id ? runsByRef.get(lionRunRefKey(a.lion_run_id, a.lion_run_incarnation_id)) : undefined)
		.filter((r): r is LionRun => Boolean(r));
	const assignmentCounts = countByStatus(wave.assignments);
	const assignmentSummary = Object.entries(assignmentCounts)
		.sort((a, b) => statusOrder(a[0]) - statusOrder(b[0]) || a[0].localeCompare(b[0]))
		.map(([status, count]) => `${status}:${count}`)
		.join(" ");
	if (!linkedRuns.length) return `assignments ${assignmentSummary}; no linked LION runs`;
	const runCounts = countByStatus(linkedRuns);
	const runSummary = Object.entries(runCounts)
		.sort((a, b) => statusOrder(a[0]) - statusOrder(b[0]) || a[0].localeCompare(b[0]))
		.map(([status, count]) => `lion-${status}:${count}`)
		.join(" ");
	const active = linkedRuns.find((r) => r.status === "running" || r.status === "queued");
	const activity = active ? `; active ${active.id}: ${describeLionProgress(active, nowMs)}` : "";
	return `assignments ${assignmentSummary}; ${runSummary}${activity}`;
}

type Column = { text: string; width?: number };
function columnLine(totalWidth: number, columns: Column[]): string {
	const gap = "  ";
	const gapWidth = Math.max(0, columns.length - 1) * visibleWidth(gap);
	const fixedWidth = columns.reduce((sum, col) => sum + (col.width ?? 0), 0);
	const flexCount = Math.max(1, columns.filter((col) => col.width === undefined).length);
	let remaining = Math.max(4, totalWidth - gapWidth - fixedWidth);
	return columns.map((col, index) => {
		const flexLeft = columns.slice(index).filter((c) => c.width === undefined).length;
		const width = col.width ?? Math.max(4, index === columns.length - 1 ? remaining : Math.floor(remaining / Math.max(1, flexLeft)));
		if (col.width === undefined) remaining -= width;
		return padVisible(col.text, width);
	}).join(gap);
}

function headerColumnLine(theme: Theme, width: number, columns: Column[]): string {
	return theme.fg("muted", theme.bold(columnLine(width, columns)));
}

export class NervousDashboard implements Component {
	private tabIndex = 0;
	private selected = 0;
	private detail: Detail | null = null;
	private detailScroll = 0;
	private detailLineCount = 0;
	private readonly detailViewportRows = 20;
	private refreshing = false;
	private reloadPending = false;
	private pendingFullReload = false;
	private reloadFailed = false;
	private readonly dirtyVersions = new Map<Tab, number>();
	private readonly inFlightVersions = new Map<Tab, number>();
	private showRefreshing = false;
	private closed = false;
	private error: string | null = null;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private refreshTimer: RefreshTimer | null = null;
	private readonly autoRefreshMs: number;
	private readonly maxAutoRefreshMs: number;
	private readonly changeDetector?: () => Promise<boolean | Tab[]>;
	private nextAutoRefreshMs: number;

	constructor(
		private data: DashboardData,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly refresh: (components?: Tab[]) => Promise<DashboardData>,
		options: DashboardRefreshOptions = {},
	) {
		this.autoRefreshMs = options.autoRefreshMs ?? DASHBOARD_AUTO_REFRESH_MS;
		this.maxAutoRefreshMs = Math.max(this.autoRefreshMs, options.maxAutoRefreshMs ?? 8_000);
		this.changeDetector = options.changeDetector;
		this.nextAutoRefreshMs = this.autoRefreshMs;
		for (const component of data.failedComponents ?? []) this.markDirty([component]);
		this.reloadFailed = this.dirtyVersions.size > 0;
		this.startAutoRefresh(this.autoRefreshMs);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			if (this.detail) return this.closeDetail();
			this.closeDashboard();
			return;
		}
		if (this.detail) {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) this.closeDetail();
			else if (matchesKey(data, Key.up) || data === "k") this.scrollDetail(-1);
			else if (matchesKey(data, Key.down) || data === "j") this.scrollDetail(1);
			else if (matchesKey(data, Key.pageUp)) this.scrollDetail(-this.detailViewportRows);
			else if (matchesKey(data, Key.pageDown)) this.scrollDetail(this.detailViewportRows);
			else if (matchesKey(data, Key.home)) this.scrollDetailTo(0);
			else if (matchesKey(data, Key.end)) this.scrollDetailTo(Number.MAX_SAFE_INTEGER);
			else if (data === "r") this.reload();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return this.switchTab(1);
		if (matchesKey(data, Key.left)) return this.switchTab(-1);
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.enter)) {
			const item = this.items()[this.selected];
			if (item) { this.detail = item; this.detailScroll = 0; }
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "r") this.reload();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const w = Math.max(1, width);
		const lines: string[] = [hline(this.theme, w, "┌", "┐"), frameLine(this.header(w), w, this.theme), hline(this.theme, w, "├", "┤")];
		if (this.error) lines.push(frameLine(this.theme.fg("error", this.error), w, this.theme));
		for (const warning of this.data.warnings.slice(0, 2)) lines.push(frameLine(this.theme.fg("warning", warning), w, this.theme));
		if (this.refreshing && this.showRefreshing) lines.push(frameLine(this.theme.fg("accent", "Refreshing…"), w, this.theme));
		if (this.detail) this.renderDetailViewport(lines, w);
		else this.renderList(lines, w);
		lines.push(hline(this.theme, w, "├", "┤"));
		const refreshLabel = formatRefreshInterval(this.autoRefreshMs);
		lines.push(frameLine(this.detail ? `↑/↓ scroll • pgup/pgdn jump • esc/backspace close detail • r refresh • ${refreshLabel} • q close` : `←/→ or tab switch systems • ↑/↓ select • enter details • r refresh • ${refreshLabel} • q/esc close`, w, this.theme));
		lines.push(hline(this.theme, w, "└", "┘"));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private get tab(): Tab { return TABS[this.tabIndex]!; }

	private header(width: number): string {
		const parts = TABS.map((tab) => {
			const active = tab === this.tab;
			const label = `${active ? "●" : "○"} ${tab.toUpperCase()} ${this.itemsFor(tab).length}`;
			return this.theme.fg(active ? "accent" : "muted", label);
		});
		return truncateToWidth(parts.join("  "), Math.max(0, width - 4));
	}

	private itemsFor(tab: Tab): Detail[] {
		switch (tab) {
			case "cortex": return this.data.goals.map((item) => ({ kind: "cortex", item }));
			case "magi": return this.data.magi.map((item) => ({ kind: "magi", item }));
			case "axon": return sortTasks(this.data.tasks).map((item) => ({ kind: "axon", item }));
			case "synapse": return this.data.notes.map((item) => ({ kind: "synapse", item }));
			case "lion": return this.data.runs.map((item) => ({ kind: "lion", item }));
			case "cerebel": return this.data.waves.map((item) => ({ kind: "cerebel", item }));
			case "ganglion": return this.data.ganglions.map((item) => ({ kind: "ganglion", item }));
			case "amygdala": return this.data.incidents.map((item) => ({ kind: "amygdala", item }));
		}
	}

	private items(): Detail[] { return this.itemsFor(this.tab); }

	private renderList(lines: string[], width: number): void {
		const items = this.items();
		lines.push(frameLine(`${this.tab.toUpperCase()} ${summary(this.countsForTab())}`, width, this.theme));
		if (items.length === 0) {
			const msg = this.tab === "magi" ? "No MAGI history yet. Future /magi or magi tool calls will be recorded." : `No ${this.tab.toUpperCase()} records found.`;
			lines.push(frameLine(msg, width, this.theme));
			return;
		}
		const maxRows = 16;
		if (this.tab === "synapse") lines.push(frameLine(this.theme.fg("muted", "SYNAPSE is an event log; note types are historical coordination events, not current task status."), width, this.theme));
		lines.push(frameLine(this.headerRow(width), width, this.theme));
		lines.push(frameLine(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 4))), width, this.theme));
		const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), Math.max(0, items.length - maxRows)));
		for (let i = 0; i < items.slice(start, start + maxRows).length; i++) {
			const absolute = start + i;
			lines.push(frameLine(this.row(items[absolute]!, width), width, this.theme, absolute === this.selected));
		}
		if (items.length > maxRows) lines.push(frameLine(this.theme.fg("dim", `${start + 1}-${Math.min(start + maxRows, items.length)} of ${items.length}`), width, this.theme));
	}

	private countsForTab(): Record<string, number> {
		switch (this.tab) {
			case "magi": return countByStatus(this.data.magi.map((r) => ({ status: r.output.confidence })));
			case "synapse": return countByStatus(this.data.notes.map((n) => ({ status: n.type })));
			case "cortex": return countByStatus(this.data.goals);
			case "axon": return countByStatus(this.data.tasks);
			case "lion": return countByStatus(this.data.runs);
			case "cerebel": return countByStatus(this.data.waves);
			case "ganglion": return countByStatus(this.data.ganglions);
			case "amygdala": return countByStatus(this.data.incidents);
		}
	}

	private headerRow(width: number): string {
		const inner = Math.max(8, width - 4);
		switch (this.tab) {
			case "cortex": return headerColumnLine(this.theme, inner, [{ text: "GOAL", width: 9 }, { text: "STATUS", width: 13 }, { text: "LINKED", width: 8 }, { text: "FLAG", width: 7 }, { text: "SUMMARY" }]);
			case "magi": return headerColumnLine(this.theme, inner, [{ text: "RECORD", width: 9 }, { text: "CONF", width: 8 }, { text: "COUNCIL", width: 16 }, { text: "ISSUE" }]);
			case "axon": return headerColumnLine(this.theme, inner, [{ text: "TASK", width: 9 }, { text: "STATUS", width: 14 }, { text: "PRI", width: 8 }, { text: "REVIEW", width: 13 }, { text: "TITLE" }]);
			case "synapse": return headerColumnLine(this.theme, inner, [{ text: "NOTE", width: 9 }, { text: "EVENT", width: 12 }, { text: "AGENT", width: 14 }, { text: "TASK", width: 17 }, { text: "MESSAGE" }]);
			case "lion": return headerColumnLine(this.theme, inner, [{ text: "RUN", width: 9 }, { text: "AGENT", width: 18 }, { text: "STATUS", width: 20 }, { text: "TASK", width: 11 }, { text: "PROGRESS / OBJECTIVE" }]);
			case "cerebel": return headerColumnLine(this.theme, inner, [{ text: "WAVE", width: 9 }, { text: "STATUS", width: 14 }, { text: "ASSIGN", width: 8 }, { text: "PROGRESS / DECISION" }]);
			case "ganglion": return headerColumnLine(this.theme, inner, [{ text: "GROUP", width: 12 }, { text: "STATUS", width: 12 }, { text: "MEMBERS", width: 9 }, { text: "ACTIVE", width: 8 }, { text: "NAME" }]);
			case "amygdala": return headerColumnLine(this.theme, inner, [{ text: "RISK", width: 9 }, { text: "STATUS", width: 14 }, { text: "SEV", width: 9 }, { text: "RECOMMEND", width: 18 }, { text: "TITLE" }]);
		}
	}

	private row(detail: Detail, width: number): string {
		const inner = Math.max(8, width - 4);
		switch (detail.kind) {
			case "cortex": return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleStatus(this.theme, detail.item.status), width: 13 }, { text: String(detail.item.axon_task_ids.length), width: 8 }, { text: detail.item.plan?.magi_used ? this.theme.fg("accent", "MAGI") : "", width: 7 }, { text: detail.item.intent.goal }]);
			case "magi": return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleStatus(this.theme, detail.item.output.confidence), width: 8 }, { text: detail.item.output.council_used.join(","), width: 16 }, { text: detail.item.input.issue }]);
			case "axon": return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleStatus(this.theme, detail.item.status), width: 14 }, { text: detail.item.priority, width: 8 }, { text: detail.item.review_status, width: 13 }, { text: detail.item.title }]);
			case "synapse": {
				const task = detail.item.task_id ? this.data.tasks.find((t) => t.id === detail.item.task_id) : undefined;
				return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleEventType(this.theme, detail.item.type), width: 12 }, { text: detail.item.agent_id ?? "general", width: 14 }, { text: task ? `${detail.item.task_id}:${task.status}` : (detail.item.task_id ?? "general"), width: 17 }, { text: detail.item.message }]);
			}
			case "lion": {
				const task = detail.item.task_id ? this.data.tasks.find((t) => t.id === detail.item.task_id) : undefined;
				const historical = task?.status === "completed" && ["failed", "blocked", "aborted"].includes(detail.item.status) ? this.theme.fg("muted", "+historical") : "";
				const progress = ["queued", "running"].includes(detail.item.status) && detail.item.progress ? describeLionProgress(detail.item) : detail.item.objective;
				return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: detail.item.agent_id, width: 18 }, { text: `${styleStatus(this.theme, detail.item.status)}${historical ? ` ${historical}` : ""}`, width: 20 }, { text: detail.item.task_id ?? "—", width: 11 }, { text: progress }]);
			}
			case "cerebel": {
				const progress = summarizeWaveProgress(detail.item, this.data.runs);
				const decision = detail.item.decision ? `decision:${detail.item.decision.decision}` : "";
				return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleStatus(this.theme, detail.item.status), width: 14 }, { text: String(detail.item.assignments.length), width: 8 }, { text: [progress, decision].filter(Boolean).join(" · ") }]);
			}
			case "ganglion": {
				const note = ganglionConsistencyNote(detail.item, this.data.runs, this.data.goals);
				return columnLine(inner, [{ text: detail.item.id, width: 12 }, { text: styleStatus(this.theme, detail.item.status), width: 12 }, { text: String(detail.item.members.length), width: 9 }, { text: `${activeGanglionAllocations(detail.item).length}${note ? this.theme.fg("warning", " ⚠") : ""}`, width: 8 }, { text: detail.item.name }]);
			}
			case "amygdala": return columnLine(inner, [{ text: detail.item.id, width: 9 }, { text: styleStatus(this.theme, detail.item.status), width: 14 }, { text: detail.item.severity, width: 9 }, { text: detail.item.recommendation, width: 18 }, { text: detail.item.title }]);
		}
	}

	private renderDetailViewport(lines: string[], width: number): void {
		const detailLines: string[] = [];
		this.renderDetail(detailLines, width);
		this.detailLineCount = detailLines.length;
		const maxScroll = Math.max(0, detailLines.length - this.detailViewportRows);
		this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll));
		if (detailLines.length > this.detailViewportRows) {
			const from = this.detailScroll + 1;
			const to = Math.min(this.detailScroll + this.detailViewportRows, detailLines.length);
			lines.push(frameLine(this.theme.fg("muted", `Scroll ${from}-${to} of ${detailLines.length}`), width, this.theme));
		}
		lines.push(...detailLines.slice(this.detailScroll, this.detailScroll + this.detailViewportRows));
	}

	private renderDetail(lines: string[], width: number): void {
		const detail = this.detail;
		if (!detail) return;
		switch (detail.kind) {
			case "cortex": return this.renderCortex(lines, width, detail.item);
			case "magi": return this.renderMagi(lines, width, detail.item);
			case "axon": return this.renderAxon(lines, width, detail.item);
			case "synapse": return this.renderSynapse(lines, width, detail.item);
			case "lion": return this.renderLion(lines, width, detail.item);
			case "cerebel": return this.renderCerebel(lines, width, detail.item);
			case "ganglion": return this.renderGanglion(lines, width, detail.item);
			case "amygdala": return this.renderAmygdala(lines, width, detail.item);
		}
	}

	private title(lines: string[], width: number, text: string): void { lines.push(frameLine(this.theme.fg("accent", this.theme.bold(text)), width, this.theme)); }
	private renderCortex(lines: string[], width: number, g: Goal): void {
		this.title(lines, width, `CORTEX ${g.id}: ${g.intent.goal}`);
		pushWrapped(lines, "Status", g.status, width, this.theme);
		pushWrapped(lines, "Intent", g.intent.intent_summary, width, this.theme);
		if (g.intent.framing) {
			const framing = g.intent.framing;
			if (framing.context.length) pushWrapped(lines, "Frame context", framing.context.join(" | "), width, this.theme);
			if (framing.scope.length) pushWrapped(lines, "Frame scope", framing.scope.join(" | "), width, this.theme);
			if (framing.non_goals.length) pushWrapped(lines, "Frame non-goals", framing.non_goals.join(" | "), width, this.theme);
			if (framing.assumptions.length) pushWrapped(lines, "Frame assumptions", framing.assumptions.join(" | "), width, this.theme);
			if (framing.open_questions.length) pushWrapped(lines, "Frame questions", framing.open_questions.join(" | "), width, this.theme);
			if (framing.candidate_options.length) pushWrapped(lines, "Frame options", framing.candidate_options.join(" | "), width, this.theme);
			if (framing.decision_needed) pushWrapped(lines, "Frame decision", framing.decision_needed, width, this.theme);
		}
		pushWrapped(lines, "Success", g.intent.success_criteria.join(" | "), width, this.theme);
		pushWrapped(lines, "Risks", g.intent.risks.map((r) => `${r.severity}:${r.description}`).join(" | "), width, this.theme);
		pushWrapped(lines, "MAGI", g.intent.needs_magi || g.plan?.magi_used ? `needed:${g.intent.needs_magi} used:${Boolean(g.plan?.magi_used)} ${g.plan?.magi_output_ref ?? ""}` : "not used", width, this.theme);
		const completedTasks = this.data.tasks.filter((t) => t.status === "completed").length;
		pushWrapped(lines, "AXON linked", g.axon_task_ids.join(", "), width, this.theme);
		pushWrapped(lines, "AXON context", `${completedTasks}/${this.data.tasks.length} completed in this context; ${g.axon_task_ids.length} linked to this goal`, width, this.theme);
		if (g.status === "completed" && this.data.tasks.length > g.axon_task_ids.length) pushWrapped(lines, "Consistency", "Goal is completed but not every AXON task in this context is linked; this may be historical follow-up work or missing cortex link bookkeeping.", width, this.theme);
		if (g.plan?.subtasks.length) pushWrapped(lines, "Plan", g.plan.subtasks.map((s) => `${s.id}:${s.axon_task_id ?? "unlinked"}`).join(" | "), width, this.theme);
		pushWrapped(lines, "Verification", g.verification ? `${g.verification.recommendation}; ${g.verification.checks.filter((c) => c.passed).length}/${g.verification.checks.length} checks passed` : "—", width, this.theme);
		pushWrapped(lines, "Concerns", g.verification?.concerns.join(" | "), width, this.theme);
	}
	private renderMagi(lines: string[], width: number, r: MagiRecord): void {
		this.title(lines, width, `MAGI ${r.id}`);
		pushSection(lines, "Request", width, this.theme);
		pushWrapped(lines, "Issue", r.input.issue, width, this.theme);
		pushWrapped(lines, "Decision", r.input.decision_needed, width, this.theme);
		if (r.input.options?.length) pushWrapped(lines, "Options", r.input.options.join(" | "), width, this.theme);
		pushWrapped(lines, "Council", `${r.output.council_used.join(", ")} • synthesizer ${r.output.meta.synthesizer} • critique ${r.output.meta.critique_used ? "on" : "off"} • source ${r.source}`, width, this.theme);
		pushWrapped(lines, "Confidence", r.output.confidence, width, this.theme);

		pushSection(lines, "Final recommendation", width, this.theme);
		pushParagraph(lines, r.output.final_recommendation, width, this.theme, "toolOutput");

		pushBullets(lines, "Agreement", r.output.points_of_agreement, width, this.theme);
		pushBullets(lines, "Disagreement", r.output.points_of_disagreement, width, this.theme);
		pushBullets(lines, "Risks", r.output.risks, width, this.theme);
		pushBullets(lines, "Rejected options", r.output.rejected_options, width, this.theme);

		for (const op of r.output.individual_opinions) {
			pushSection(lines, `Councillor ${op.councillor}`, width, this.theme);
			pushWrapped(lines, "Position", op.position, width, this.theme);
			pushWrapped(lines, "Verdict", op.recommendation, width, this.theme);
			if (op.concerns.length) pushWrapped(lines, "Concerns", op.concerns.map((c) => `• ${c}`).join("  "), width, this.theme);
			if (op.critiques?.length) pushWrapped(lines, "Critiques", op.critiques.map((c) => `${c.of}: ${c.note}`).join(" | "), width, this.theme);
		}

		if (r.output.meta.warnings.length) pushBullets(lines, "Warnings", r.output.meta.warnings, width, this.theme);
	}
	private renderAxon(lines: string[], width: number, t: Task): void {
		this.title(lines, width, `AXON ${t.id}: ${t.title}`);
		pushWrapped(lines, "Status", `${t.status} • priority ${t.priority} • review ${t.review_status}`, width, this.theme);
		pushWrapped(lines, "Assigned", t.assigned_to, width, this.theme);
		pushWrapped(lines, "Description", t.description, width, this.theme);
		pushWrapped(lines, "Blockers", t.blockers.filter((b) => !b.resolved).map((b) => b.text).join(" | "), width, this.theme);
		pushWrapped(lines, "Latest note", t.progress_notes.at(-1)?.text, width, this.theme);
		pushWrapped(lines, "Artifacts", t.artifacts.map((a) => `${a.kind ?? "file"}:${a.path}`).join(" | "), width, this.theme);
	}
	private renderSynapse(lines: string[], width: number, n: Note): void {
		this.title(lines, width, `SYNAPSE ${n.id}`);
		const task = n.task_id ? this.data.tasks.find((t) => t.id === n.task_id) : undefined;
		pushWrapped(lines, "Event type", styleEventType(this.theme, n.type), width, this.theme);
		pushWrapped(lines, "Interpretation", "Historical coordination note; this is not a live status that must be closed.", width, this.theme);
		pushWrapped(lines, "Task", task ? `${n.task_id} • AXON ${task.status} • ${task.title}` : n.task_id, width, this.theme);
		pushWrapped(lines, "Agent", n.agent_id, width, this.theme);
		pushWrapped(lines, "Message", n.message, width, this.theme);
	}
	private renderLion(lines: string[], width: number, r: LionRun): void {
		this.title(lines, width, `LION ${r.agent_id}: ${r.id}`);
		const task = r.task_id ? this.data.tasks.find((t) => t.id === r.task_id) : undefined;
		pushWrapped(lines, "Status", r.status, width, this.theme);
		pushWrapped(lines, "Progress", describeLionProgress(r), width, this.theme);
		pushWrapped(lines, "Task", task ? `${r.task_id} • AXON ${task.status} • ${task.title}` : r.task_id, width, this.theme);
		if (task?.status === "completed" && ["failed", "blocked", "aborted"].includes(r.status)) pushWrapped(lines, "Interpretation", "Historical failed/blocked LION attempt; linked AXON task is now completed by a later path.", width, this.theme);
		pushWrapped(lines, "Objective", r.objective, width, this.theme);
		pushWrapped(lines, "Report", r.report?.summary, width, this.theme);
		pushWrapped(lines, "Tests", r.report?.tests_run.join(", "), width, this.theme);
		pushWrapped(lines, "Blockers", r.report?.blockers.join(" | ") || r.error, width, this.theme);
		pushWrapped(lines, "Next", r.report?.next_steps.join(" | "), width, this.theme);
	}
	private renderCerebel(lines: string[], width: number, w: Wave): void {
		this.title(lines, width, `CEREBEL ${w.id}`);
		pushWrapped(lines, "Status", w.status, width, this.theme);
		pushWrapped(lines, "Goal", w.goal_id, width, this.theme);
		pushWrapped(lines, "Progress", summarizeWaveProgress(w, this.data.runs), width, this.theme);
		pushWrapped(lines, "Decision", w.decision ? `${w.decision.decision}: ${w.decision.reason}` : "—", width, this.theme);
		pushWrapped(lines, "Assignments", w.assignments.map((a) => {
			const linked = a.lion_run_id ? this.data.runs.find((r) => r.id === a.lion_run_id && (r.incarnation_id ?? null) === (a.lion_run_incarnation_id ?? null)) : undefined;
			const progress = linked?.progress ? ` progress:${describeLionProgress(linked)}` : "";
			return `${a.id}/${a.agent_id}/${a.status}${a.lion_run_id ? `/${a.lion_run_id}` : ""}${a.ganglion_allocation_id ? `/ganglion:${a.ganglion_id ?? "?"}/${a.ganglion_allocation_id}` : ""}${progress}`;
		}).join(" | "), width, this.theme);
	}
	private renderGanglion(lines: string[], width: number, g: Ganglion): void {
		this.title(lines, width, `GANGLION ${g.id}: ${g.name}`);
		pushWrapped(lines, "Status", g.status, width, this.theme);
		const note = ganglionConsistencyNote(g, this.data.runs, this.data.goals);
		if (note) pushWrapped(lines, "Consistency", note, width, this.theme);
		pushWrapped(lines, "Goal", g.goal_id, width, this.theme);
		pushGanglionMembersBox(lines, width, this.theme, g, this.data.runs);
		pushWrapped(lines, "Allocations", g.allocations.map((a) => `${a.id}/${a.member_id}/${a.status}`).join(" | "), width, this.theme);
	}
	private renderAmygdala(lines: string[], width: number, i: Incident): void { this.title(lines, width, `AMYGDALA ${i.id}: ${i.title}`); pushWrapped(lines, "Status", `${i.status} • ${i.severity}/${i.category} • ${i.recommendation}`, width, this.theme); pushWrapped(lines, "Source", `${i.source}${i.source_id ? `:${i.source_id}` : ""}`, width, this.theme); pushWrapped(lines, "Description", i.description, width, this.theme); pushWrapped(lines, "Reason", i.reason, width, this.theme); pushWrapped(lines, "Mitigation", i.mitigation_plan.join(" | "), width, this.theme); pushWrapped(lines, "Latest note", i.notes.at(-1)?.text, width, this.theme); }

	private closeDetail(): void { this.detail = null; this.detailScroll = 0; this.invalidate(); this.tui.requestRender(); }
	private closeDashboard(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done();
	}
	private switchTab(delta: number): void { this.tabIndex = (this.tabIndex + delta + TABS.length) % TABS.length; this.selected = 0; this.detailScroll = 0; this.invalidate(); this.tui.requestRender(); }
	private move(delta: number): void { this.selected = Math.max(0, Math.min(Math.max(0, this.items().length - 1), this.selected + delta)); this.invalidate(); this.tui.requestRender(); }
	private scrollDetail(delta: number): void { this.scrollDetailTo(this.detailScroll + delta); }
	private scrollDetailTo(target: number): void {
		const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportRows);
		this.detailScroll = Math.max(0, Math.min(maxScroll, target));
		this.invalidate();
		this.tui.requestRender();
	}
	private markDirty(components: Tab[]): void {
		for (const component of components) this.dirtyVersions.set(component, (this.dirtyVersions.get(component) ?? 0) + 1);
	}
	private startAutoRefresh(intervalMs: number): void {
		if (intervalMs <= 0 || this.closed) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void (async () => {
				let detected: boolean | Tab[] = !this.changeDetector;
				try { if (this.changeDetector) detected = await this.changeDetector(); }
				catch { detected = true; }
				if (this.closed) return;
				const components = detected === true ? DASHBOARD_COMPONENTS : detected === false ? [] : detected;
				if (components.length) this.markDirty(components);
				const dirty = [...this.dirtyVersions.keys()].filter((component) => !this.refreshing || (this.dirtyVersions.get(component) ?? 0) > (this.inFlightVersions.get(component) ?? -1));
				const observedFingerprintChange = Boolean(this.changeDetector) && components.length > 0;
				const retryingFailedLoad = this.reloadFailed && dirty.length > 0 && !observedFingerprintChange;
				if (dirty.length) this.reload({ showIndicator: false, components: dirty });
				this.nextAutoRefreshMs = dirty.length && !retryingFailedLoad
					? this.autoRefreshMs
					: Math.min(this.maxAutoRefreshMs, Math.max(this.autoRefreshMs, this.nextAutoRefreshMs * 2));
				this.startAutoRefresh(this.nextAutoRefreshMs);
			})();
		}, intervalMs);
		const maybeUnref = this.refreshTimer as RefreshTimer & { unref?: () => void };
		maybeUnref.unref?.();
	}
	dispose(): void {
		this.closed = true;
		if (!this.refreshTimer) return;
		clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}
	private reload(options: { showIndicator?: boolean; components?: Tab[] } = {}): void {
		if (this.closed) return;
		if (this.refreshing) {
			this.reloadPending = true;
			if (!options.components) this.pendingFullReload = true;
			return;
		}
		const requested = options.components ?? DASHBOARD_COMPONENTS;
		const versions = new Map(requested.map((component) => [component, this.dirtyVersions.get(component) ?? 0]));
		this.inFlightVersions.clear();
		for (const [component, version] of versions) this.inFlightVersions.set(component, version);
		this.refreshing = true;
		this.showRefreshing = options.showIndicator ?? true;
		this.error = null;
		if (this.showRefreshing) {
			this.invalidate();
			this.tui.requestRender();
		}
		void this.refresh(options.components)
			.then((data) => {
				if (this.closed) return;
				const selectedKey = this.currentSelectedKey();
				const detailKey = this.detail ? this.detailKey(this.detail) : null;
				this.data = data;
				const failed = new Set(data.failedComponents ?? []);
				for (const [component, version] of versions) {
					if (!failed.has(component) && (this.dirtyVersions.get(component) ?? 0) === version) this.dirtyVersions.delete(component);
				}
				for (const component of failed) if (!this.dirtyVersions.has(component)) this.markDirty([component]);
				this.reloadFailed = this.dirtyVersions.size > 0;
				this.restoreSelection(selectedKey);
				this.restoreDetail(detailKey);
			})
			.catch((err) => {
				if (!this.closed) {
					for (const component of requested) if (!this.dirtyVersions.has(component)) this.markDirty([component]);
					this.reloadFailed = true;
					this.error = err instanceof Error ? err.message : String(err);
				}
			})
			.finally(() => {
				this.refreshing = false;
				this.inFlightVersions.clear();
				this.showRefreshing = false;
				if (this.closed) return;
				this.selected = Math.min(this.selected, Math.max(0, this.items().length - 1));
				this.invalidate();
				this.tui.requestRender();
				if (this.reloadPending) {
					const full = this.pendingFullReload;
					this.reloadPending = false;
					this.pendingFullReload = false;
					this.reload({ showIndicator: false, components: full ? undefined : [...this.dirtyVersions.keys()] });
				}
			});
	}
	private currentSelectedKey(): string | null {
		const item = this.items()[this.selected];
		return item ? this.detailKey(item) : null;
	}
	private detailKey(detail: Detail): string {
		if (detail.kind === "lion") return `lion:${JSON.stringify([detail.item.id, detail.item.incarnation_id ?? null])}`;
		return `${detail.kind}:${detail.item.id}`;
	}
	private findDetail(key: string | null): Detail | null {
		if (!key) return null;
		const separator = key.indexOf(":");
		const kind = separator >= 0 ? key.slice(0, separator) : "";
		if (!kind || !TABS.includes(kind as Tab)) return null;
		return this.itemsFor(kind as Tab).find((detail) => this.detailKey(detail) === key) ?? null;
	}
	private restoreSelection(key: string | null): void {
		const items = this.items();
		if (key) {
			const index = items.findIndex((item) => this.detailKey(item) === key);
			if (index >= 0) {
				this.selected = index;
				return;
			}
			if (key.startsWith("lion:")) {
				this.selected = 0;
				return;
			}
		}
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
	}
	private restoreDetail(key: string | null): void {
		if (!key) return;
		const next = this.findDetail(key);
		if (next) this.detail = next;
		else {
			this.detail = null;
			this.detailScroll = 0;
		}
	}
}

async function showDashboard(ctx: ExtensionCommandContext): Promise<void> {
	const changeDetector = await createDashboardChangeDetector(ctx.cwd);
	let current = await loadDashboardData(ctx.cwd);
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new NervousDashboard(current, tui, theme, done, async (components) => {
			current = await loadDashboardData(ctx.cwd, components ?? DASHBOARD_COMPONENTS, components ? current : undefined);
			return current;
		}, { changeDetector }),
		{ overlay: true, overlayOptions: { anchor: "center", width: "90%", minWidth: 72, maxHeight: "85%", margin: 1 } },
	);
}

export default function dashboardExtension(pi: ExtensionAPI) {
	pi.registerCommand("nervous:dashboard", {
		description: "Open NERVous dashboard",
		handler: async (_args, ctx) => { await showDashboard(ctx); },
	});
}
