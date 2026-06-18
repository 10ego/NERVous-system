import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface NervousStateInfo {
	root: string;
	project: string;
	context: string;
	component: string;
	filePath: string;
}

export function resolveNervousStateFile(
	cwd: string,
	component: string,
	filename: string,
	explicitEnvName?: string,
): string {
	const explicit = explicitEnvName ? process.env[explicitEnvName] : undefined;
	if (explicit && path.isAbsolute(explicit)) return explicit;
	return resolveNervousStateInfo(cwd, component, filename).filePath;
}

export function resolveNervousStateInfo(cwd: string, component: string, filename: string): NervousStateInfo {
	const root = resolveRoot();
	const project = resolveProjectSlug(cwd);
	const context = resolveContextSlug(cwd);
	const filePath = path.join(root, project, context, component, filename);
	return { root, project, context, component, filePath };
}

export function resolveRoot(): string {
	const configured = process.env.NERVOUS_STATE_ROOT;
	return configured ? path.resolve(configured) : path.join(homedir(), ".pi", "nervous");
}

export function resolveProjectSlug(cwd: string): string {
	const configured = process.env.NERVOUS_PROJECT;
	if (configured?.trim()) return slug(configured, "project");
	const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? canonicalPath(cwd);
	const name = path.basename(root) || "project";
	return `${slug(name, "project")}-${hash(root)}`;
}

export function resolveContextSlug(cwd: string): string {
	const configured = process.env.NERVOUS_CONTEXT;
	if (configured?.trim()) return slug(configured, "default");
	const branch = git(cwd, ["branch", "--show-current"]);
	if (branch?.trim()) return slug(branch, "default");
	const sha = git(cwd, ["rev-parse", "--short", "HEAD"]);
	if (sha?.trim()) return `detached-${slug(sha, "head")}`;
	return "default";
}

export function slug(input: string, fallback: string): string {
	const s = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return s || fallback;
}

function canonicalPath(cwd: string): string {
	const resolved = path.resolve(cwd);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function hash(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}
