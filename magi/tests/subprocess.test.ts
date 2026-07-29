import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { resolveContextSlug } from "@nervous-system/state";
import { createSubprocessRunner, getFinalOutput, getPiInvocation } from "../extension/subprocess.ts";

function assistant(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as Message;
}

describe("getFinalOutput", () => {
	it("returns the last assistant text", () => {
		const msgs: Message[] = [assistant("first"), assistant("second")];
		assert.equal(getFinalOutput(msgs), "second");
	});

	it("returns empty string when there is no assistant text", () => {
		assert.equal(getFinalOutput([]), "");
		assert.equal(getFinalOutput([{ role: "user", content: [{ type: "text", text: "hi" }] } as unknown as Message]), "");
	});
});

describe("getPiInvocation", () => {
	it("returns a command and an args array including the provided args", () => {
		const inv = getPiInvocation(["--mode", "json"]);
		assert.ok(typeof inv.command === "string" && inv.command.length > 0);
		assert.ok(Array.isArray(inv.args));
		assert.deepEqual(inv.args.slice(-2), ["--mode", "json"]);
	});
});

describe("createSubprocessRunner", () => {
	it("returns a callable GenerateFn", () => {
		const fn = createSubprocessRunner({ cwd: process.cwd() });
		assert.equal(typeof fn, "function");
	});

	it("pins the parent context before any standalone MAGI worker can spawn", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magi-context-test-"));
		const oldContext = process.env.NERVOUS_CONTEXT;
		const oldSessionContexts = process.env.NERVOUS_SESSION_CONTEXTS;
		try {
			delete process.env.NERVOUS_CONTEXT;
			delete process.env.NERVOUS_SESSION_CONTEXTS;
			execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			fs.writeFileSync(path.join(dir, "tracked"), "initial");
			execFileSync("git", ["add", "tracked"], { cwd: dir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

			createSubprocessRunner({ cwd: dir });
			assert.equal(resolveContextSlug(dir), "main");
			execFileSync("git", ["switch", "-c", "worker-change"], { cwd: dir, stdio: "ignore" });
			assert.equal(resolveContextSlug(dir), "main", "runner construction must establish the inherited context before spawn");
		} finally {
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
			if (oldSessionContexts === undefined) delete process.env.NERVOUS_SESSION_CONTEXTS; else process.env.NERVOUS_SESSION_CONTEXTS = oldSessionContexts;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
