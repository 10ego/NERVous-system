import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { resolveConfiguredCerebelMaxParallel } from "../extension/config.ts";

describe("CEREBEL config", () => {
	it("uses the persisted user default", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cerebel-config-test-"));
		fs.writeFileSync(path.join(agentDir, "nervous.json"), JSON.stringify({ cerebel: { maxParallel: 7 } }));
		assert.equal(resolveConfiguredCerebelMaxParallel(agentDir), 7);
	});

	it("falls back to 3 for missing, malformed, or out-of-range values", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cerebel-config-test-"));
		assert.equal(resolveConfiguredCerebelMaxParallel(agentDir), 3);
		for (const maxParallel of [0, 11, 2.5, "6"]) {
			fs.writeFileSync(path.join(agentDir, "nervous.json"), JSON.stringify({ cerebel: { maxParallel } }));
			assert.equal(resolveConfiguredCerebelMaxParallel(agentDir), 3);
		}
		fs.writeFileSync(path.join(agentDir, "nervous.json"), "not-json");
		assert.equal(resolveConfiguredCerebelMaxParallel(agentDir), 3);
	});
});
