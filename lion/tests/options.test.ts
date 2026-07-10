import * as assert from "node:assert";
import { describe, it } from "vitest";
import { resolveLionRunnerMode } from "../extension/options.ts";

describe("shared LION option resolution", () => {
	it("uses explicit runner mode before environment and JSON fallback", () => {
		assert.equal(resolveLionRunnerMode("json", "rpc"), "json");
		assert.equal(resolveLionRunnerMode(undefined, "rpc"), "rpc");
		assert.equal(resolveLionRunnerMode(undefined, "invalid"), "json");
	});
});
