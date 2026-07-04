import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory, { summarizeConfig } from "../extension/index.ts";

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
		assert.ok(names.includes("nervous:config"), "/nervous:config registered");
	});

	it("shows detailed /nervous:config hints", () => {
		const output = summarizeConfig(
			{
				drain_mode: "on_explicit_nervous",
				default_drain_policy: "default",
				risk_gate_mode: "strict",
				updated_at: "2026-07-03T00:00:00.000Z",
			},
			false,
		);

		assert.match(output, /## Options/);
		assert.match(output, /`drain` \/ `drain_mode`/);
		assert.match(output, /`always`: default to draining\/resuming actionable incomplete goals/);
		assert.match(output, /`risk` \/ `risk_gate` \/ `risk_gate_mode`/);
		assert.match(output, /`auto_deliberate`: allow risky work only with recorded MAGI\/AMYGDALA approval evidence/);
		assert.match(output, /`policy` \/ `default_drain_policy`/);
		assert.match(output, /`aggressive`: larger, more proactive drain budgets/);
		assert.match(output, /`dangerous_opt_in=true`/);
		assert.match(output, /risk=disabled dangerous_opt_in=true evidence=/);
	});

	it("labels /nervous:config completions with option meanings", () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = captured.commands.find((c) => c.name === "nervous:config");
		assert.ok(command, "/nervous:config registered");

		const complete = command.options.getArgumentCompletions as (prefix: string) => Array<{ value: string; label: string }> | null;
		const completions = complete("risk=auto") ?? [];
		assert.deepEqual(completions.map((item) => item.value), ["risk=auto_deliberate"]);
		assert.match(completions[0]?.label ?? "", /MAGI\/AMYGDALA approval evidence/);
	});
});
