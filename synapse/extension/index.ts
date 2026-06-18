/**
 * SYNAPSE — pi extension entry point.
 *
 * Registers the `synapse` tool (single tool, `action` discriminator) and the
 * `/synapse`, `/synapse:task`, `/synapse:clear` commands, backed by the durable
 * (but retention-bounded) note store.
 *
 * SYNAPSE is the NERVous System's transient shared coordination scratchpad:
 * LIONs post short coordination notes (work started/completed, blockers, risks,
 * decisions) and CEREBEL reads them to coordinate a GANGLION. It is NOT long-term
 * memory — retention prunes old notes so it stays transient.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SynapseStore } from "./backend.ts";
import {
	type Note,
	NOTE_TYPES,
	type NoteType,
	SynapseError,
	SynapseToolParams,
	type SynapseToolInput,
} from "./schema.ts";
import {
	renderSynapseCall,
	renderSynapseResult,
	summarizeBoard,
	summarizeFeed,
} from "./render.ts";
import type { ListFilter } from "./store.ts";

interface SynapseDetails {
	action: string;
	note?: Note;
	notes?: Note[];
	summary?: ReturnType<SynapseStore["query"]> extends Promise<{ result: infer R }> ? R : never;
	pruned?: number;
	cleared?: number;
	error?: string;
}

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SynapseDetails;
	isError?: boolean;
};

function ok(action: string, text: string, details: Omit<SynapseDetails, "action"> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { action, ...details } };
}
function fail(action: string, message: string): ToolResult {
	return { content: [{ type: "text", text: message }], details: { action, error: message }, isError: true };
}

async function runOp(
	store: SynapseStore,
	action: string,
	op: (log: import("./store.ts").NoteLog) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.mutate(op);
		return result;
	} catch (e) {
		if (e instanceof SynapseError) return fail(action, `synapse ${action} failed (${e.code}): ${e.message}`);
		return fail(action, `synapse ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function runQuery(
	store: SynapseStore,
	action: string,
	op: (log: import("./store.ts").NoteLog) => ToolResult,
): Promise<ToolResult> {
	try {
		const { result } = await store.query(op);
		return result;
	} catch (e) {
		return fail(action, `synapse ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function projectName(cwd: string): string {
	return path.basename(cwd) || cwd;
}

/** Resolve a task_id that may be the literal "general" sentinel to null. */
function taskIdOf(v: string | undefined): string | null | undefined {
	if (v === undefined) return undefined;
	return v === "general" ? null : v;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "synapse",
		label: "SYNAPSE",
		description: [
			"Transient shared coordination scratchpad for multi-agent work.",
			"Post short coordination notes (work started/completed, blockers, risks, decisions) and read the feed.",
			"NOT long-term memory — retention prunes old notes. Use AXON for durable task state.",
			"Actions: post, list, get, summary, prune, clear.",
		].join(" "),
		promptSnippet: "Post/read short SYNAPSE coordination notes; use risk/blocker notes during blocked handoffs",
		promptGuidelines: [
			"Opt-in: use/mention this component only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests.",
			"Use the synapse tool action 'post' to announce work started, completed, blockers, risks, or decisions so other agents stay coordinated.",
			"Keep synapse notes short and coordination-focused (who/what/why now); put durable state in AXON, not synapse.",
			"Use the synapse tool action 'list' or 'summary' before starting work to check what other agents are doing and avoid conflicts.",
			"When you spot a conflict or risk another agent must know, post a synapse note of type 'risk' or 'blocker' immediately.",
		],
		parameters: SynapseToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = SynapseStore.fromCwd(ctx.cwd);
			const p = params as SynapseToolInput;
			const action = p.action;

			switch (action) {
				case "post": {
					if (!p.message) return fail(action, "post requires `message`.");
					return runOp(store, action, (log) => {
						const n = log.post({
							message: p.message!,
							task_id: taskIdOf(p.task_id),
							agent_id: p.agent_id,
							type: p.type as NoteType | undefined,
						});
						return ok(action, `Posted ${n.id} [${n.type}]${n.task_id ? ` (${n.task_id})` : ""}: ${n.message}`, {
							note: n,
						});
					});
				}

				case "get": {
					if (!p.id) return fail(action, "get requires `id`.");
					return runQuery(store, action, (log) => {
						const n = log.get(p.id!);
						if (!n) return fail(action, `Note ${p.id} not found.`);
						return ok(action, summarizeFeed([n], "SYNAPSE note"), { notes: [n] });
					});
				}

				case "list": {
					return runQuery(store, action, (log) => {
						const filter: ListFilter = {
							task_id: taskIdOf(p.task_filter),
							agent_id: p.agent_filter,
							type: p.type_filter as NoteType | undefined,
							limit: p.limit ?? 50,
						};
						const notes = log.list(filter);
						return ok(action, summarizeFeed(notes, `SYNAPSE — ${notes.length} note(s)`), { notes });
					});
				}

				case "summary": {
					return runQuery(store, action, (log) => {
						const summary = log.summary(p.limit ?? 10);
						return ok(action, summarizeBoard(summary), { summary });
					});
				}

				case "prune": {
					const { pruned } = await store.pruneOnly();
					return ok(action, pruned > 0 ? `Pruned ${pruned} stale note(s).` : "Nothing to prune.", { pruned });
				}

				case "clear": {
					if (p.all) {
						return runOp(store, action, (log) => {
							const cleared = log.clear();
							return ok(action, `Cleared all ${cleared} note(s).`, { cleared });
						});
					}
					return runOp(store, action, (log) => {
						const cleared = log.clear({
							task_id: taskIdOf(p.task_filter),
							agent_id: p.agent_filter,
							type: p.type_filter as NoteType | undefined,
						});
						return ok(action, `Cleared ${cleared} note(s).`, { cleared });
					});
				}

				default:
					return fail(action, `Unknown action: ${action as string}`);
			}
		},

		renderCall(args, theme) {
			return renderSynapseCall(args as { action: string; type?: string; task_id?: string }, theme as never);
		},
		renderResult(result, options, theme) {
			return renderSynapseResult(
				result as Parameters<typeof renderSynapseResult>[0],
				options as Parameters<typeof renderSynapseResult>[1],
				theme as never,
			);
		},
	});

	/* ------------------------------- commands ------------------------------ */

	pi.registerCommand("synapse", {
		description: "Show the SYNAPSE coordination feed summary",
		handler: async (_args, ctx) => {
			const store = SynapseStore.fromCwd(ctx.cwd);
			const { result } = await store.query((log) => log.summary(15));
			post(ctx, pi, summarizeBoard(result), { summary: result });
		},
	});

	pi.registerCommand("synapse:task", {
		description: "Show SYNAPSE notes for one AXON task",
		handler: async (args, ctx) => {
			const task = (args ?? "").trim();
			if (!task) {
				ctx.ui.notify("Usage: /synapse:task <task-id> (or 'general')", "info");
				return;
			}
			const store = SynapseStore.fromCwd(ctx.cwd);
			const tid = taskIdOf(task);
			const { result } = await store.query((log) => log.list({ task_id: tid, limit: 100 }));
			post(ctx, pi, summarizeFeed(result, `SYNAPSE — ${task}`), { notes: result });
		},
	});

	pi.registerCommand("synapse:clear", {
		description: "DANGER: wipe the SYNAPSE scratchpad (backs up first)",
		handler: async (_args, ctx) => {
			const store = SynapseStore.fromCwd(ctx.cwd);
			const { result: count } = await store.query((log) => log.summary().total);
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Clear SYNAPSE?",
					`This removes ${count} note(s) from the active NERVous context. A .bak file is written beside the scratchpad first. This cannot be undone.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			await store.backend.wipe();
			ctx.ui.notify(`SYNAPSE cleared (${count} notes removed; backup written beside active scratchpad).`, "info");
		},
	});
}

/* ----------------------------- helpers ---------------------------------- */

function post(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	markdown: string,
	_details: Record<string, unknown>,
): void {
	if (ctx.hasUI) {
		pi.sendMessage(
			{ customType: "synapse", content: markdown, display: true, details: _details },
			{ triggerTurn: false },
		);
	} else {
		ctx.ui.notify(markdown, "info");
	}
}

// keep the NOTE_TYPES import meaningful for documentation/type alignment
void NOTE_TYPES;
