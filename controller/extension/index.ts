/**
 * NERVous System's always-loaded control plane.
 *
 * The root manifest keeps this extension enabled even while the rest of the
 * package is disabled. It owns `/nervous:config` for package-resource selection,
 * `/nervous:state` and `/nervous:reset` for lifecycle recovery, and `/nervous`
 * for branch-persistent, coordinated tool activation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markNervousRootControlPlane, registerNervousConfigCommand } from "../../cortex/extension/index.ts";
import { installNervousActivationGate } from "./activation-gate.ts";
import { setRootPackageEnabled } from "./package-toggle.ts";
import { installNervousStateControl } from "./state-control.ts";

export default function nervousControlPlane(pi: ExtensionAPI): void {
	const releaseRootControlPlane = markNervousRootControlPlane(pi);
	installNervousActivationGate(pi);
	installNervousStateControl(pi);
	// Pi keeps its event bus across resource reloads, so release this generation's
	// ownership before the next extension set is loaded.
	pi.on("session_shutdown", releaseRootControlPlane);
	// Do not reconcile settings from session_start: that lifecycle context cannot
	// reload resources. The user-invoked command updates filters before its own
	// command-capable ctx.reload() call.
	registerNervousConfigCommand(pi, {
		onEnablementChange: async (enabled, ctx) => {
			setRootPackageEnabled(enabled, undefined, ctx.cwd, ctx.isProjectTrusted());
		},
	});
}
