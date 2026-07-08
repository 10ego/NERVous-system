import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import factory, { applyNervousModelDefaults } from "../extension/index.ts";

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

	it("fills missing MAGI models from NERVous defaults without overriding explicit council models", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magi-config-test-"));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
		fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR, "nervous.json"),
			JSON.stringify({ version: 1, models: { magi: { councillorDefault: "provider/balanced", synthesisDefault: "provider/strong" } } }),
		);
		try {
			const config = applyNervousModelDefaults(
				{
					version: 1,
					synthesizer: "hand",
					councillors: [
						{ id: "mind", name: "Mind", role: "think" },
						{ id: "hand", name: "Hand", role: "act", model: "provider/explicit" },
					],
				},
				dir,
				false,
			);
			assert.equal(config.councillors.find((c) => c.id === "mind")?.model, "provider/balanced");
			assert.equal(config.councillors.find((c) => c.id === "hand")?.model, "provider/explicit");
			assert.equal(config.synthesis_model, undefined, "explicit synthesizer model remains the synthesis fallback");

			const noExplicitSynth = applyNervousModelDefaults(
				{
					version: 1,
					synthesizer: "hand",
					councillors: [
						{ id: "mind", name: "Mind", role: "think" },
						{ id: "hand", name: "Hand", role: "act" },
					],
				},
				dir,
				false,
			);
			assert.equal(noExplicitSynth.councillors.find((c) => c.id === "hand")?.model, "provider/balanced");
			assert.equal(noExplicitSynth.synthesis_model, "provider/strong");

			fs.writeFileSync(
				path.join(process.env.PI_CODING_AGENT_DIR, "nervous.json"),
				JSON.stringify({ version: 1, models: { magi: { councillorDefault: "provider/balanced" } } }),
			);
			const councillorOnly = applyNervousModelDefaults(
				{
					version: 1,
					synthesizer: "hand",
					councillors: [
						{ id: "mind", name: "Mind", role: "think" },
						{ id: "hand", name: "Hand", role: "act" },
					],
				},
				dir,
				false,
			);
			assert.equal(councillorOnly.synthesis_model, undefined);
			assert.equal(councillorOnly.councillors.find((c) => c.id === "hand")?.model, "provider/balanced", "synthesis inherits MAGI's synthesizer-model fallback when no synthesis default is configured");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});
});
