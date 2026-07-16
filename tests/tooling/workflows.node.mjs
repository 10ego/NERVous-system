import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";
import { verifyWorkflowSources } from "../../scripts/verify-workflows.mjs";

const pullRequest = fs.readFileSync(".github/workflows/pull-request.yml", "utf8");
const release = fs.readFileSync(".github/workflows/release-please.yml", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

function sources(overrides = {}) {
	const nextPullRequest = overrides.pullRequest ?? pullRequest;
	const nextRelease = overrides.release ?? release;
	return {
		pullRequest: nextPullRequest,
		release: nextRelease,
		packageJson: overrides.packageJson ?? packageJson,
		allWorkflows: overrides.allWorkflows ?? [
			["pull-request.yml", nextPullRequest],
			["release-please.yml", nextRelease],
		],
	};
}

function replaceOnce(source, before, after) {
	assert.equal(source.split(before).length - 1, 1, `fixture must contain one occurrence of ${before}`);
	return source.replace(before, after);
}

function replaceFirst(source, before, after) {
	assert.ok(source.includes(before), `fixture must contain ${before}`);
	return source.replace(before, after);
}

function rejects(overrides, pattern) {
	assert.throws(() => verifyWorkflowSources(sources(overrides)), pattern);
}

describe("release workflow trust boundaries", () => {
	test("accepts the checked-in workflows", () => {
		assert.doesNotThrow(() => verifyWorkflowSources(sources()));
	});

	test("rejects mutable or unapproved action references", () => {
		rejects({ pullRequest: replaceOnce(pullRequest, "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", "actions/checkout@v4") }, /not pinned/);
		rejects({ release: replaceOnce(release, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") }, /not approved/);
	});

	test("rejects removal of a fail-closed release gate", () => {
		rejects({ release: replaceFirst(release, "vars.NPM_TRUSTED_PUBLISHING_READY == 'true' && ", "") }, /every release job must use gate/);
	});

	test("rejects the deprecated numeric GitHub App ID input", () => {
		rejects({ release: replaceOnce(release, "client-id: ${{ vars.NERV_OPS_CLIENT_ID }}", "app-id: ${{ vars.NERV_OPS_APP_ID }}") }, /Client ID variable|deprecated GitHub App ID/);
	});

	test("rejects credentials or OIDC in validation and packaging", () => {
		rejects({ release: replaceOnce(release, "    outputs:\n      commit_sha:", "    environment: release-automation\n    outputs:\n      commit_sha:") }, /validate must not enter an environment/);
		rejects({ release: replaceOnce(release, "    permissions:\n      contents: read\n    outputs:\n      artifact_digest:", "    permissions:\n      contents: read\n      id-token: write\n    outputs:\n      artifact_digest:") }, /package must not receive OIDC/);
	});

	test("rejects repository execution in the fresh package boundary", () => {
		rejects({ release: replaceOnce(release, "      - name: Build one lifecycle-script-disabled tarball", "      - name: Install untrusted code\n        run: npm ci\n\n      - name: Build one lifecycle-script-disabled tarball") }, /must not install dependencies/);
	});

	test("rejects source checkout or secrets in the OIDC publisher", () => {
		rejects({ release: replaceOnce(release, "      - name: Set up Node.js for trusted publishing", "      - name: Check out source\n        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n\n      - name: Set up Node.js for trusted publishing") }, /must not check out/);
		rejects({ release: replaceOnce(release, "          ACTION_DOWNLOAD_PATH: ${{ steps.download.outputs.download-path }}", "          ACTION_DOWNLOAD_PATH: ${{ steps.download.outputs.download-path }}\n          NPM_AUTH: ${{ secrets.NPM_AUTH }}") }, /only release may reference one environment secret|publish must not reference secrets/);
	});

	test("rejects weakening the exact publication command", () => {
		const command = 'npm publish "$TARBALL_PATH" --access public --provenance --tag "$DIST_TAG" --ignore-scripts';
		rejects({ release: replaceOnce(release, command, 'npm publish "$TARBALL_PATH" --access public') }, /publish one exact tarball/);
	});

	test("rejects persisted pull-request checkout credentials", () => {
		rejects({ pullRequest: replaceOnce(pullRequest, "persist-credentials: false", "persist-credentials: true") }, /must not persist/);
	});

	test("rejects unreviewed workflow files", () => {
		rejects({ allWorkflows: [["pull-request.yml", pullRequest], ["release-please.yml", release], ["extra.yml", "name: Extra\n"]] }, /exactly the reviewed/);
	});
});
