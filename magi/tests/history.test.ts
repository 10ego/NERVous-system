import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { MagiHistoryStore } from "../extension/history.ts";
import type { MagiOutput } from "../extension/schema.ts";

const output: MagiOutput = {
	council_used: ["mind", "heart", "hand"],
	individual_opinions: [
		{ councillor: "mind", position: "Proceed only with evidence", concerns: ["risk"], recommendation: "pause" },
	],
	points_of_agreement: ["needs evidence"],
	points_of_disagreement: [],
	risks: ["data loss"],
	rejected_options: ["continue blindly"],
	final_recommendation: "Pause, gather evidence, then decide.",
	confidence: "high",
	meta: { critique_used: false, synthesizer: "hand", rounds: 1, warnings: [] },
};

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

describe("MAGI history global project/context namespace", () => {
	it("shares deliberation history across new store instances in the same project/context", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-magi-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "migration-risk" }, async () => {
			await MagiHistoryStore.fromCwd("/tmp/repo-a").append({ issue: "Should migration continue?" }, output, "test");
			const records = await MagiHistoryStore.fromCwd("/tmp/repo-a").list();
			assert.equal(records.length, 1);
			assert.equal(records[0]?.input.issue, "Should migration continue?");
			assert.equal(records[0]?.output.individual_opinions[0]?.councillor, "mind");
		});
	});

	it("serializes concurrent append transactions without losing records", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-magi-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "concurrent" }, async () => {
			const history = MagiHistoryStore.fromCwd("/tmp/repo-a");
			await Promise.all(Array.from({ length: 20 }, (_, index) => history.append({ issue: `issue-${index}` }, output, `source-${index}`)));
			const records = await history.list(100);
			assert.equal(records.length, 20);
			assert.equal(new Set(records.map((record) => record.source)).size, 20);
		});
	});

	it("isolates deliberation history across context and project namespaces", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "nervous-magi-"));
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "ctx-a" }, async () => {
			await MagiHistoryStore.fromCwd("/tmp/repo-a").append({ issue: "ctx a" }, output, "test");
		});
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-a", NERVOUS_CONTEXT: "ctx-b" }, async () => {
			assert.equal((await MagiHistoryStore.fromCwd("/tmp/repo-a").list()).length, 0);
		});
		await withNamespace({ NERVOUS_STATE_ROOT: root, NERVOUS_PROJECT: "repo-b", NERVOUS_CONTEXT: "ctx-a" }, async () => {
			assert.equal((await MagiHistoryStore.fromCwd("/tmp/repo-b").list()).length, 0);
		});
	});
});
