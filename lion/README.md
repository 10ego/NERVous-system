# @nervous-system/lion

> **LION** — Local Intelligence Operations Node. A LION is one isolated pi coding subagent: one subprocess, one concrete assignment, one durable worker report.

LION is the worker abstraction that lets CEREBEL/GANGLION delegate actual coding work without stuffing the main context window. It persists every run in the active NERVous state namespace (`lion/runs.json`, override with `LION_RUNS_PATH`) so orchestrators can inspect outcomes later.

---

## Install / run

```bash
pi -e ./lion/extension/index.ts
pi install ./lion        # user scope
pi install ./lion -l     # project scope
```

Package surfaces:

- `lion` tool
- `/lion` command — run summary
- `/lion:runs` command — recent runs
- `lion` skill
- `/lion <objective>` prompt template

---

## Tool actions

Single tool, `action` discriminator:

| Action | Purpose |
|--------|---------|
| `run` | Spawn one isolated pi worker and persist its report; with `dry_run=true`, create a queued run. `runner_mode="json"` is the default; `runner_mode="rpc"` enables live steering. |
| `start` | Launch a queued dry-run, applying any queued pre-start steering messages |
| `cancel` | Best-effort cancellation for queued/running runs with durable control metadata |
| `steer` | Queue a pre-start steering message for a queued run; for running runs, deliver live steering only when `runner_mode="rpc"` has a live RPC worker |
| `get` | Show one run |
| `list` | List runs, optionally filtered by status/agent/task |
| `summary` | Summary counts + recent/running runs |
| `delete` | Delete a terminal run record; queued/running records cannot be deleted while ownership or callbacks may still be active |

Example:

```text
lion run \
  task_id="task-003" \
  agent_id="lion-api-tests" \
  objective="Add tests for the todo API endpoints." \
  context="Success: create/update/delete/list are covered; run npm test; avoid unrelated refactors."
```

The worker receives a LION system prompt and must finish with a parseable `WORKER_REPORT` JSON block.

### Live progress telemetry

While a run is active, LION records a bounded `progress` snapshot in exact-incarnation durable storage, overlays it on canonical reads, and emits best-effort lifecycle events when `pi.events` is available:

- `nervous:lion:started`
- `nervous:lion:progress`
- `nervous:lion:completed`
- `nervous:lion:blocked`
- `nervous:lion:failed`

Progress is derived defensively from headless `pi --mode json`/RPC events such as tool start/end, text deltas, message end, and turn end. It is optional and backward-compatible: old ledgers without `progress` still load and malformed/missing subprocess events are ignored. Raw assistant text tails are redacted by default (`last_text=null`, generic responding activity); pass `include_progress_text=true` only when retaining partial assistant text is acceptable. Event payloads also redact the raw objective by default (`objective_redacted=true`); set `LION_EVENT_INCLUDE_OBJECTIVE=true` only for trusted local diagnostics.

For newly started runs with non-null incarnations, durable progress uses one bounded latest-snapshot sidecar per exact canonical namespace/run/incarnation. Per-worker updates remain latest-wins and coalesced; every flush shares the canonical namespace lock but reads, parses, backs up, serializes, and writes only the sidecar—not `runs.json`. UI/events remain immediate, and the mandatory final drain completes before one terminal fold into the canonical record. Legacy/null-incarnation runs retain readable inline progress without migration or backfill. Active tool telemetry is bounded to 32 unique names of 128 characters each.

### Cancellation and steering

LION stores best-effort process control metadata for running subprocesses (`pid`, process group where available, cancellation timestamps, and reconciliation timestamps). Use:

```text
lion cancel id="run-001" reason="superseded by newer plan"
```

Cancellation is honest but best-effort: it records the request durably, uses only the cancel action's explicit `reason` (never the worker `context`) as its recorded explanation, and only the current live LION owner capability in the matching canonical ledger namespace may deliver cancellation to its attached worker. Every new run has an immutable `incarnation_id`; delayed cancellation results are written only when that incarnation still owns the reusable run id. Explicit legacy `null` incarnations compare exactly and never wildcard-match a replacement execution. Ownership admission happens before a running record is persisted, queued/running records cannot be deleted, and owner-bound SIGKILL escalation is armed immediately after confirmed SIGTERM delivery—before ledger persistence—on both direct and attachment-replay paths. A replacement owner with a reused id is never targeted. `delivered` is persisted only when the owned JSON signal or RPC control primitive confirms it acted, while terminal settlement still requires observed process exit. Persisted PID/PGID values are observational metadata and are not used as authority to signal after restart or stale ledger recovery. New process metadata also records an observational process-birth identity on Linux: a stale ownerless record can reconcile when the same numeric PID is proven to belong to a different process, while platforms without nonblocking birth identity and unverifiable live PIDs remain fail-closed. If cancellation is recorded while an owner is starting but before its process handle attaches, attachment replays and escalates the durable request once per live owner. Queued runs are aborted without launching and their queued steering is closed; stale ownerless records reconcile after grace only when loss is observable, without signaling persisted metadata.

