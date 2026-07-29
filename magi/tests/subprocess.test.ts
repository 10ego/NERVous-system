import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { resolveContextSlug } from "@nervous-system/state";
import { createSubprocessEnvironment, createSubprocessRunner, getFinalOutput, getPiInvocation } from "../extension/subprocess.ts";

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

	it("captures a stable runner context without contaminating a multi-repository host", () => {
		const first = fs.mkdtempSync(path.join(os.tmpdir(), "magi-context-first-"));
		const second = fs.mkdtempSync(path.join(os.tmpdir(), "magi-context-second-"));
		const oldContext = process.env.NERVOUS_CONTEXT;
		const oldSessionContexts = process.env.NERVOUS_SESSION_CONTEXTS;
		const init = (dir: string, branch: string) => {
			execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			fs.writeFileSync(path.join(dir, "tracked"), "initial");
			execFileSync("git", ["add", "tracked"], { cwd: dir });
			execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
		};
		try {
			delete process.env.NERVOUS_CONTEXT;
			delete process.env.NERVOUS_SESSION_CONTEXTS;
			init(first, "main");
			init(second, "feature/other");

			const firstEnv = createSubprocessEnvironment(first);
			const secondEnv = createSubprocessEnvironment(second);
			assert.equal(firstEnv.NERVOUS_CONTEXT, "main");
			assert.equal(secondEnv.NERVOUS_CONTEXT, "feature-other");
			assert.equal(process.env.NERVOUS_CONTEXT, undefined, "runner construction must not mutate the host context");

			execFileSync("git", ["switch", "-c", "worker-change"], { cwd: first, stdio: "ignore" });
			assert.equal(firstEnv.NERVOUS_CONTEXT, "main", "the captured child environment stays stable after branch changes");
			assert.equal(resolveContextSlug(first), "main");
		} finally {
			if (oldContext === undefined) delete process.env.NERVOUS_CONTEXT; else process.env.NERVOUS_CONTEXT = oldContext;
			if (oldSessionContexts === undefined) delete process.env.NERVOUS_SESSION_CONTEXTS; else process.env.NERVOUS_SESSION_CONTEXTS = oldSessionContexts;
			fs.rmSync(first, { recursive: true, force: true });
			fs.rmSync(second, { recursive: true, force: true });
		}
	});
});
