import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export const NERVOUS_ACTIVATION_ENTRY = "nervous-chain-activation";
export const NERVOUS_PROMPT_SIGNATURE = "Use the NERVous System for this invocation.";

let invocationTemplate: string | undefined;

function loadInvocationTemplate(): string {
	if (invocationTemplate !== undefined) return invocationTemplate;
	const promptPath = fileURLToPath(new URL("../../cortex/prompts/nervous.md", import.meta.url));
	const raw = fs.readFileSync(promptPath, "utf8");
	invocationTemplate = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	return invocationTemplate;
}

/** Expand the bundled workflow prompt without routing extension-injected input back through slash-command handling. */
export function buildNervousInvocation(argumentsText: string): string {
	return loadInvocationTemplate().replace(/\$ARGUMENTS/g, () => argumentsText);
}
