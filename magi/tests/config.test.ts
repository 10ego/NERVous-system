import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	DEFAULT_CONFIG,
	MAX_COUNCILLORS,
	MIN_COUNCILLORS,
	PRESETS,
	resolveCouncil,
	validateCouncilConfig,
} from "../extension/config.ts";
import type { CouncilConfig } from "../extension/schema.ts";

const BUNDLED = path.resolve(process.cwd(), "config");

function councillor(id: string, extra: Partial<{ name: string; role: string }> = {}): CouncilConfig["councillors"][number] {
	return { id, name: extra.name ?? `Councillor ${id}`, role: extra.role ?? "deliberates" };
}

describe("validateCouncilConfig — limits", () => {
	it("accepts the default 3-councillor council", () => {
		const r = validateCouncilConfig(DEFAULT_CONFIG);
		assert.ok(r.valid, r.errors.join("; "));
		assert.equal(r.config.synthesizer, "hand");
		assert.equal(r.config.critique, true);
	});

	it("rejects more than 3 councillors", () => {
		const cfg: CouncilConfig = {
			councillors: [councillor("a"), councillor("b"), councillor("c"), councillor("d")],
		};
		const r = validateCouncilConfig(cfg);
		assert.ok(!r.valid);
		assert.ok(r.errors.some((e) => e.includes("more than 3") && e.includes(`${MAX_COUNCILLORS}`)));
	});

	it("rejects zero councillors", () => {
		const r = validateCouncilConfig({ councillors: [] });
		assert.ok(!r.valid);
		assert.ok(r.errors.some((e) => e.includes(`${MIN_COUNCILLORS}`)));
	});

	it("accepts 1, 2, and 3 councillors", () => {
		for (const n of [1, 2, 3]) {
			const cfg: CouncilConfig = { councillors: Array.from({ length: n }, (_, i) => councillor(`c${i}`)) };
			const r = validateCouncilConfig(cfg);
			assert.ok(r.valid, `n=${n}: ${r.errors.join("; ")}`);
		}
	});
});

describe("validateCouncilConfig — fields + defaults", () => {
	it("rejects duplicate ids", () => {
		const r = validateCouncilConfig({ councillors: [councillor("dup"), councillor("dup")] });
		assert.ok(!r.valid);
		assert.ok(r.errors.some((e) => e.includes("duplicate")));
	});

	it("rejects missing id/name/role", () => {
		const r = validateCouncilConfig({
			councillors: [{ id: "", name: "x", role: "r" }, { id: "ok", name: "", role: "r" }, { id: "ok2", name: "y", role: "" }],
		});
		assert.ok(!r.valid);
	});

	it("rejects an invalid id format", () => {
		const r = validateCouncilConfig({ councillors: [councillor("Bad ID")] });
		assert.ok(!r.valid);
		assert.ok(r.errors.some((e) => e.includes("id")));
	});

	it("defaults synthesizer to hand when present, else last", () => {
		const withHand = validateCouncilConfig({ councillors: [councillor("mind"), councillor("hand")] });
		assert.equal(withHand.config.synthesizer, "hand");

		const withoutHand = validateCouncilConfig({ councillors: [councillor("mind"), councillor("soul")] });
		assert.equal(withoutHand.config.synthesizer, "soul");
	});

	it("defaults critique on for >=2, off for solo councils", () => {
		assert.equal(validateCouncilConfig({ councillors: [councillor("a"), councillor("b")] }).config.critique, true);
		assert.equal(validateCouncilConfig({ councillors: [councillor("a")] }).config.critique, false);
	});

	it("warns when critique is forced on for a solo council", () => {
		const r = validateCouncilConfig({ critique: true, councillors: [councillor("a")] });
		assert.ok(r.warnings.some((w) => w.includes("only one councillor")));
	});

	it("rejects a synthesizer that is not in the council", () => {
		const r = validateCouncilConfig({ synthesizer: "ghost", councillors: [councillor("mind"), councillor("hand")] });
		assert.ok(!r.valid);
		assert.ok(r.errors.some((e) => e.includes("synthesizer")));
	});
});

describe("resolveCouncil — precedence", () => {
	it("resolves presets by name", () => {
		assert.equal(resolveCouncil("default", { cwd: process.cwd(), bundledConfigDir: BUNDLED }).config.councillors.length, 3);
		assert.equal(resolveCouncil("two", { cwd: process.cwd(), bundledConfigDir: BUNDLED }).config.councillors.length, 2);
		assert.equal(resolveCouncil("one", { cwd: process.cwd(), bundledConfigDir: BUNDLED }).config.councillors.length, 1);
		assert.ok(PRESETS.three && PRESETS.default);
	});

	it("resolves inline JSON", () => {
		const inline = JSON.stringify({
			synthesizer: "x",
			councillors: [{ id: "x", name: "X", role: "r" }],
		});
		const r = resolveCouncil(inline, { cwd: process.cwd(), bundledConfigDir: BUNDLED });
		assert.equal(r.source, "inline-json");
		assert.equal(r.config.councillors[0]?.id, "x");
	});

	it("resolves a file path", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magi-cfg-"));
		const file = path.join(dir, "council.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ councillors: [{ id: "solo", name: "Solo", role: "r" }] }),
			"utf-8",
		);
		const r = resolveCouncil(file, { cwd: process.cwd(), bundledConfigDir: BUNDLED });
		assert.equal(r.source, `file:${file}`);
		assert.equal(r.config.councillors[0]?.id, "solo");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to the bundled default and validates it", () => {
		const r = resolveCouncil(undefined, { cwd: process.cwd(), bundledConfigDir: BUNDLED });
		assert.ok(r.config.councillors.length >= 1 && r.config.councillors.length <= 3);
		assert.deepEqual(
			r.config.councillors.map((c) => c.id),
			["mind", "heart", "hand"],
		);
	});

	it("throws on an invalid inline config (>3 councillors)", () => {
		const inline = JSON.stringify({
			councillors: [
				councillor("a"),
				councillor("b"),
				councillor("c"),
				councillor("d"),
			],
		});
		assert.throws(
			() => resolveCouncil(inline, { cwd: process.cwd(), bundledConfigDir: BUNDLED }),
			/more than 3/,
		);
	});
});