Pre-start steering works for all runner modes:

```text
lion run objective="..." dry_run=true
lion steer id="run-001" message="Prefer the test-first path."
lion start id="run-001"
```

Queued messages are injected into the worker prompt when `start` launches the run.

True live mid-run steering is available through pi's RPC mode, but remains explicit opt-in so the existing JSON subprocess runner stays backward-compatible:

```text
lion run \
  runner_mode="rpc" \
  objective="Long task where I may need to steer mid-run."

lion steer id="run-001" message="Narrow the change to tests only."
```

RPC live steering uses pi's official `RpcClient.steer()` control channel. Steering text is bounded to 4,000 characters; at most 100 open messages are accepted and all remain through prompt construction, while terminal history is compacted to the latest 100 entries. Persisted steering is bounded before message payload coercion as well: deserialization retains at most the first 100 open messages and latest 100 terminal entries, truncating every retained message to 4,000 characters. Running steering is recorded as `pending_delivery`; query, reservation, acknowledgement, failure, and final closure writes all compare the immutable run incarnation so an abandoned callback cannot mutate a reused run/message id. The active RPC runner uses non-overlapping adaptive polling, rechecks the channel after every ledger await and immediately before `RpcClient.steer()`, then persists each reserved batch as `delivered` or `delivery_failed` in one exact-incarnation mutation. The live-steering gate closes as soon as the worker becomes idle or the RPC child exits; messages not already in flight are failed rather than reported as delivered after the final response. A pre-aborted run is rejected before setup. One session deadline and abort supervisor cover prompt-file persistence, client creation, start, prompt, steering, idle, final steering persistence, and final assistant-text retrieval. A disposable `agent_end` waiter is installed before prompting, so immediate completion cannot be missed and early failure removes its listener immediately. A child exposed while `start()` is still pending is adopted before cancellation cleanup; failed stop cannot report process exit while that child remains alive. Partial and final temporary directories are removed recursively. RPC errors persisted to run or steering state are capped at 2,000 characters and redact bundled child stderr. Cancellation attempts a bounded graceful abort before always attempting child stop. The runner does not settle, report process exit, terminalize its ledger, or release active ownership while the child still appears alive after stop failure; RPC steering control may be closed while cancellation authority remains until actual exit. Running steering on the default `json` runner is still rejected as `rejected_running` because `pi --mode json -p --no-session` has no live bidirectional control channel.

If bounded stop cleanup leaves the attached child alive, the RPC runner returns the explicit nonterminal `cleanup_pending` outcome only after durably persisting an exact cleanup-pending observation with PID/process identity and atomically registering a process-local supervisor with the exact namespace/run/incarnation/owner capability, attached child observation, temporary resources, and terminal intent. Either persistence or registration failure preserves the foreground wait. A successful handoff keeps the durable run running and retains cancellation ownership; it does not call foreground finalizers or report exit. Child `error` events are not exit evidence. After confirmed exit, the supervisor retries resource cleanup and exact-incarnation finalization, re-reads late durable cancellation before accepting success, emits terminal telemetry once, and then releases ownership. A replacement incarnation is never mutated or signaled. The supervisor registry remains process-local: after process loss, persisted PID/PGID metadata never grants reattachment or signaling authority.

Set `LION_RUNNER=rpc` to make RPC the default for local/manual testing, or pass `runner_mode="rpc"` per run. Restart reattachment is deliberately unsupported: if the parent LION process exits, a persisted running record may have process metadata but no attached RPC bridge, so new steering may be rejected or pending messages may fail during reconciliation.

### Model selection

`lion run model="provider/model"` remains the highest-precedence per-run override. When `model` is omitted, LION reads the shared NERVous model config (`~/.pi/agent/nervous.json`, overlaid by trusted `<repo>/.pi/nervous.json`) and selects by `model_role`:

- `model_role="implementation"` (default) → `models.lion.implementationDefault`, then `models.lion.default`.
- `model_role="review"` → `models.lion.reviewDefault`, then `models.lion.default`.
- `model_role="default"` → `models.lion.default` only.

If the selected keys are unset, LION preserves the previous behavior and passes no `--model`, letting pi use its current/default model.

Set or clear defaults through CORTEX's config command:

```text
/nervous:config lion_implementation_model=provider/fast lion_review_model=provider/strong
/nervous:config lion_review_model=unset
```

---

## Worker contract

Every LION subprocess is instructed to return:

```json
{
  "WORKER_REPORT": {
    "outcome": "completed",
    "summary": "what changed",
    "changed_files": ["path"],
    "tests_run": ["command"],
    "blockers": [],
    "next_steps": [],
    "notes": "optional"
  }
}
```

Supported outcomes: `completed`, `blocked`, `failed`, `partial`.

