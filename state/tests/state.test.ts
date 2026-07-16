import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	applyNervousModelPatch,
	formatNervousStateReport,
	getNervousModel,
	inspectNervousContext,
	loadNervousConfig,
	readUserNervousConfig,
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

async function withEnvAsync<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const old: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) old[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await fn();
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

	it("reports durable lifetime, transient retention, and record volume without mutating state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-state-inventory-"));
		await withEnvAsync({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "Project A", NERVOUS_CONTEXT: "Main", SYNAPSE_TTL_MS: undefined, SYNAPSE_MAX_NOTES: undefined }, async () => {
			const contextDir = path.join(root, "project-a", "main");
			fs.mkdirSync(path.join(contextDir, "cortex"), { recursive: true });
			fs.mkdirSync(path.join(contextDir, "synapse"), { recursive: true });
			fs.mkdirSync(path.join(root, "project-a", "another-work"), { recursive: true });
			fs.writeFileSync(path.join(contextDir, "cortex", "cortex.json"), JSON.stringify({ updated_at: "2026-07-16T00:00:00.000Z", goals: {
				"goal-001": { status: "completed" },
				"goal-002": { status: "executing" },
			} }));
			fs.writeFileSync(path.join(contextDir, "synapse", "synapse.json"), JSON.stringify({ notes: [{ id: "note-001" }] }));

			const snapshot = await inspectNervousContext(root);
			assert.equal(snapshot.files.find((file) => file.component === "cortex")?.recordCount, 2);
			assert.equal(snapshot.files.find((file) => file.component === "cortex")?.openRecordCount, 1);
			assert.deepEqual(snapshot.otherContexts, ["another-work"]);
			const report = formatNervousStateReport(snapshot);
			assert.match(report, /have no TTL and remain until the whole context is explicitly reset/);
			assert.match(report, /SYNAPSE is transient: 1d TTL, 1000 notes/);
			assert.match(report, /Dashboard\/list limits only display up to 100 recent records; they do not delete/);
			assert.match(report, /CORTEX: 2 record\(s\), 1 open/);
			assert.match(report, /Other work contexts: 1 \(another-work\)/);
			assert.equal(fs.existsSync(path.join(contextDir, "cortex", "cortex.json")), true);
		});
	});

	it("surfaces malformed JSON and explicit path overrides in diagnostics", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-state-invalid-"));
		const override = path.join(root, "legacy-cerebel.json");
		fs.writeFileSync(override, "{not-json");
		await withEnvAsync({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "p", NERVOUS_CONTEXT: "c", CEREBEL_PATH: override }, async () => {
			const snapshot = await inspectNervousContext(root);
			const cerebel = snapshot.files.find((file) => file.component === "cerebel");
			assert.equal(cerebel?.source, "override");
			assert.match(cerebel?.parseError ?? "", /JSON/);
		});
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
