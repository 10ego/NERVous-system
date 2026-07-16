import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PACKAGE_FILES = Object.freeze([
	"README.md",
	"RELEASES.md",
	"docs/",
	"controller/extension/",
	"magi/README.md",
	"magi/config/",
	"magi/extension/",
	"magi/prompts/",
	"magi/skills/",
	"axon/README.md",
	"axon/config/",
	"axon/extension/",
	"axon/skills/",
	"synapse/README.md",
	"synapse/extension/",
	"synapse/skills/",
	"cortex/README.md",
	"cortex/extension/",
	"cortex/prompts/",
	"cortex/skills/",
	"lion/README.md",
	"lion/extension/",
	"lion/prompts/",
	"lion/skills/",
	"cerebel/README.md",
	"cerebel/extension/",
	"cerebel/prompts/",
	"cerebel/skills/",
	"ganglion/README.md",
	"ganglion/extension/",
	"ganglion/prompts/",
	"ganglion/skills/",
	"amygdala/README.md",
	"amygdala/extension/",
	"amygdala/prompts/",
	"amygdala/skills/",
	"dashboard/README.md",
	"dashboard/extension/",
	"demo/README.md",
]);

export const EXPECTED_EXTENSIONS = Object.freeze([
	"controller/extension/index.ts",
	"magi/extension/index.ts",
	"axon/extension/index.ts",
	"synapse/extension/index.ts",
	"cortex/extension/index.ts",
	"lion/extension/index.ts",
	"cerebel/extension/index.ts",
	"ganglion/extension/index.ts",
	"amygdala/extension/index.ts",
	"dashboard/extension/index.ts",
]);

export const EXPECTED_SKILLS = Object.freeze([
	"magi/skills/magi",
	"axon/skills/axon",
	"synapse/skills/synapse",
	"cortex/skills/cortex",
	"lion/skills/lion",
	"cerebel/skills/cerebel",
	"ganglion/skills/ganglion",
	"amygdala/skills/amygdala",
]);

export const EXPECTED_PROMPTS = Object.freeze([
	"magi/prompts",
	"cortex/prompts/cortex.md",
	"lion/prompts",
	"cerebel/prompts",
	"ganglion/prompts",
	"amygdala/prompts",
]);

const REQUIRED_PACKAGE_PATHS = Object.freeze([
	"package.json",
	"README.md",
	"RELEASES.md",
	"docs/README.md",
	...EXPECTED_EXTENSIONS,
	...EXPECTED_SKILLS.map((skill) => `${skill}/SKILL.md`),
	"magi/prompts/deliberate.md",
	"cortex/prompts/cortex.md",
	"lion/prompts/lion.md",
	"cerebel/prompts/cerebel.md",
	"ganglion/prompts/ganglion.md",
	"amygdala/prompts/amygdala.md",
]);

const FORBIDDEN_SEGMENTS = new Set([
	".git",
	".github",
	".pi",
	"coverage",
	"dist",
	"node_modules",
	"state",
	"temp",
	"tests",
	"tmp",
]);

const FORBIDDEN_LIFECYCLE_SCRIPTS = Object.freeze([
	"preinstall",
	"install",
	"postinstall",
	"prepack",
	"prepare",
	"postpack",
	"prepublish",
	"prepublishOnly",
	"publish",
	"postpublish",
]);

const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".ts"]);

function invariant(condition, message) {
	if (!condition) throw new Error(`Package invariant failed: ${message}`);
}

function normalizePackagePath(filePath) {
	return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matchesFilesAllowlist(filePath) {
	if (filePath === "package.json") return true;
	return EXPECTED_PACKAGE_FILES.some((entry) => entry.endsWith("/")
		? filePath.startsWith(entry) && filePath.length > entry.length
		: filePath === entry);
}

export function assertPackageContents(files) {
	invariant(Array.isArray(files), "npm pack output must contain a files array");
	invariant(files.length > 0 && files.length <= 250, "package must contain between 1 and 250 files");

	const paths = files.map((file) => {
		invariant(file && typeof file.path === "string", "each npm pack file must have a string path");
		const normalized = normalizePackagePath(file.path);
		const segments = normalized.split("/");
		invariant(
			normalized === file.path
				&& !normalized.startsWith("/")
				&& !/^[A-Za-z]:\//.test(normalized)
				&& segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
			`unsafe package path: ${file.path}`,
		);
		invariant(!segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)), `forbidden package path: ${normalized}`);
		invariant(matchesFilesAllowlist(normalized), `path is outside package.json files policy: ${normalized}`);
		invariant(ALLOWED_EXTENSIONS.has(path.extname(normalized)), `unsupported package file type: ${normalized}`);
		invariant(Number.isInteger(file.size) && file.size >= 0, `invalid file size for ${normalized}`);
		invariant(file.mode === 0o644, `package files must be non-executable: ${normalized}`);
		return normalized;
	});

	invariant(new Set(paths).size === paths.length, "package must not contain duplicate paths");
	for (const requiredPath of REQUIRED_PACKAGE_PATHS) {
		invariant(paths.includes(requiredPath), `package is missing required path: ${requiredPath}`);
	}
	return paths;
}

