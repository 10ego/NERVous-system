import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatNervousStateReport, inspectNervousContext } from "@nervous-system/state";

export const NERVOUS_STATE_REPORT_MESSAGE = "nervous:state-report";

/** Register read-only runtime-state diagnostics independently of component health. */
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
}
