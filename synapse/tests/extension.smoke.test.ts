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

describe("synapse extension factory", () => {
	it("registers the synapse tool and /synapse* commands without throwing", () => {
		const { pi, captured } = stubPi();
		assert.doesNotThrow(() => factory(pi));

		const syn = captured.tools.find((t) => t.name === "synapse");
		assert.ok(syn, "synapse tool registered");
		assert.equal(typeof syn?.execute, "function");
		assert.ok(syn?.parameters, "tool has parameters schema");
		assert.ok(syn?.promptSnippet, "tool has promptSnippet");
		assert.ok(
			Array.isArray((syn?.promptGuidelines as string[]) ?? []) && (syn?.promptGuidelines as string[]).length > 0,
		);
		assert.equal(typeof syn?.renderCall, "function");
		assert.equal(typeof syn?.renderResult, "function");

		const names = captured.commands.map((c) => c.name);
		assert.ok(names.includes("synapse"), "/synapse registered");
		assert.ok(names.includes("synapse:task"), "/synapse:task registered");
		assert.ok(names.includes("synapse:clear"), "/synapse:clear registered");
	});
});
