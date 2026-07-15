import { SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildNervousInvocation, NERVOUS_ACTIVATION_ENTRY, NERVOUS_PROMPT_SIGNATURE } from "./nervous-command.ts";
import { installNervousTransportPauseNotice, NERVOUS_TRANSPORT_RESUME_PROMPT } from "./transport-recovery.ts";

/** Tools exposed by the root NERVous suite. Standalone component packages remain unaffected. */
export const NERVOUS_TOOL_NAMES = [
	"magi",
	"axon",
	"synapse",
	"cortex",
	"lion",
	"cerebel",
	"ganglion",
	"amygdala",
] as const;

const NERVOUS_TOOLS = new Set<string>(NERVOUS_TOOL_NAMES);

function withoutNervousTools(names: readonly string[]): string[] {
	return names.filter((name) => !NERVOUS_TOOLS.has(name));
}

function userText(entry: any): string {
	if (entry?.type !== "message" || entry.message?.role !== "user") return "";
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}

function branchHasNervousActivation(entries: readonly unknown[]): boolean {
	return entries.some((entry: any) =>
		(entry?.type === "custom" && entry.customType === NERVOUS_ACTIVATION_ENTRY && entry.data?.active === true)
		|| userText(entry).includes(NERVOUS_PROMPT_SIGNATURE),
	);
}

interface ActivationGateOptions {
	isAutoRetryEnabled?: (ctx: ExtensionCommandContext) => boolean;
}

function fileBackedAutoRetryEnabled(ctx: ExtensionCommandContext): boolean {
	const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	const errors = settings.drainErrors();
	if (errors.length) throw new AggregateError(errors.map((entry) => entry.error), "Pi retry settings could not be read");
	return settings.getRetryEnabled();
}

/**
 * Keep the root suite invisible in fresh chains. `/nervous` waits for any current
 * run to finish, verifies Pi native retry, then activates the operator-permitted
 * subset for the current session branch and persists that chain authorization.
 */
export function installNervousActivationGate(pi: ExtensionAPI, options: ActivationGateOptions = {}): void {
	let chainActive = false;
	let permittedNervousTools = new Set<string>();

	const deactivateNervousTools = (): void => {
		const active = pi.getActiveTools();
		const filtered = withoutNervousTools(active);
		if (filtered.length !== active.length) pi.setActiveTools(filtered);
		chainActive = false;
	};

	const activateChain = (persist: boolean): void => {
		if (!chainActive) {
			const active = pi.getActiveTools();
			const additions = NERVOUS_TOOL_NAMES.filter((name) => permittedNervousTools.has(name));
			pi.setActiveTools([...new Set([...active, ...additions])]);
			chainActive = true;
		}
		if (persist) pi.appendEntry(NERVOUS_ACTIVATION_ENTRY, { active: true });
	};

	const syncCurrentBranch = (ctx: { sessionManager: { getBranch(): unknown[] } }): void => {
		const shouldActivate = branchHasNervousActivation(ctx.sessionManager.getBranch());
		if (shouldActivate && !chainActive) activateChain(false);
		else if (!shouldActivate && chainActive) deactivateNervousTools();
	};

	// Extension factories have registered all tools by session_start. Capture only
	// the subset the operator actually selected before hiding it in a fresh chain.
	pi.on("session_start", (_event, ctx) => {
		permittedNervousTools = new Set(pi.getActiveTools().filter((name) => NERVOUS_TOOLS.has(name)));
		chainActive = branchHasNervousActivation(ctx.sessionManager.getBranch());
		if (!chainActive) deactivateNervousTools();
	});

	// Tree navigation can move between a pre-activation branch and a descendant of
	// the activation marker without replacing the session runtime.
	pi.on("session_tree", (_event, ctx) => syncCurrentBranch(ctx));

	// An extension command is used instead of a prompt template so queued invocation
	// waits for the old run to become idle before any NERVous capability is enabled.
	pi.registerCommand("nervous", {
		description: "Activate the NERVous workflow for this session chain",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (permittedNervousTools.size === 0) {
				ctx.ui.notify("No NERVous tools are enabled. Run /nervous:config enabled=true or adjust Pi's active tool selection.", "error");
				return;
			}
			let autoRetryEnabled: boolean;
			try { autoRetryEnabled = (options.isAutoRetryEnabled ?? fileBackedAutoRetryEnabled)(ctx); }
			catch (error) {
				ctx.ui.notify(`Could not verify Pi native auto-retry (${error instanceof Error ? error.message : String(error)}). No NERVous workflow was started.`, "error");
				return;
			}
			if (!autoRetryEnabled) {
				ctx.ui.notify("Pi native auto-retry is disabled. Enable it in Pi settings and rerun /nervous. No NERVous workflow was started.", "warning");
				return;
			}
			activateChain(!chainActive);
			pi.sendUserMessage(buildNervousInvocation(args));
		},
	});

	pi.registerCommand("nervous:resume", {
		description: "Explicitly resume an active NERVous workflow after an interruption",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!chainActive || permittedNervousTools.size === 0) {
				ctx.ui.notify("No active NERVous workflow is available to resume. Run /nervous <request> first.", "error");
				return;
			}
			pi.sendUserMessage(NERVOUS_TRANSPORT_RESUME_PROMPT);
		},
	});

	// Defense in depth: visibility is not authorization, and tools excluded by the
	// operator remain forbidden even if another extension makes them visible.
	pi.on("tool_call", (event) => {
		if (NERVOUS_TOOLS.has(event.toolName) && (!chainActive || !permittedNervousTools.has(event.toolName))) {
			return {
				block: true,
				reason: chainActive
					? `NERVous tool ${event.toolName} is excluded by the active tool configuration.`
					: "NERVous tools are disabled in this session chain. Invoke /nervous <request> to activate the coordinated workflow.",
			};
		}
	});

	installNervousTransportPauseNotice(pi, () => chainActive && permittedNervousTools.size > 0);
}