Run statuses in the ledger: `queued`, `running`, `completed`, `blocked`, `failed`, `aborted`.

### Terminal diagnostics and recovery

A `completed` LION run now requires a strict, final fenced `WORKER_REPORT` JSON object with all required bounded fields. A clean worker exit without that valid wrapper is **not** success: it finalizes as `failed`, returns a tool error, and records an additive `terminal_diagnostic` on the durable run. Existing ledger records without that field remain readable unchanged.

For report-less JSON runs, `terminal_diagnostic.reason` is one of:

- `spawn_failure` — worker setup or process launch failed.
- `timeout` — the host timeout/abort stopped an active worker.
- `protocol_parse_failure` — a collected final assistant candidate did not satisfy the `WORKER_REPORT` contract.
- `model_exit` — the child exited abnormally (nonzero exit or signal) before a trustworthy result.
- `result_collection_failure` — the child closed cleanly without a final candidate or the final result could not be collected.

Diagnostics expose capped, sanitized/redacted stdout, stderr, and final-output tails along with event/turn/tool counters and exit metadata. They are intentionally bounded; LION does not retain an unrestricted worker transcript. For a timeout after observed activity, `partial_evidence` additionally records observational (not ownership-proof) repository-relative changed paths, allowlisted test commands, the last tool action, and a no-shell, short-deadline Git `HEAD`/porcelain snapshot when available. These fields help a parent recover or review partial work while still treating the run as failed/aborted.

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | Active NERVous namespace `lion/runs.json` (override with `LION_RUNS_PATH`); direct file symlinks—including missing targets—resolve once to one canonical operational target used for data, lock, temp, backup, and active-owner identity |
| Progress | New exact incarnations use hashed files under `runs.json.progress/`; each mode-0600 envelope stores the full namespace/run/incarnation identity, open/closed write fence, monotonic sequence, and at most one bounded snapshot |
| Authority | `runs.json` alone controls existence, identity, lifecycle, and terminal truth. Reads overlay the highest-sequence valid exact primary/backup only for a canonical active run |
| Control | Optional process metadata/cancellation state, runner mode, pre-start steering, and RPC live steering delivery records are persisted with the run |
| Atomicity | Canonical and sidecar files use fsynced mode-0600 temp files, atomic rename, and directory fsync under one canonical lock |
| Backup | `runs.json.bak` retains the previous canonical file; each exact progress sidecar retains one bounded `.bak` envelope |
| Concurrency | Advisory lock (`runs.json.lock`) with stale-lock detection serializes lifecycle, progress, terminal folds, and exact cleanup |
| Corruption | Canonical corruption follows canonical recovery. Sidecar corruption is isolated, warned/quarantined within bounds, and can never reset or replace canonical provenance |

### Terminal fold and crash recovery

Terminal operations use the `LionStore` fold protocol: close the exact envelope under the namespace lock, reload and exact-check the canonical active run, fold the newest valid snapshot, durably commit terminal `runs.json`, then remove exact primary/backup artifacts. A crash before canonical commit leaves a closed snapshot that is visible on the still-active canonical run and retryable; late writers cannot reopen it. A crash after canonical commit leaves terminal canonical truth, which ignores any cleanup orphan. Classification cleanup removes only proven terminal, missing/replaced, or malformed artifacts. It never age-evicts an exact active or unclassifiable entry.

Sidecar paths contain only a SHA-256 identity hash; envelopes retain the full versioned identity. Sidecar roots and artifacts reject symlink traversal. The dashboard fingerprints the sidecar directory and reloads LION through `LionStore`, so direct LION, CEREBEL, and dashboard readers observe the same overlay.

---

## Architecture

```
lion/
├── extension/
│   ├── index.ts        # lion tool + /lion commands
│   ├── schema.ts       # run/report/tool schemas
│   ├── store.ts        # pure run ledger lifecycle
│   ├── backend.ts      # canonical authority + terminal transaction API
│   ├── progress-sidecar.ts # exact-incarnation latest-snapshot persistence
│   ├── subprocess.ts   # headless pi runner + WORKER_REPORT parsing
│   └── render.ts       # markdown/TUI rendering
├── skills/lion/SKILL.md
├── prompts/lion.md
└── tests/
```

---

## Relationship to NERVous

- **CORTEX** decides intent, success criteria, plan, verification.
- **AXON** stores durable task state.
- **LION** executes one concrete task in an isolated subprocess.
- **SYNAPSE** is the transient coordination channel a worker may use.
- **CEREBEL** will orchestrate many LIONs into a GANGLION.

LION deliberately does not require AXON/SYNAPSE at runtime. If those tools are available in the subprocess, the LION prompt instructs the worker to update them; otherwise the durable LION run report still captures the outcome.

---

## Test

```bash
npm test
npx vitest run lion
npm run benchmark:lion-progress
LION_LIVE=1 npx vitest run lion/tests/live.test.ts
```

The live test spawns a real pi subprocess and verifies the parsed worker report.
