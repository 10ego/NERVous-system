import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	archiveNervousContext,
	assessNervousContextReset,
	formatNervousStateReport,
	inspectNervousContext,
	type NervousResetAssessment,
	type NervousResetResult,
} from "./state-runtime.ts";

export const NERVOUS_STATE_REPORT_MESSAGE = "nervous:state-report";
export const NERVOUS_RESET_REPORT_MESSAGE = "nervous:reset-report";

/** Register state diagnostics and raw whole-context recovery independently of component health. */
export function installNervousStateControl(pi: ExtensionAPI): void {
	pi.registerCommand("nervous:state", {
		description: "Show the active NERVous namespace, retention, and stored record counts",
		handler: async (_args, ctx) => {
			try {
				const snapshot = await inspectNervousContext(ctx.cwd);
				pi.sendMessage({
					customType: NERVOUS_STATE_REPORT_MESSAGE,
					content: formatNervousStateReport(snapshot),
					display: true,
					details: snapshot,
				}, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(`Could not inspect NERVous state: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("nervous:reset", {
		description: "Archive and reset every component in the active NERVous context",
		handler: async (args, ctx) => resetContext(pi, args, ctx),
	});
}

async function resetContext(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const tokens = new Set(args.trim().toLowerCase().split(/\s+/).filter(Boolean));
	const unknown = [...tokens].filter((token) => token !== "force" && token !== "confirm");
	if (unknown.length) {
		ctx.ui.notify("Usage: /nervous:reset [force] [confirm]", "error");
		return;
	}
	const force = tokens.has("force");
	let assessment: NervousResetAssessment;
	try { assessment = await assessNervousContextReset(ctx.cwd); }
	catch (error) {
		ctx.ui.notify(`Could not inspect NERVous state before reset: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (assessment.overridePaths.length) {
		ctx.ui.notify(`Context-wide reset is disabled while component path overrides are active: ${assessment.overridePaths.join(", ")}. Unset them or archive those files manually.`, "error");
		return;
	}
	if (assessment.inspectionErrors.length) {
		ctx.ui.notify(`NERVous state could not be inspected safely: ${assessment.inspectionErrors.join(", ")}. Nothing was reset.`, "error");
		return;
	}
	if (!force && (assessment.activeLionRunIds.length || assessment.lionStateUnreadable)) {
		const reason = assessment.activeLionRunIds.length
			? `queued/running LION records: ${assessment.activeLionRunIds.join(", ")}`
			: "the LION ledger is unreadable, so worker liveness is unknown";
		ctx.ui.notify(`Reset refused because ${reason}. Cancel/reconcile workers, or use /nervous:reset force only after confirming no worker process is live.`, "error");
		return;
	}
	if (assessment.artifactCount === 0) {
		ctx.ui.notify(`NERVous context ${assessment.snapshot.project}/${assessment.snapshot.context} is already empty.`, "info");
		return;
	}

	const confirmed = tokens.has("confirm") || (ctx.hasUI && await ctx.ui.confirm(
		force ? "Force-reset NERVous context?" : "Reset NERVous context?",
		resetConfirmation(assessment, force),
	));
	if (!confirmed) {
		if (!ctx.hasUI) ctx.ui.notify("Confirmation required. Rerun with /nervous:reset confirm (or /nervous:reset force confirm after verifying no worker is live).", "warning");
		return;
	}

	let result: NervousResetResult;
	try {
		result = await archiveNervousContext(ctx.cwd, {
			force,
			sessionId: ctx.sessionManager.getSessionId(),
			expectedNamespace: assessment.snapshot,
		});
	} catch (error) {
		ctx.ui.notify(`NERVous reset failed without an automatic migration: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	pi.sendMessage({
		customType: NERVOUS_RESET_REPORT_MESSAGE,
		content: formatResetResult(result),
		display: true,
		details: result,
	}, { triggerTurn: false });
	ctx.ui.notify(`NERVous context reset; raw state archived at ${result.archivePath}.`, result.warnings.length ? "warning" : "info");
}

function resetConfirmation(assessment: NervousResetAssessment, force: boolean): string {
	const active = assessment.activeLionRunIds.length ? ` Active LION records: ${assessment.activeLionRunIds.join(", ")}.` : "";
	return [
		`Archive and clear ${assessment.snapshot.project}/${assessment.snapshot.context}?`,
		`${assessment.artifactCount} raw artifact(s), ${formatBytes(assessment.artifactBytes)}.`,
		assessment.snapshot.archiveRetentionDays === 0
			? "The raw archive does not expire automatically; records will no longer appear in tools or the dashboard."
			: `The raw archive is retained for at least ${assessment.snapshot.archiveRetentionDays} day(s); records will no longer appear in tools or the dashboard.`,
		force ? `FORCE bypasses LION liveness classification.${active}` : "Running workers are not bypassed.",
	].join("\n");
}

function formatResetResult(result: NervousResetResult): string {
	const lines = [
		"# NERVous context reset",
		`- Archived raw state: \`${result.archivePath}\``,
		`- Removed from active namespace: ${result.assessment.artifactCount} file(s), ${formatBytes(result.assessment.artifactBytes)}`,
		"- Active namespace: empty; component stores will recreate it on their next write.",
		`- Expired reset archives pruned: ${result.prunedArchivePaths.length}`,
	];
	for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
	return lines.join("\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
