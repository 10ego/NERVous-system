# Releases

## 1.0.0 — coordinated stable release

Version 1.0.0 is the first coordinated stable release of the NERVous System workspace. The private root package is distributed through the Git repository/workspace and is not published to the npm registry. Publishable `@nervous-system/*` component packages are version-aligned as one compatible set, and internal workspace dependency pins intentionally use the same version.

The 1.x compatibility commitment covers documented tool actions, extension entry points, and persisted state written by 1.x releases. Backward-compatible additions may ship in minor releases, fixes in patch releases, and incompatible public or durable-schema changes require a new major version.

Pre-1.0 (`0.x`) state is not a supported migration source. In particular, CEREBEL does not infer or backfill missing LION incarnation provenance: an assignment is either unlinked or stores a complete run-id/incarnation-id pair. Invalid pre-release state fails closed with an operator-facing delete/reset diagnostic.

### Known architectural limitations

- RPC cleanup currently retains the foreground call and exact active ownership until an attached child is confirmed exited. A safe bounded foreground return requires a nonterminal cleanup-pending supervisor; a timeout alone would falsely release ownership. The design contract is tracked in [issue #12](https://github.com/10ego/NERVous-system/issues/12).
- Live progress updates are throttled and batched, but each accepted batch still rewrites the canonical LION ledger. Moving high-frequency progress to an exact-incarnation sidecar/journal requires coordinated read, recovery, backup, and final-fold semantics tracked in [issue #13](https://github.com/10ego/NERVous-system/issues/13).
