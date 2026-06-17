import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

describe("amygdala extension factory", () => {
	it("registers the amygdala tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const amygdala = tools.find((t) => t.name === "amygdala");
		assert.ok(amygdala);
		assert.equal(typeof amygdala.execute, "function");
		assert.equal(typeof amygdala.renderCall, "function");
		assert.equal(typeof amygdala.renderResult, "function");
		assert.ok(amygdala.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("amygdala"));
		assert.ok(names.includes("amygdala:risks"));
	});
});
