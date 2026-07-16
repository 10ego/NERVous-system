# Releases

## 1.0.0 — coordinated stable release

Version 1.0.0 is the first coordinated stable release of the NERVous System workspace. The root `nervous-system` package is the npm distribution installed by users; it bundles the component extensions and depends on the separately published `@nervous-system/state` package. The automated release workflow versions and publishes the root package.

The 1.x compatibility commitment covers documented tool actions, extension entry points, and persisted state written by 1.x releases. Backward-compatible additions may ship in minor releases, fixes in patch releases, and incompatible public or durable-schema changes require a new major version.

## Automated releases

[Release Please](https://github.com/googleapis/release-please) watches conventional commits merged into `main`. It opens or updates a release PR containing the calculated version changes, `CHANGELOG.md`, and release manifest, then enables squash auto-merge for that PR. Required checks must pass before GitHub merges it. Its root Node strategy is the sole version writer: the generated PR normalizes `package.json`, both root `package-lock.json` version fields, and `.release-please-manifest.json`. The generated PR title—and therefore its squash commit—uses `release(main): release <version>`.

The release pipeline derives the version only from Release Please's documented tag output. It verifies the exact tag and `main` ancestry before running source, tests without lifecycle scripts, packages from a separate fresh runner that executes no repository code, and publishes only the verified current-run artifact through an environment-bound npm OIDC identity. Pull-request CI verifies the four version fields, package policy, workflow trust boundaries, immutable Action pins, and Actionlint. No feature PR should manually set a release version.

Semver is selected from the merged commit (normally the squash-merged PR title):

- `feat: ...` creates a minor release.
- `feat!: ...`, `fix!: ...`, or a `BREAKING CHANGE:` footer creates a major release.
- Every other allowed type—`fix:`, `perf:`, `revert:`, `chore:`, `docs:`, `refactor:`, `style:`, and `test:`—creates a patch release.

### Merge policy

All changes to `main` must go through a pull request and use squash merging. The required `Validate PR title` check enforces the conventional title that becomes the squash commit, and the required `Test` check runs the full test suite. Direct pushes, force pushes, branch deletion, and bypassing these requirements as an administrator are disabled.

### Release operations

The complete activation, credential migration, recovery, shutdown, and maintenance procedure is in [`docs/releasing.md`](docs/releasing.md). In summary:

- `NERV_OPS_PRIVATE_KEY` exists only in the main-restricted `release-automation` environment.
- npm trusted publishing names workflow `release-please.yml` and environment `npm-publish` exactly.
- No npm token is stored in GitHub.
- Validation and fresh packaging have no App key, secrets, or OIDC permission.
- Publication has no checkout, dependency installation, repository scripts, or secret; it receives only artifact read and OIDC permissions.
- Both fail-closed repository gates remain absent until every external prerequisite is configured.

Pre-1.0 (`0.x`) state is not a supported migration source. In particular, CEREBEL does not infer or backfill missing LION incarnation provenance: an assignment is either unlinked or stores a complete run-id/incarnation-id pair. Invalid pre-release state fails closed with an operator-facing delete/reset diagnostic.

### Known architectural limitations

- RPC cleanup can return the explicit nonterminal `cleanup_pending` result after an exact process-local supervisor handoff. The durable LION, CEREBEL assignment, and GANGLION capacity remain retained until attached-handle exit observation and exact-incarnation late settlement; supervisor state is intentionally not recovered from persisted PID metadata after restart.
- Releases through 1.0.5 throttled and batched live progress but still rewrote the canonical LION ledger for each accepted batch. The issue #13 architecture moves new exact-incarnation progress to bounded sidecars with coherent read overlays and one mandatory terminal fold; legacy/null-incarnation records remain unchanged without migration or backfill.
