# Releases

## 1.0.0 — coordinated stable release

Version 1.0.0 is the first coordinated stable release of the NERVous System workspace. The root `nervous-system` package is the npm distribution installed by users; it bundles the component extensions and depends on the separately published `@nervous-system/state` package. The automated release workflow versions and publishes the root package.

The 1.x compatibility commitment covers documented tool actions, extension entry points, and persisted state written by 1.x releases. Backward-compatible additions may ship in minor releases, fixes in patch releases, and incompatible public or durable-schema changes require a new major version.

## Automated releases

[Release Please](https://github.com/googleapis/release-please) watches conventional commits merged into `main`. It opens or updates a release PR containing the calculated version changes, `CHANGELOG.md`, and release manifest. Merging that release PR creates a GitHub release and, after the test suite passes, publishes `nervous-system` to npm with provenance.

Semver is selected from the merged commit (normally the squash-merged PR title):

- `feat: ...` creates a minor release.
- `feat!: ...`, `fix!: ...`, or a `BREAKING CHANGE:` footer creates a major release.
- Every other allowed type—`fix:`, `perf:`, `revert:`, `chore:`, `docs:`, `refactor:`, `style:`, and `test:`—creates a patch release.

### Merge policy

All changes to `main` must go through a pull request and use squash merging. The required `Validate PR title` check enforces the conventional title that becomes the squash commit, and the required `Test` check runs the full test suite. Direct pushes, force pushes, branch deletion, and bypassing these requirements as an administrator are disabled.

### One-time repository setup

1. In the npm settings for [`nervous-system`](https://www.npmjs.com/package/nervous-system), add a GitHub Actions trusted publisher with:
   - organization/user: `10ego`
   - repository: `NERVous-system`
   - workflow filename: `release-please.yml`
   - environment: leave blank
2. Install the private [`nerv-ops`](https://github.com/settings/apps/nerv-ops) GitHub App on this repository with **Contents: read and write** and **Pull requests: read and write** permissions.
3. Add the App ID as the repository Actions variable `NERV_OPS_APP_ID`, and add a generated PEM private key as the repository Actions secret `NERV_OPS_PRIVATE_KEY`. Release Please exchanges these credentials for a short-lived, repository-scoped installation token; no personal access token is stored.
4. Use conventional titles for squash-merged PRs so Release Please can calculate the intended version.

No npm token is stored in GitHub. The publish job uses npm trusted publishing through GitHub's OIDC identity and only runs when Release Please creates a release.

Pre-1.0 (`0.x`) state is not a supported migration source. In particular, CEREBEL does not infer or backfill missing LION incarnation provenance: an assignment is either unlinked or stores a complete run-id/incarnation-id pair. Invalid pre-release state fails closed with an operator-facing delete/reset diagnostic.

### Known architectural limitations

- RPC cleanup currently retains the foreground call and exact active ownership until an attached child is confirmed exited. A safe bounded foreground return requires a nonterminal cleanup-pending supervisor; a timeout alone would falsely release ownership. The design contract is tracked in [issue #12](https://github.com/10ego/NERVous-system/issues/12).
- Releases through 1.0.5 throttled and batched live progress but still rewrote the canonical LION ledger for each accepted batch. The issue #13 architecture moves new exact-incarnation progress to bounded sidecars with coherent read overlays and one mandatory terminal fold; legacy/null-incarnation records remain unchanged without migration or backfill.
