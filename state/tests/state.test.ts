import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	applyNervousEnabledPatch,
	applyNervousModelPatch,
	getNervousEnabled,
	getNervousModel,
	loadNervousConfig,
	readUserNervousConfig,
	resolveNervousEnabled,
	resolveNervousModel,
	resolveNervousStateFile,
	resolveProjectSlug,
	resolveContextSlug,
	slug,
	writeUserNervousConfig,
} from "../src/index.ts";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
	const old: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) old[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return fn();
	} finally {
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("NERVous state resolver", () => {
	it("uses global root with project and context namespaces", () => {
		withEnv({ NERVOUS_STATE_ROOT: "/tmp/nervous", NERVOUS_PROJECT: "My Repo", NERVOUS_CONTEXT: "Upload API" }, () => {
			assert.equal(resolveNervousStateFile("/tmp/proj", "axon", "ledger.json"), path.join("/tmp/nervous", "my-repo", "upload-api", "axon", "ledger.json"));
		});
	});

	it("keeps explicit component path overrides highest precedence", () => {
		withEnv({ AXON_LEDGER_PATH: "/tmp/custom-ledger.json", NERVOUS_STATE_ROOT: "/tmp/nervous", NERVOUS_PROJECT: "p", NERVOUS_CONTEXT: "c" }, () => {
			assert.equal(resolveNervousStateFile("/tmp/proj", "axon", "ledger.json", "AXON_LEDGER_PATH"), "/tmp/custom-ledger.json");
		});
	});

	it("slugifies project/context values", () => {
		assert.equal(slug("Feature/Auth Upload", "x"), "feature-auth-upload");
		withEnv({ NERVOUS_PROJECT: "Project A", NERVOUS_CONTEXT: "Branch/One" }, () => {
			assert.equal(resolveProjectSlug("/tmp/proj"), "project-a");
			assert.equal(resolveContextSlug("/tmp/proj"), "branch-one");
		});
	});
});

describe("NERVous enablement config", () => {
	it("defaults to enabled without writing an enablement setting", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const resolution = loadNervousConfig({ cwd: dir, agentDir: path.join(dir, "agent"), isProjectTrusted: true });
		assert.equal(getNervousEnabled(resolution.effective), undefined);
		assert.deepEqual(resolveNervousEnabled(resolution), { enabled: true, source: "default" });
	});

	it("persists a user enablement setting and lets a trusted project override it", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const agentDir = path.join(dir, "agent");
		writeUserNervousConfig(applyNervousEnabledPatch(readUserNervousConfig(agentDir), false), agentDir);
		const userOnly = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: false });
		assert.equal(resolveNervousEnabled(userOnly).enabled, false);
		assert.equal(resolveNervousEnabled(userOnly).source, "user");

		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "nervous.json"), JSON.stringify({ version: 1, enabled: true }));
		const trusted = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: true });
		assert.equal(resolveNervousEnabled(trusted).enabled, true);
		assert.equal(resolveNervousEnabled(trusted).source, "project");
	});
});

describe("NERVous model config", () => {
	it("defaults model keys to unset so callers keep pi defaults", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const resolution = loadNervousConfig({ cwd: dir, agentDir: path.join(dir, "agent"), isProjectTrusted: true });
		assert.equal(getNervousModel(resolution.effective, "lion.default"), undefined);
		assert.equal(resolveNervousModel(resolution, "magi.councillorDefault").source, "default");
	});

	it("writes user config and overlays trusted project config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const agentDir = path.join(dir, "agent");
		const user = applyNervousModelPatch(readUserNervousConfig(agentDir), {
			"lion.default": "openai/gpt-fast",
			"lion.implementationDefault": "openai/gpt-implement",
			"lion.reviewDefault": "anthropic/claude-review",
			"magi.councillorDefault": "anthropic/claude-balanced",
		});
		writeUserNervousConfig(user, agentDir);
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi", "nervous.json"),
			JSON.stringify({ version: 1, models: { lion: { default: "anthropic/claude-project" } } }),
		);

		const untrusted = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: false });
		assert.equal(resolveNervousModel(untrusted, "lion.default").model, "openai/gpt-fast");
		assert.equal(resolveNervousModel(untrusted, "lion.default").source, "user");

		const trusted = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: true });
		assert.equal(resolveNervousModel(trusted, "lion.default").model, "anthropic/claude-project");
		assert.equal(resolveNervousModel(trusted, "lion.default").source, "project");
		assert.equal(resolveNervousModel(trusted, "lion.implementationDefault").model, "openai/gpt-implement");
		assert.equal(resolveNervousModel(trusted, "lion.reviewDefault").model, "anthropic/claude-review");
		assert.equal(resolveNervousModel(trusted, "magi.councillorDefault").model, "anthropic/claude-balanced");
	});

	it("lets a trusted project null explicitly restore pi default over a user model", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const agentDir = path.join(dir, "agent");
		writeUserNervousConfig(applyNervousModelPatch(readUserNervousConfig(agentDir), { "lion.default": "openai/gpt-fast" }), agentDir);
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "nervous.json"), JSON.stringify({ version: 1, models: { lion: { default: null } } }));

		const trusted = loadNervousConfig({ cwd: dir, agentDir, isProjectTrusted: true });
		assert.equal(resolveNervousModel(trusted, "lion.default").source, "default");
		assert.equal(getNervousModel(trusted.effective, "lion.default"), undefined);
	});

	it("resolves trusted project model config from the git root when cwd is a subdirectory", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-config-test-"));
		const agentDir = path.join(dir, "agent");
		execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
		const subdir = path.join(dir, "packages", "app");
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.mkdirSync(subdir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "nervous.json"), JSON.stringify({ version: 1, models: { lion: { default: "provider/project" } } }));

		const trusted = loadNervousConfig({ cwd: subdir, agentDir, isProjectTrusted: true });
		assert.equal(trusted.projectPath, path.join(fs.realpathSync(dir), ".pi", "nervous.json"));
		assert.equal(resolveNervousModel(trusted, "lion.default").model, "provider/project");
	});
});
