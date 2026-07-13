import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import { verifyRootReleaseVersion } from "../scripts/verify-release-version.mjs";

type VersionFiles = {
	manifest?: unknown;
	packageJson?: unknown;
	lockfile?: unknown;
	lockfileRoot?: unknown;
};

function writeVersionFiles(versions: VersionFiles = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-release-version-test-"));
	fs.writeFileSync(path.join(dir, ".release-please-manifest.json"), JSON.stringify({ ".": versions.manifest ?? "1.2.3" }));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: versions.packageJson ?? "1.2.3" }));
	fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({
		version: versions.lockfile ?? "1.2.3",
		packages: { "": { version: versions.lockfileRoot ?? "1.2.3" } },
	}));
	return dir;
}

describe("root release-version invariant", () => {
	it("accepts matching Release Please and npm metadata", () => {
		assert.equal(verifyRootReleaseVersion(writeVersionFiles()), "1.2.3");
		assert.match(verifyRootReleaseVersion(process.cwd()), /^\d+\.\d+\.\d+$/);
	});

	for (const [location, versions] of [
		["Release Please manifest", { manifest: "1.2.2" }],
		["package manifest", { packageJson: "1.2.2" }],
		["lockfile header", { lockfile: "1.2.2" }],
		["root lockfile package", { lockfileRoot: "1.2.2" }],
	] satisfies [string, VersionFiles][]) {
		it(`rejects a stale ${location}`, () => {
			assert.throws(() => verifyRootReleaseVersion(writeVersionFiles(versions)), /Root release version mismatch/);
		});
	}

	it("rejects missing or malformed root versions", () => {
		const missing = fs.mkdtempSync(path.join(os.tmpdir(), "nervous-release-version-test-"));
		fs.writeFileSync(path.join(missing, ".release-please-manifest.json"), JSON.stringify({ ".": "1.2.3" }));
		fs.writeFileSync(path.join(missing, "package.json"), JSON.stringify({ version: "1.2.3" }));
		fs.writeFileSync(path.join(missing, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": {} } }));
		assert.throws(() => verifyRootReleaseVersion(missing), /valid semantic version/);
		assert.throws(() => verifyRootReleaseVersion(writeVersionFiles({ packageJson: "not-a-version" })), /valid semantic version/);
	});

	it("rejects leading zeroes in numeric prerelease identifiers even when every field agrees", () => {
		const invalidVersion = "1.2.3-01";
		assert.throws(() => verifyRootReleaseVersion(writeVersionFiles({
			manifest: invalidVersion,
			packageJson: invalidVersion,
			lockfile: invalidVersion,
			lockfileRoot: invalidVersion,
		})), /valid semantic version/);
	});

	it("binds publish verification to Release Please's emitted version", () => {
		const dir = writeVersionFiles();
		assert.equal(verifyRootReleaseVersion(dir, "1.2.3"), "1.2.3");
		assert.throws(() => verifyRootReleaseVersion(dir, "1.2.4"), /expected release version/);
	});
});
