import * as assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "vitest";
import { resolveNervousStateFile, resolveProjectSlug, resolveContextSlug, slug } from "../src/index.ts";

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
