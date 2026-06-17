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

describe("cortex extension factory", () => {
	it("registers the cortex tool and /cortex* commands without throwing", () => {
		const { pi, captured } = stubPi();
		assert.doesNotThrow(() => factory(pi));

		const cortex = captured.tools.find((t) => t.name === "cortex");
		assert.ok(cortex, "cortex tool registered");
		assert.equal(typeof cortex?.execute, "function");
		assert.ok(cortex?.parameters, "tool has parameters schema");
		assert.ok(cortex?.promptSnippet, "tool has promptSnippet");
		assert.ok(
			Array.isArray((cortex?.promptGuidelines as string[]) ?? []) && (cortex?.promptGuidelines as string[]).length > 0,
		);
		assert.equal(typeof cortex?.renderCall, "function");
		assert.equal(typeof cortex?.renderResult, "function");

		const names = captured.commands.map((c) => c.name);
		assert.ok(names.includes("cortex"), "/cortex registered");
		assert.ok(names.includes("cortex:goals"), "/cortex:goals registered");
		assert.ok(names.includes("cortex:resume"), "/cortex:resume registered");
	});
});
