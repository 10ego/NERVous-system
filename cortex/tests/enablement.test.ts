import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	applyNervousCerebelMaxParallelPatch,
	applyNervousEnabledPatch,
	applyNervousModelPatch,
	loadNervousConfig,
	readUserNervousConfig,
	resolveNervousCerebelMaxParallel,
	writeUserNervousConfig,
} from "../extension/enablement.ts";

describe("bundled suite enablement compatibility", () => {
	it("persists enablement and CEREBEL parallelism alongside model updates without a newer state package", () => {
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-enablement-test-"));
		const agentDir = path.join(dir, "agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const disabled = applyNervousEnabledPatch(readUserNervousConfig(), false);
			const withParallelism = applyNervousCerebelMaxParallelPatch(disabled, 6);
			const withModel = applyNervousModelPatch(withParallelism, { "lion.default": "provider/fast" });
			writeUserNervousConfig(withModel);

			const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "nervous.json"), "utf8"));
			assert.equal(raw.enabled, false);
			assert.equal(raw.cerebel.maxParallel, 6);
			assert.equal(raw.models.lion.default, "provider/fast");
			const loaded = loadNervousConfig({ cwd: dir, isProjectTrusted: true });
			assert.equal(loaded.user.enabled, false);
			assert.deepEqual(resolveNervousCerebelMaxParallel(loaded), { maxParallel: 6, source: "user", path: path.join(agentDir, "nervous.json") });
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("defaults malformed CEREBEL parallelism and rejects invalid patches", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-enablement-test-"));
		const agentDir = path.join(dir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "nervous.json"), JSON.stringify({ version: 1, models: {}, cerebel: { maxParallel: 11 } }));

		const loaded = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: true });
		assert.deepEqual(resolveNervousCerebelMaxParallel(loaded), { maxParallel: 3, source: "default" });
		for (const invalid of [0, 11, 2.5, Number.NaN]) {
			assert.throws(() => applyNervousCerebelMaxParallelPatch(readUserNervousConfig(agentDir), invalid), /integer from 1 through 10/);
		}
	});
});
