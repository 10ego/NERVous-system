import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { AxonStore, resolveLedgerLocation } from "../extension/backend.ts";

async function withNamespace<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const old: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) old[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) process.env[key] = value;
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(old)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("AXON global project/context namespace", () => {
	it("shares ledger data across new store instances in the same project/context", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-global-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "feature-upload" }, async () => {
			const firstSession = AxonStore.fromCwd("/tmp/repo-a");
			await firstSession.mutate((ledger) => ledger.create({ title: "shared task" }));

			const secondSession = AxonStore.fromCwd("/tmp/repo-a");
			const { result } = await secondSession.query((ledger) => ledger.all());
			assert.equal(result.length, 1);
			assert.equal(result[0]?.title, "shared task");
			assert.equal(resolveLedgerLocation("/tmp/repo-a").ledgerPath, path.join(root, "repo-a", "feature-upload", "axon", "ledger.json"));
		});
	});

	it("isolates ledgers across contexts in the same project", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-global-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "feature-upload" }, async () => {
			await AxonStore.fromCwd("/tmp/repo-a").mutate((ledger) => ledger.create({ title: "upload task" }));
		});
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "new-clean-context" }, async () => {
			const { result } = await AxonStore.fromCwd("/tmp/repo-a").query((ledger) => ledger.all());
			assert.equal(result.length, 0);
		});
	});

	it("isolates ledgers across projects even when context names match", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-global-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "main" }, async () => {
			await AxonStore.fromCwd("/tmp/repo-a").mutate((ledger) => ledger.create({ title: "repo a task" }));
		});
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-b", NERVOUS_CONTEXT: "main" }, async () => {
			const { result } = await AxonStore.fromCwd("/tmp/repo-b").query((ledger) => ledger.all());
			assert.equal(result.length, 0);
		});
	});
});