export function assertPackageMetadata(packageData, packageJson, pathCount) {
	invariant(packageData && typeof packageData === "object", "npm pack must describe one package");
	invariant(packageJson && typeof packageJson === "object", "package.json must be readable");
	invariant(packageJson.name === "nervous-system", "package name must be nervous-system");
	invariant(packageData.name === packageJson.name, "packed name must match package.json");
	invariant(packageData.version === packageJson.version, "packed version must match package.json");
	invariant(packageData.id === `${packageJson.name}@${packageJson.version}`, "packed id must match name and version");
	invariant(packageData.filename === `${packageJson.name}-${packageJson.version}.tgz`, "tarball filename must match name and version");
	invariant(packageData.entryCount === pathCount, "npm entry count must match audited paths");
	invariant(Number.isInteger(packageData.size) && packageData.size > 0 && packageData.size <= 10 * 1024 * 1024, "tarball size must be between 1 byte and 10 MiB");
	invariant(Number.isInteger(packageData.unpackedSize) && packageData.unpackedSize > 0 && packageData.unpackedSize <= 25 * 1024 * 1024, "unpacked size must be between 1 byte and 25 MiB");
	invariant(typeof packageData.shasum === "string" && /^[0-9a-f]{40}$/.test(packageData.shasum), "npm pack must emit a SHA-1 shasum");
	invariant(typeof packageData.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(packageData.integrity), "npm pack must emit SHA-512 integrity");
	invariant(Array.isArray(packageData.bundled) && packageData.bundled.length === 0, "package must not bundle dependencies");
	invariant(JSON.stringify(packageJson.files) === JSON.stringify(EXPECTED_PACKAGE_FILES), "package.json files policy must remain exact");
	invariant(JSON.stringify(packageJson.pi?.extensions) === JSON.stringify(EXPECTED_EXTENSIONS), "Pi extension entries must remain exact");
	invariant(JSON.stringify(packageJson.pi?.skills) === JSON.stringify(EXPECTED_SKILLS), "Pi skill entries must remain exact");
	invariant(JSON.stringify(packageJson.pi?.prompts) === JSON.stringify(EXPECTED_PROMPTS), "Pi prompt entries must remain exact");
	invariant(packageJson.repository?.url === "git+https://github.com/10ego/NERVous-system.git", "repository URL must be canonical");
	invariant(packageJson.homepage === "https://github.com/10ego/NERVous-system#readme", "homepage must be canonical");
	invariant(packageJson.bugs?.url === "https://github.com/10ego/NERVous-system/issues", "bug URL must be canonical");
	invariant(packageJson.publishConfig?.access === "public", "publish access must be public");
	invariant(packageJson.publishConfig?.registry === "https://registry.npmjs.org/", "publish registry must be npmjs");
	invariant(packageJson.publishConfig?.provenance === true, "publish provenance must be enabled");
	invariant(packageJson.private === undefined, "package must not be private");
	invariant(packageJson.dependencies?.["@nervous-system/state"] === "1.0.0", "state package dependency must remain exact");
	for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
		invariant(!Object.hasOwn(packageJson.scripts ?? {}, script), `package lifecycle script is forbidden: ${script}`);
	}
}

export function verifyPackageContents(rootDir = process.cwd()) {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npmCommand, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: rootDir,
		encoding: "utf8",
		shell: false,
	});
	if (result.error) throw new Error(`Could not run npm pack: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
		throw new Error(`npm pack --dry-run failed: ${detail}`);
	}

	let payload;
	try {
		payload = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Could not parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	invariant(Array.isArray(payload) && payload.length === 1, "npm pack must describe exactly one package");
	const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
	const paths = assertPackageContents(payload[0].files);
	assertPackageMetadata(payload[0], packageJson, paths.length);
	return { package: payload[0], paths };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const result = verifyPackageContents();
		console.log(`Verified ${result.paths.length} files in ${result.package.filename}.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
