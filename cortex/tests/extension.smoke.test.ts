import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import factory, { summarizeConfig } from "../extension/index.ts";

interface Captured {
	tools: Array<Record<string, unknown>>;
	commands: Array<{ name: string; options: Record<string, unknown> }>;
	messages: Array<Record<string, unknown>>;
}

function stubPi(): { pi: any; captured: Captured } {
	initTheme("dark");
	const captured: Captured = { tools: [], commands: [], messages: [] };
	const pi: any = {
		registerTool(def: Record<string, unknown>) {
			captured.tools.push(def);
		},
		registerCommand(name: string, options: Record<string, unknown>) {
			captured.commands.push({ name, options });
		},
		sendMessage(message: Record<string, unknown>) {
			captured.messages.push(message);
		},
	};
	return { pi, captured };
}

function nervousConfigCommand(captured: Captured): any {
	const command = captured.commands.find((c) => c.name === "nervous:config");
	assert.ok(command, "/nervous:config registered");
	return command.options;
}

async function withTempCortex<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const old = process.env.CORTEX_PATH;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cortex-command-test-"));
	process.env.CORTEX_PATH = path.join(dir, "cortex.json");
	try {
		return await fn(dir);
	} finally {
		if (old === undefined) delete process.env.CORTEX_PATH;
		else process.env.CORTEX_PATH = old;
	}
}

function commandCtx(dir: string, overrides: Record<string, unknown> = {}): any {
	return {
		cwd: dir,
		mode: "print",
		hasUI: true,
		ui: {
			notify() {},
			confirm: async () => false,
			input: async () => undefined,
		},
		...overrides,
	};
}

const testTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

