# Releases

## 1.0.0 — coordinated stable release

Version 1.0.0 is the first coordinated stable release of the NERVous System workspace. The root package and every `@nervous-system/*` component are versioned and published as one compatible set; internal workspace dependency pins intentionally use the same version.

The 1.x compatibility commitment covers documented tool actions, extension entry points, and persisted state written by 1.x releases. Backward-compatible additions may ship in minor releases, fixes in patch releases, and incompatible public or durable-schema changes require a new major version.

Pre-1.0 (`0.x`) state is not a supported migration source. In particular, CEREBEL does not infer or backfill missing LION incarnation provenance: an assignment is either unlinked or stores a complete run-id/incarnation-id pair. Invalid pre-release state fails closed with an operator-facing delete/reset diagnostic.
