import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; commands: Array<{ name: string; options: any }> } {
	const commands: Array<{ name: string; options: any }> = [];
	return {
		commands,
		pi: {
			registerCommand(name: string, options: any) {
				commands.push({ name, options });
			},
		},
	};
}

describe("dashboard extension factory", () => {
	it("registers the NERVous dashboard command", () => {
		const { pi, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const dashboard = commands.find((c) => c.name === "nervous:dashboard");
		assert.ok(dashboard, "/nervous:dashboard registered");
		assert.equal(typeof dashboard?.options.handler, "function");
		assert.ok(dashboard?.options.description);
		assert.equal(commands.some((c) => c.name === "nervous"), false, "/nervous prompt template remains unshadowed");
	});
});
