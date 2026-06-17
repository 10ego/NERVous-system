import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

describe("ganglion extension factory", () => {
	it("registers the ganglion tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const ganglion = tools.find((t) => t.name === "ganglion");
		assert.ok(ganglion);
		assert.equal(typeof ganglion.execute, "function");
		assert.equal(typeof ganglion.renderCall, "function");
		assert.equal(typeof ganglion.renderResult, "function");
		assert.ok(ganglion.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("ganglion"));
		assert.ok(names.includes("ganglion:groups"));
	});
});
