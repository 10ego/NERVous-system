import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

describe("cerebel extension factory", () => {
	it("registers the cerebel tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const cerebel = tools.find((t) => t.name === "cerebel");
		assert.ok(cerebel);
		assert.equal(typeof cerebel.execute, "function");
		assert.equal(typeof cerebel.renderCall, "function");
		assert.equal(typeof cerebel.renderResult, "function");
		assert.ok(cerebel.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("cerebel"));
		assert.ok(names.includes("cerebel:waves"));
	});
});