async function settleUiWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
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
				risk_gate_mode: "auto_deliberate",
				updated_at: "2026-07-03T00:00:00.000Z",
			},
			false,
		);

		assert.match(output, /## Current defaults/);
		assert.match(output, /\| `risk_gate_mode` \| `auto_deliberate` \|/);
		assert.match(output, /## Usage/);
		assert.match(output, /## Options/);
		assert.match(output, /### Drain mode/);
		assert.match(output, /Aliases: `drain`, `drain_mode`/);
		assert.match(output, /\| `always` \| default to draining\/resuming actionable incomplete goals \|/);
		assert.match(output, /### Risk gate/);
		assert.match(output, /Aliases: `risk`, `risk_gate`, `risk_gate_mode`/);
		assert.match(output, /\| `auto_deliberate` \| allow risky work only with recorded MAGI\/AMYGDALA approval evidence \|/);
		assert.match(output, /### Drain policy/);
		assert.match(output, /Aliases: `policy`, `default_drain_policy`/);
		assert.match(output, /\| `aggressive` \| larger, more proactive drain budgets \|/);
		assert.match(output, /### Advanced disabled risk gate/);
		assert.match(output, /Requires exact `dangerous_opt_in=true`/);
		assert.match(output, /risk=disabled dangerous_opt_in=true evidence=/);
	});

	it("labels /nervous:config completions with option meanings", () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);

		const complete = command.getArgumentCompletions as (prefix: string) => Array<{ value: string; label: string }> | null;
		const completions = complete("risk=auto") ?? [];
		assert.deepEqual(completions.map((item) => item.value), ["risk=auto_deliberate"]);
		assert.match(completions[0]?.label ?? "", /MAGI\/AMYGDALA approval evidence/);
	});

	it("prints markdown config with the auto_deliberate default outside TUI", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);

		await withTempCortex(async (dir) => {
			await command.handler("", commandCtx(dir));
		});

		assert.match(String(captured.messages[0]?.content ?? ""), /\| `risk_gate_mode` \| `auto_deliberate` \|/);
	});

	it("opens a TUI config menu on empty args and applies selected values immediately", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);
		let openedMenu = false;
		let rendered = "";

		await withTempCortex(async (dir) => {
			await command.handler(
				"",
				commandCtx(dir, {
					mode: "tui",
					ui: {
						notify() {},
						confirm: async () => false,
						input: async () => undefined,
						custom: async (factoryFn: any) => {
							openedMenu = true;
							const component = factoryFn({ requestRender() {} }, testTheme, {}, () => undefined);
							rendered = component.render(120).join("\n");
							component.handleInput(" "); // Drain mode: on_explicit_nervous -> always.
							await settleUiWork();
							return undefined;
						},
					},
				}),
			);
			await command.handler("show", commandCtx(dir));
		});

		assert.equal(openedMenu, true);
		assert.doesNotMatch(rendered, /Save and close/);
		assert.doesNotMatch(rendered, /Cancel/);
		const output = String(captured.messages[0]?.content ?? "");
		assert.match(output, /\| `drain_mode` \| `always` \|/);
	});

	it("falls back to markdown when the TUI menu is unavailable", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);
		const notifications: string[] = [];

		await withTempCortex(async (dir) => {
			await command.handler(
				"",
				commandCtx(dir, {
					mode: "tui",
					ui: {
						notify(message: string) {
							notifications.push(message);
						},
						custom: async () => {
							throw new Error("custom unavailable");
						},
					},
				}),
			);
		});

		assert.match(notifications.join("\n"), /menu unavailable/);
		assert.match(String(captured.messages[0]?.content ?? ""), /\| `risk_gate_mode` \| `auto_deliberate` \|/);
	});

	it("keeps explicit show/get behavior as markdown in TUI", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);
		let openedMenu = false;

		await withTempCortex(async (dir) => {
			await command.handler(
				"show",
				commandCtx(dir, {
					mode: "tui",
					ui: {
						notify() {},
						custom: async () => {
							openedMenu = true;
							return undefined;
						},
					},
				}),
			);
		});

		assert.equal(openedMenu, false);
		assert.match(String(captured.messages[0]?.content ?? ""), /\| `risk_gate_mode` \| `auto_deliberate` \|/);
	});

	it("rejects malformed dangerous opt-in values for disabled risk config", async () => {
		for (const badValue of ["maybe", ""]) {
			const { pi, captured } = stubPi();
			factory(pi);
			const command = nervousConfigCommand(captured);
			const notifications: string[] = [];

			await withTempCortex(async (dir) => {
				await command.handler(
					`risk=disabled dangerous_opt_in=${badValue} evidence="explicit user-approved automation window"`,
					commandCtx(dir, {
						ui: {
							notify(message: string) {
								notifications.push(message);
							},
						},
					}),
				);
				await command.handler("show", commandCtx(dir));
			});

			assert.match(notifications.join("\n"), /Invalid NERVous config/);
			assert.match(String(captured.messages[0]?.content ?? ""), /\| `risk_gate_mode` \| `auto_deliberate` \|/);
		}
	});

	it("accepts quoted evidence with spaces for guarded disabled risk config", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);

		await withTempCortex(async (dir) => {
			await command.handler(
				'risk=disabled dangerous_opt_in=true evidence="explicit user-approved automation window"',
				commandCtx(dir),
			);
		});

		const output = String(captured.messages[0]?.content ?? "");
		assert.match(output, /NERVous CORTEX config updated/);
		assert.match(output, /\| `risk_gate_mode` \| `disabled` \|/);
		assert.match(output, /\| `risk_gate_evidence` \| explicit user-approved automation window \|/);
	});

	it("does not allow disabled risk gate from the menu without confirmation", async () => {
		const { pi, captured } = stubPi();
		factory(pi);
		const command = nervousConfigCommand(captured);
		const notifications: string[] = [];

		await withTempCortex(async (dir) => {
			await command.handler("risk=user_accepted", commandCtx(dir));
			captured.messages.length = 0;
			await command.handler(
				"",
				commandCtx(dir, {
					mode: "tui",
					ui: {
						notify(message: string) {
							notifications.push(message);
						},
						confirm: async () => false,
						input: async () => "should-not-be-used",
						custom: async (factoryFn: any) => {
							const component = factoryFn({ requestRender() {} }, testTheme, {}, () => undefined);
							for (const ch of "risk") component.handleInput(ch);
							component.handleInput(" "); // Risk gate: user_accepted -> disabled; should be rejected and reverted.
							await settleUiWork();
							return undefined;
						},
					},
				}),
			);
			await command.handler("show", commandCtx(dir));
		});

		assert.match(notifications.join("\n"), /disabled risk gate was not confirmed/);
		assert.match(String(captured.messages[0]?.content ?? ""), /\| `risk_gate_mode` \| `user_accepted` \|/);
	});
});
