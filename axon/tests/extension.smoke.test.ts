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

describe("axon extension factory", () => {
	it("registers the axon tool and /axon* commands without throwing", () => {
		const { pi, captured } = stubPi();
		assert.doesNotThrow(() => factory(pi));

		const axon = captured.tools.find((t) => t.name === "axon");
		assert.ok(axon, "axon tool registered");
		assert.equal(typeof axon?.execute, "function");
		assert.ok(axon?.parameters, "tool has parameters schema");
		assert.ok(axon?.promptSnippet, "tool has promptSnippet");
		assert.ok(
			Array.isArray((axon?.promptGuidelines as string[]) ?? []) && (axon?.promptGuidelines as string[]).length > 0,
		);
		assert.equal(typeof axon?.renderCall, "function");
		assert.equal(typeof axon?.renderResult, "function");

		const names = captured.commands.map((c) => c.name);
		assert.ok(names.includes("axon"), "/axon registered");
		assert.ok(names.includes("axon:list"), "/axon:list registered");
		assert.ok(names.includes("axon:task"), "/axon:task registered");
		assert.ok(names.includes("axon:reset"), "/axon:reset registered");
	});
});
