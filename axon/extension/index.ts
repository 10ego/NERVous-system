/**
 * AXON — pi extension entry point.
 *
 * Registers the `axon` tool (single tool, `action` discriminator) and the
 * `/axon`, `/axon:list`, `/axon:task`, `/axon:reset` commands, backed by the
 * durable file store.
 *
 * AXON is the NERVous System's durable work state: CORTEX writes the plan into
 * it, CEREBEL reads ready tasks from it, and LIONs update status as they work.
 * It is project-scoped file state (not session state) so it survives compaction,
 * restarts, interruption, and separate subprocess agents.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AxonStore } from "./backend.ts";
import {
	AxonError,
	AxonToolParams,
	type AxonToolInput,
	type BoardSummary,
	type Task,
	type TaskStatus,
} from "./schema.ts";
import { renderAxonCall, renderAxonResult, summarizeBoard, summarizeList, summarizeTask } from "./render.ts";
import { Ledger, type ListFilter } from "./store.ts";

/* ----------------------------- shared result shape ---------------------- */

interface AxonDetails {
	action: string;
	task?: Task;
	tasks?: Task[];
	summary?: BoardSummary;
	project?: string;
	promoted?: string[];
	deleted?: boolean;
	error?: string;
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: AxonDetails;
	isError?: boolean;
};

function ok(action: string, text: string, details: Omit<AxonDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, error: message }, isError: true };
}

