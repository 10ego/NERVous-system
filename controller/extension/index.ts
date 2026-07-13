/**
 * NERVous System's always-loaded control plane.
 *
 * The root manifest keeps this extension enabled even while the rest of the
 * package is disabled. It owns `/nervous:config`, which safely restricts or
 * restores Pi's normal package-resource selection and then reloads Pi.
 */

import { loadNervousConfig, resolveNervousEnabled } from "@nervous-system/state";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markNervousRootControlPlane, registerNervousConfigCommand } from "../../cortex/extension/index.ts";
import { setRootPackageEnabled } from "./package-toggle.ts";

export default function nervousControlPlane(pi: ExtensionAPI): void {
	markNervousRootControlPlane(pi);
	registerNervousConfigCommand(pi, {
		onEnablementChange: async (enabled, ctx) => {
			setRootPackageEnabled(enabled, undefined, ctx.cwd);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const resolution = loadNervousConfig({ cwd: ctx.cwd, isProjectTrusted: () => ctx.isProjectTrusted() });
		if (setRootPackageEnabled(resolveNervousEnabled(resolution).enabled, undefined, ctx.cwd)) await ctx.reload();
	});
}
