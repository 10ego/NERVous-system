import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	applyNervousEnabledPatch,
	applyNervousModelPatch,
	loadNervousConfig,
	readUserNervousConfig,
	writeUserNervousConfig,
} from "../extension/enablement.ts";

describe("bundled suite enablement compatibility", () => {
	it("persists enablement alongside model updates without a newer state package", () => {
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-enablement-test-"));
		const agentDir = path.join(dir, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const disabled = applyNervousEnabledPatch(readUserNervousConfig(), false);
			const withModel = applyNervousModelPatch(disabled, { "lion.default": "provider/fast" });
			writeUserNervousConfig(withModel);

			const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "nervous.json"), "utf8"));
			assert.equal(raw.enabled, false);
			assert.equal(raw.models.lion.default, "provider/fast");
			assert.equal(loadNervousConfig({ cwd: dir, isProjectTrusted: true }).user.enabled, false);
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});
});