/** Run a mutating op against the store; map AxonError to a clean tool error. */
async function runOp(
	store: AxonStore,
	action: string,
	op: (ledger: Ledger) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.mutate(op);
		return result;
	} catch (e) {
		if (e instanceof AxonError) return fail(action, `axon ${action} failed (${e.code}): ${e.message}`);
		return fail(action, `axon ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Run a read-only query against the store. */
async function runQuery(
	store: AxonStore,
	action: string,
	op: (ledger: Ledger) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.query(op);
		return result;
	} catch (e) {
		return fail(action, `axon ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function projectName(cwd: string): string {
	return path.basename(cwd) || cwd;
}

/* ----------------------------- the tool --------------------------------- */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "axon",
		label: "AXON",
		description: [
			"Durable task ledger for coordinated multi-agent work. Survives compaction, restarts, and interruption.",
			"Single tool with an `action`. CORTEX writes the plan here, CEREBEL/LIONs read & update it.",
			"Actions: create, get, list, update, set_status, add_note, add_blocker, resolve_blocker,",
			"add_artifact, set_review, assign, delete, recompute, summary.",
		].join(" "),
		promptSnippet: "Read/write the AXON durable task ledger (create/get/list/update/set_status/summary)",
		promptGuidelines: [
			"Use the axon tool with action 'summary' or 'list' (ready_only) to find the next work to do.",
			"Use the axon tool to persist tasks before starting them so work survives interruption and restart.",
			"Use axon action 'set_status' to move work through pending→ready→in_progress→needs_review→completed.",
			"When blocked or uncertain, set a task status to 'blocked' or 'needs_amygdala' via axon rather than stalling silently.",
			"Use axon action 'add_note' for concise progress updates so other agents can see current state.",
		],
		parameters: AxonToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = AxonStore.fromCwd(ctx.cwd);
			const project = projectName(ctx.cwd);
			const p = params as AxonToolInput;
			const action = p.action;

			switch (action) {
				case "create": {
					if (!p.title) return fail(action, "create requires `title`.");
					return runOp(store, action, (l) => {
						const t = l.create({
							title: p.title!,
							description: p.description,
							parent_id: p.parent_id,
							dependencies: p.dependencies,
							assigned_to: p.assigned_to,
							priority: p.priority,
						});
						return ok(action, `Created ${t.id}: ${t.title} [${t.status}]`, { task: t });
					});
				}

				case "get": {
					if (!p.id) return fail(action, "get requires `id`.");
					return runQuery(store, action, (l) => {
						const t = l.get(p.id!);
						if (!t) return fail(action, `Task ${p.id} not found.`);
						return ok(action, summarizeTask(t), { task: t });
					});
				}

				case "list": {
					return runQuery(store, action, (l) => {
						const filter: ListFilter = {
							status: p.status_filter as TaskStatus | undefined,
							assigned_to: p.assigned_filter,
							parent_id: p.parent_filter,
							ready_only: p.ready_only,
							blocked_only: p.blocked_only,
						};
						const tasks = l.list(filter);
						return ok(action, summarizeList(tasks), { tasks });
					});
				}

				case "update": {
					if (!p.id) return fail(action, "update requires `id`.");
					return runOp(store, action, (l) => {
						const t = l.update(p.id!, {
							title: p.title,
							description: p.description,
							parent_id: p.parent_id,
							dependencies: p.dependencies,
							assigned_to: p.assigned_to,
							priority: p.priority,
						});
						return ok(action, `Updated ${t.id}.`, { task: t });
					});
				}

				case "set_status": {
					if (!p.id) return fail(action, "set_status requires `id`.");
					if (!p.status) return fail(action, "set_status requires `status`.");
					return runOp(store, action, (l) => {
						const t = l.setStatus(p.id!, p.status as TaskStatus, p.note);
						return ok(action, `${t.id} → ${t.status}.`, { task: t });
					});
				}

				case "add_note": {
					if (!p.id) return fail(action, "add_note requires `id`.");
					if (!p.note) return fail(action, "add_note requires `note`.");
					return runOp(store, action, (l) => {
						const t = l.addNote(p.id!, p.note!, p.author);
						return ok(action, `Added note to ${t.id}.`, { task: t });
					});
				}

				case "add_blocker": {
					if (!p.id) return fail(action, "add_blocker requires `id`.");
					if (!p.blocker) return fail(action, "add_blocker requires `blocker`.");
					return runOp(store, action, (l) => {
						const t = l.addBlocker(p.id!, p.blocker!);
						return ok(action, `Added blocker to ${t.id}.`, { task: t });
					});
				}

				case "resolve_blocker": {
					if (!p.id) return fail(action, "resolve_blocker requires `id`.");
					if (p.blocker_index === undefined) return fail(action, "resolve_blocker requires `blocker_index`.");
					return runOp(store, action, (l) => {
						const t = l.resolveBlocker(p.id!, p.blocker_index!);
						return ok(action, `Resolved blocker #${p.blocker_index} on ${t.id}.`, { task: t });
					});
				}

				case "add_artifact": {
					if (!p.id) return fail(action, "add_artifact requires `id`.");
					if (!p.artifact) return fail(action, "add_artifact requires `artifact`.");
					return runOp(store, action, (l) => {
						const t = l.addArtifact(p.id!, { path: p.artifact!.path, kind: p.artifact!.kind });
						return ok(action, `Added artifact to ${t.id}.`, { task: t });
					});
				}

				case "set_review": {
					if (!p.id) return fail(action, "set_review requires `id`.");
					if (!p.review_status) return fail(action, "set_review requires `review_status`.");
					return runOp(store, action, (l) => {
						const t = l.setReview(p.id!, p.review_status!);
						return ok(action, `${t.id} review → ${t.review_status}.`, { task: t });
					});
				}

				case "assign": {
					if (!p.id) return fail(action, "assign requires `id`.");
					if (!p.assigned_to) return fail(action, "assign requires `assigned_to`.");
					return runOp(store, action, (l) => {
						const t = l.assign(p.id!, p.assigned_to!);
						return ok(action, `${t.id} assigned to ${t.assigned_to}.`, { task: t });
					});
				}

				case "delete": {
					if (!p.id) return fail(action, "delete requires `id`.");
					return runOp(store, action, (l) => {
						const removed = l.delete(p.id!);
						return removed
							? ok(action, `Deleted ${p.id}.`, { deleted: true })
							: fail(action, `Task ${p.id} not found.`);
					});
				}

				case "recompute": {
					return runOp(store, action, (l) => {
						const promoted = l.recompute();
						return ok(
							action,
							promoted.length ? `Promoted to ready: ${promoted.join(", ")}.` : "No tasks ready to promote.",
							{ promoted },
						);
					});
				}

				case "summary": {
					return runQuery(store, action, (l) => {
						const summary = l.summary();
						return ok(action, summarizeBoard(summary, project), { summary, project });
					});
				}

				default:
					return fail(action, `Unknown action: ${action as string}`);
			}
		},

		renderCall(args, theme) {
			return renderAxonCall(args as { action: string; id?: string; title?: string; status?: string }, theme as never);
		},
		renderResult(result, options, theme) {
			return renderAxonResult(
				result as Parameters<typeof renderAxonResult>[0],
				options as Parameters<typeof renderAxonResult>[1],
				theme as never,
			);
		},
	});

	/* ------------------------------- commands ------------------------------ */

	pi.registerCommand("axon", {
		description: "Show the AXON task board summary",
		handler: async (_args, ctx) => {
			const store = AxonStore.fromCwd(ctx.cwd);
			const { result } = await store.query((l) => l.summary());
			post(ctx, pi, summarizeBoard(result, projectName(ctx.cwd)), { summary: result });
		},
	});

	pi.registerCommand("axon:list", {
		description: "List AXON tasks (optionally by status: ready, in_progress, blocked, ...)",
		handler: async (args, ctx) => {
			const store = AxonStore.fromCwd(ctx.cwd);
			const status = (args ?? "").trim() || undefined;
			const { result } = await store.query((l) =>
				l.list({
					status: status as TaskStatus | undefined,
					ready_only: status === "ready",
					blocked_only: status === "blocked",
				}),
			);
			post(ctx, pi, summarizeList(result), { tasks: result });
		},
	});

	pi.registerCommand("axon:task", {
		description: "Show details of one AXON task",
		handler: async (args, ctx) => {
			const id = (args ?? "").trim();
			if (!id) {
				ctx.ui.notify("Usage: /axon:task <id>", "info");
				return;
			}
			const store = AxonStore.fromCwd(ctx.cwd);
			const { result } = await store.query((l) => l.get(id));
			if (!result) {
				ctx.ui.notify(`Task ${id} not found.`, "warning");
				return;
			}
			post(ctx, pi, summarizeTask(result), { task: result });
		},
	});

	pi.registerCommand("axon:reset", {
		description: "DANGER: wipe the AXON ledger (backs up to ledger.json.bak first)",
		handler: async (_args, ctx) => {
			const store = AxonStore.fromCwd(ctx.cwd);
			const { result: count } = await store.query((l) => l.summary().total);
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Reset AXON ledger?",
					`This deletes ${count} task(s). A backup is written to .pi/axon/ledger.json.bak first. This cannot be undone.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			await store.backend.wipe();
			ctx.ui.notify(`AXON ledger reset (${count} tasks removed; backup at .pi/axon/ledger.json.bak).`, "info");
		},
	});
}

/* ----------------------------- helpers ---------------------------------- */

/** Post a markdown summary into the transcript (or notify in non-interactive mode). */
function post(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	markdown: string,
	_details: Record<string, unknown>,
): void {
	if (ctx.hasUI) {
		pi.sendMessage(
			{ customType: "axon", content: markdown, display: true, details: _details },
			{ triggerTurn: false },
		);
	} else {
		ctx.ui.notify(markdown, "info");
	}
}
