import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return {
		tools,
		commands,
		pi: {
			registerTool(def: any) { tools.push(def); },
			registerCommand(name: string, options: any) { commands.push({ name, options }); },
		},
	};
}

describe("lion extension factory", () => {
	it("registers the lion tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const lion = tools.find((t) => t.name === "lion");
		assert.ok(lion);
		assert.equal(typeof lion.execute, "function");
		assert.equal(typeof lion.renderCall, "function");
		assert.equal(typeof lion.renderResult, "function");
		assert.ok(lion.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("lion"));
		assert.ok(names.includes("lion:runs"));
	});
});
