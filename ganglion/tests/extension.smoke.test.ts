import * as assert from "node:assert";
import { describe, it } from "vitest";
import factory from "../extension/index.ts";
import { formatAllocationReleaseDisposition } from "../extension/render.ts";

function stubPi(): { pi: any; tools: any[]; commands: any[] } {
	const tools: any[] = [];
	const commands: any[] = [];
	return { tools, commands, pi: { registerTool(def: any) { tools.push(def); }, registerCommand(name: string, options: any) { commands.push({ name, options }); } } };
}

describe("ganglion extension factory", () => {
	it("formats every allocation release disposition centrally", () => {
		assert.equal(formatAllocationReleaseDisposition("released"), "capacity released");
		assert.equal(formatAllocationReleaseDisposition("already_free"), "capacity was already free");
		assert.equal(formatAllocationReleaseDisposition("member_unavailable"), "member has no active lease but remains unavailable");
		assert.equal(formatAllocationReleaseDisposition("retained_by_newer_allocation"), "capacity retained by a newer allocation");
		assert.equal(formatAllocationReleaseDisposition("not_terminal"), "no terminal capacity release");
	});

	it("registers the ganglion tool and commands", () => {
		const { pi, tools, commands } = stubPi();
		assert.doesNotThrow(() => factory(pi));
		const ganglion = tools.find((t) => t.name === "ganglion");
		assert.ok(ganglion);
		assert.equal(typeof ganglion.execute, "function");
		assert.equal(typeof ganglion.renderCall, "function");
		assert.equal(typeof ganglion.renderResult, "function");
		assert.ok(ganglion.parameters);
		const names = commands.map((c) => c.name);
		assert.ok(names.includes("ganglion"));
		assert.ok(names.includes("ganglion:groups"));
	});
});
