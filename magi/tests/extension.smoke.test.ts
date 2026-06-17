import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";

interface Captured {
	tools: Array<Record<string, unknown>>;
	commands: Array<{ name: string; options: Record<string, unknown> }>;
}

function stubPi(): { pi: any; captured: Captured } {
	const captured: Captured = { tools: [], commands: [] };
	const pi: any = {
		registerTool(def: Record<string, unknown>) {
			captured.tools.push(def);
		},
		registerCommand(name: string, options: Record<string, unknown>) {
			captured.commands.push({ name, options });
		},
	};
	return { pi, captured };
}

describe("extension factory", () => {
	it("registers the magi tool and /magi commands without throwing", () => {
		const { pi, captured } = stubPi();
		assert.doesNotThrow(() => factory(pi));

		const magi = captured.tools.find((t) => t.name === "magi");
		assert.ok(magi, "magi tool registered");
		assert.equal(typeof magi?.execute, "function");
		assert.ok(magi?.parameters, "tool has parameters schema");
		assert.ok(magi?.promptSnippet, "tool has promptSnippet");
		assert.ok(Array.isArray((magi?.promptGuidelines as string[]) ?? []) && (magi?.promptGuidelines as string[]).length > 0);
		assert.equal(typeof magi?.renderCall, "function");
		assert.equal(typeof magi?.renderResult, "function");

		const names = captured.commands.map((c) => c.name);
		assert.ok(names.includes("magi"), "/magi command registered");
		assert.ok(names.includes("magi:council"), "/magi:council command registered");
	});
});
