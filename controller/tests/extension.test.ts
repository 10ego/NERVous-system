import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";
import cortexExtension from "../../cortex/extension/index.ts";
import { CONTROL_EXTENSION, ROOT_EXTENSIONS, ROOT_PROMPTS, ROOT_SKILLS, setRootPackageEnabled } from "../extension/package-toggle.ts";

interface Captured {
	commands: Array<{ name: string; options: Record<string, unknown> }>;
	handlers: Map<string, Array<(event: unknown, ctx: any) => unknown>>;
}

function stubPi(): { pi: any; captured: Captured } {
	const captured: Captured = { commands: [], handlers: new Map() };
	const pi: any = {
		registerTool() {},
		registerCommand(name: string, options: Record<string, unknown>) {
			captured.commands.push({ name, options });
		},
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			const handlers = captured.handlers.get(event) ?? [];
			handlers.push(handler);
			captured.handlers.set(event, handlers);
		},
	};
	return { pi, captured };
}

async function withAgent<T>(config: Record<string, unknown>, settings: Record<string, unknown>, fn: (dir: string, agentDir: string) => Promise<T>): Promise<T> {
	const old = process.env.PI_CODING_AGENT_DIR;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-controller-test-"));
	const agentDir = path.join(dir, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "nervous.json"), JSON.stringify(config));
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	try {
		return await fn(dir, agentDir);
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
	}
}

function readSettings(agentDir: string): any {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
}

describe("NERVous root-package enablement", () => {
	it("keeps Pi's complete resource list static so pi config filters remain available", () => {
		const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
		assert.deepEqual(manifest.pi.extensions, ROOT_EXTENSIONS);
		assert.deepEqual(manifest.pi.skills, ROOT_SKILLS);
		assert.deepEqual(manifest.pi.prompts, ROOT_PROMPTS);
	});

	it("temporarily restricts resources and restores the exact Pi config selection", async () => {
		const selected = {
			source: "npm:nervous-system",
			extensions: ["magi/extension/index.ts", "cortex/extension/index.ts"],
			skills: ["magi/skills/magi"],
			prompts: [],
		};
		await withAgent({ version: 1 }, { packages: [selected] }, async (_dir, agentDir) => {
			assert.equal(setRootPackageEnabled(false), true);
			assert.deepEqual(readSettings(agentDir).packages, [{
				source: "npm:nervous-system",
				extensions: [CONTROL_EXTENSION],
				skills: [],
				prompts: [],
			}]);
			assert.equal(setRootPackageEnabled(false), false);
			assert.equal(setRootPackageEnabled(true), true);
			assert.deepEqual(readSettings(agentDir).packages, [selected]);
			assert.equal(fs.existsSync(path.join(agentDir, "nervous.package-resources.json")), false);
		});
	});

	it("updates Pi package resources through /nervous:config before reloading", async () => {
		await withAgent({ version: 1 }, { packages: ["npm:nervous-system"] }, async (dir, agentDir) => {
			const { pi, captured } = stubPi();
			factory(pi);
			const command = captured.commands.find((entry) => entry.name === "nervous:config");
			assert.ok(command);
			const complete = command!.options.getArgumentCompletions as (prefix: string) => Array<{ value: string }> | null;
			assert.deepEqual((complete("enabled=") ?? []).map((item) => item.value), ["enabled=true", "enabled=false"]);
			let reloads = 0;
			const oldCortexPath = process.env.CORTEX_PATH;
			process.env.CORTEX_PATH = path.join(dir, "cortex.json");
			try {
				await (command!.options.handler as (args: string, ctx: any) => Promise<void>)("enabled=false", {
					cwd: dir,
					hasUI: false,
					isProjectTrusted: () => true,
					ui: { notify() {} },
					reload: async () => { reloads++; },
				});
			} finally {
				if (oldCortexPath === undefined) delete process.env.CORTEX_PATH;
				else process.env.CORTEX_PATH = oldCortexPath;
			}
			assert.equal(reloads, 1);
			assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "nervous.json"), "utf8")).enabled, false);
			assert.deepEqual(readSettings(agentDir).packages[0], {
				source: "npm:nervous-system",
				extensions: [CONTROL_EXTENSION],
				skills: [],
				prompts: [],
			});
		});
	});

	it("filters every active global and trusted project source, then restores both selections", async () => {
		await withAgent({ version: 1 }, { packages: ["npm:nervous-system"] }, async (dir, agentDir) => {
			const projectDir = path.join(dir, ".pi");
			fs.mkdirSync(projectDir, { recursive: true });
			const projectSelection = { source: "npm:nervous-system@1.1.1", extensions: ["magi/extension/index.ts"], skills: [], prompts: [] };
			fs.writeFileSync(path.join(projectDir, "settings.json"), JSON.stringify({ packages: [projectSelection] }));

			assert.equal(setRootPackageEnabled(false, undefined, dir, true), true);
			assert.deepEqual(readSettings(agentDir).packages[0], {
				source: "npm:nervous-system",
				extensions: [CONTROL_EXTENSION],
				skills: [],
				prompts: [],
			});
			assert.deepEqual(readSettings(projectDir).packages[0], {
				source: "npm:nervous-system@1.1.1",
				extensions: [CONTROL_EXTENSION],
				skills: [],
				prompts: [],
			});

			assert.equal(setRootPackageEnabled(true, undefined, dir, true), true);
			assert.deepEqual(readSettings(agentDir).packages, ["npm:nervous-system"]);
			assert.deepEqual(readSettings(projectDir).packages, [projectSelection]);
		});
	});

	it("ignores untrusted project settings during package selection", async () => {
		await withAgent({ version: 1 }, { packages: ["npm:nervous-system"] }, async (dir, agentDir) => {
			const projectDir = path.join(dir, ".pi");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, "settings.json"), JSON.stringify({ packages: ["npm:nervous-system@1.1.1"] }));

			assert.equal(setRootPackageEnabled(false, undefined, dir, false), true);
			assert.deepEqual(readSettings(agentDir).packages[0], {
				source: "npm:nervous-system",
				extensions: [CONTROL_EXTENSION],
				skills: [],
				prompts: [],
			});
			assert.deepEqual(readSettings(projectDir).packages, ["npm:nervous-system@1.1.1"]);
		});
	});

	it("does not duplicate the config command when the root CORTEX extension loads", () => {
		const { pi, captured } = stubPi();
		factory(pi);
		cortexExtension(pi);
		assert.deepEqual(captured.commands.filter((command) => command.name === "nervous:config").map((command) => command.name), ["nervous:config"]);
	});

	it("does not register a session_start reload handler", () => {
		const { pi, captured } = stubPi();
		factory(pi);
		assert.equal(captured.handlers.get("session_start")?.length ?? 0, 0);
	});
});
