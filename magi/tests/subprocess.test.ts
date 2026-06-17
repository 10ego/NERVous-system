import * as assert from "node:assert";
import { describe, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
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
});
