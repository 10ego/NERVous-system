import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
const EXPLICIT_NERVOUS_INPUT = /^\/nervous(?:\s|$)/;

function withoutNervousTools(names: readonly string[]): string[] {
	return names.filter((name) => !NERVOUS_TOOLS.has(name));
}

/**
 * Keep the root suite invisible to ordinary model turns, then grant a one-agent-run
 * activation lease only when the user/RPC caller enters the `/nervous` template.
 */
export function installNervousActivationGate(pi: ExtensionAPI): void {
	let leaseActive = false;
	let restoreTools: string[] | null = null;

	const deactivateDefault = (): void => {
		const active = pi.getActiveTools();
		const filtered = withoutNervousTools(active);
		if (filtered.length !== active.length) pi.setActiveTools(filtered);
		leaseActive = false;
		restoreTools = null;
	};

	const activateForInvocation = (): void => {
		if (leaseActive) return;
		restoreTools = withoutNervousTools(pi.getActiveTools());
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const nervous = NERVOUS_TOOL_NAMES.filter((name) => available.has(name));
		pi.setActiveTools([...new Set([...restoreTools, ...nervous])]);
		leaseActive = true;
	};

	const restore = (): void => {
		if (!leaseActive) return;
		pi.setActiveTools(restoreTools ?? withoutNervousTools(pi.getActiveTools()));
		leaseActive = false;
		restoreTools = null;
	};

	// Extension factories have all registered their tools before session_start runs.
	pi.on("session_start", deactivateDefault);

	// Input runs before prompt-template expansion, so the next system prompt is built
	// with NERVous schemas only for the exact explicit slash invocation.
	pi.on("input", (event) => {
		const explicit = event.source !== "extension" && EXPLICIT_NERVOUS_INPUT.test(event.text);
		if (explicit) {
			activateForInvocation();
			return { action: "continue" };
		}

		// Recover from an interrupted activation that never reached agent_end. Do not
		// tear down a live invocation when an ordinary steering/follow-up message arrives.
		if (leaseActive && event.streamingBehavior === undefined) restore();
		return { action: "continue" };
	});

	pi.on("agent_end", restore);
	pi.on("session_shutdown", restore);

	// Defense in depth for stale provider schemas or another extension re-enabling a
	// tool: visibility is not authorization; only the explicit lease permits calls.
	pi.on("tool_call", (event) => {
		if (NERVOUS_TOOLS.has(event.toolName) && !leaseActive) {
			return {
				block: true,
				reason: "NERVous tools are disabled for ordinary prompts. Invoke /nervous <request> to enable them for one agent run.",
			};
		}
	});
}
