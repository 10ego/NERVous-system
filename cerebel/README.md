# @nervous-system/cerebel

> **CEREBEL** — orchestration controller for LION worker waves. It turns ready AXON tasks into LION assignments, tracks dispatch/results, can actively run planned waves through LION with `run_wave`, and decides whether to dispatch more work, wait, complete, replan, or escalate.

CEREBEL primarily controls a **wave** of assignments and persists orchestration state to the active NERVous state namespace so work can resume after compaction/restart. Manual mode remains available (`plan_wave` → `lion run` → `dispatch`/`record`); `run_wave` is an opt-in active dispatcher for already-planned waves.

---

## Install / run

```bash
pi -e ./cerebel/extension/index.ts
pi install ./cerebel
pi install ./cerebel -l
```

Package surfaces:

- `cerebel` tool
- `/cerebel` command — orchestration summary
- `/cerebel:waves` command — recent waves
- `cerebel` skill
- `/cerebel <context>` prompt template

---

## Tool actions

| Action | Purpose |
|--------|---------|
| `plan_wave` | Create a wave from AXON task briefs or direct assignments |
| `dispatch` | Mark assignments dispatched and link LION run ids |
| `record` | Record a LION outcome for one assignment |
| `decide` | Compute next controller decision |
| `complete_wave` | Finish a successful wave |
| `cancel` | Request cancellation for every linked LION, wait for confirmed settlement, then cancel the wave and reconcile terminal GANGLION allocations once per group; unsettled workers retain wave state and capacity |
| `run_wave` | Actively launch planned assignments through LION, dispatch links, and record grouped outcomes |
| `get` | Show one wave/current wave |
| `list` | List waves |
| `summary` | Summarize orchestration state |

Example flow:

```text
axon list ready_only=true

cerebel plan_wave tasks=[
  {id:"task-001",title:"Implement todo API",description:"CRUD endpoints",priority:"high"},
  {id:"task-002",title:"Add API tests",priority:"medium"}
] max_parallel=2 context="Goal: todo API with tests"

lion run task_id="task-001" agent_id="lion-001-001" objective="Implement todo API" context="Goal: todo API with tests"
lion run task_id="task-002" agent_id="lion-001-002" objective="Add API tests" context="Goal: todo API with tests"

cerebel dispatch links=[
  {assignment_id:"assign-001",lion_run_id:"run-001",lion_run_incarnation_id:"<incarnation returned by lion run>"},
  {assignment_id:"assign-002",lion_run_id:"run-002",lion_run_incarnation_id:"<incarnation returned by lion run>"}
]

cerebel record assignment_id="assign-001" lion_run_id="run-001" lion_run_incarnation_id="<exact-incarnation>" outcome="completed" summary="API implemented"
cerebel record assignment_id="assign-002" lion_run_id="run-002" lion_run_incarnation_id="<exact-incarnation>" outcome="blocked" blockers=["test framework missing"]
cerebel decide
```

A manual `record` may target an explicit `assignment_id` or `task_id`. If neither is supplied and `lion_run_id` is the selector, `lion_run_incarnation_id` is mandatory and CEREBEL matches both values; a reused run ID cannot select a replacement incarnation. Explicit assignment/task targeting can establish a new link only with a complete run ID/incarnation pair. Incomplete persisted provenance is not migrated or backfilled and still requires a clean-slate delete/reset.

Or use the bounded active dispatcher after planning a wave:

```text
cerebel run_wave wave_id="current" max_parallel=2 timeout_ms=600000
# optional: runner_mode="rpc" to launch LION workers with RPC live steering support
```

### `run_wave` lifecycle

- Reserves planned assignments under the CEREBEL lock before creating workers.
- Creates exact LION run/incarnation links and executes up to the wave's stored `max_parallel` unless an explicit bounded override is supplied.
- Uses a 600,000 ms per-LION timeout when `timeout_ms` is omitted. Explicit values must be integers from 1 through 2,147,483,647; invalid values return an `invalid_arg` tool error before adapter or LION worker creation and do not fall back to the default.
- Emits the same `nervous:lion:started`, progress, and terminal telemetry as direct LION execution.
- Time-throttles durable progress writes while sending UI progress immediately and forcing the final snapshot before terminalization.
- Joins every admitted batch with all-settled semantics before returning or propagating failure.
- Records completed, partial, blocked, failed, and cancelled outcomes; terminal GANGLION updates are batched once per group.
- Summarizes completed, partial, cancelled, blocked, failed, and still-planned assignment counts separately without changing their settlement semantics.
- An RPC worker whose attached child survives bounded stop returns `cleanup_pending`. Before worker execution begins, CEREBEL freezes the exact LION run/incarnation on any GANGLION allocation; linking failure prevents worker start and cleanup handoff. Before handoff, CEREBEL persists the exact settlement obligation. Its LION remains running, its assignment remains dispatched, and its GANGLION allocation remains reserved. The process-local LION supervisor later performs exact-incarnation finalization, then idempotently records the CEREBEL result and GANGLION release. After registry/process loss, each fresh CEREBEL action reconciles only a proven terminal exact LION incarnation, ignores replacements, and settles the retained allocation at most once.
- Returns grouped results plus a `/nervous:dashboard` hint. Failed batches retain structured partial `wave` and `run_wave.assignment_results` details, and the TUI renders them with the error.

### Abort and failure behavior

- The exact host `AbortSignal` is checked before and after reservation, creation, launch, adapter completion, and progress drain.
- Unlinked reservations are released when abort wins admission; a custom adapter's late success after abort is classified as LION `aborted` / CEREBEL `cancelled`.
- A CEREBEL terminal result is committed only after LION finalization succeeds. Finalization or unlinked cleanup failure surfaces and does not release linked capacity. A `cleanup_pending` result is explicitly nonterminal and skips foreground `finishRun`.
- Host abort does not manufacture a separate durable `lion cancel` request.
- Terminal assignments are not rerun, terminal links cannot be replaced, missing/unparseable `WORKER_REPORT` output fails, and later batches stop after blocked/failed/cancelled outcomes.
- Stale reservations that never received a LION link are recovered. When release or recovery leaves all pending assignments planned, the wave returns to coherent `planned` / `dispatch` state. Active ownership remains registered until LION finalization.

JSON remains the fallback runner. Explicit `runner_mode` wins, followed by `LION_RUNNER`; use `rpc` only when live steering is required.

---

## Decision logic

CEREBEL decision reports are simple and explicit:

- `dispatch` — planned assignments can be launched without exceeding `max_parallel`.
- `wait` — assignments are dispatched/running; collect LION results.
- `complete` — all assignments are `completed` or `partial`.
- `replan` — at least one assignment failed.
- `escalate_to_amygdala` — at least one assignment is blocked.
- `cancelled` — wave cancelled.

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | Active NERVous namespace `cerebel/cerebel.json` (override with `CEREBEL_PATH`) |
| Atomicity | Write to `cerebel.json.tmp` then rename |
| Backup | Previous file copied to `cerebel.json.bak` |
| Concurrency | Advisory lock (`cerebel.json.lock`) with stale-lock detection |
| Corruption | Corrupt file copied aside (`.corrupt-<ts>`) and fresh ledger started |

---

## Architecture

```
cerebel/
├── extension/
│   ├── index.ts        # cerebel tool + /cerebel commands
│   ├── schema.ts       # wave/assignment/decision/tool schemas
│   ├── store.ts        # pure orchestration state machine
│   ├── backend.ts      # durable file backend
│   ├── run-wave.ts     # active run_wave dispatcher helper
│   └── render.ts       # markdown/TUI summaries
├── skills/cerebel/SKILL.md
├── prompts/cerebel.md
└── tests/
```

---

## Relationship to NERVous

- **CORTEX**: intent, plan, verification.
- **AXON**: durable task state.
- **CEREBEL**: orchestration waves and assignment decisions.
- **LION**: actual isolated execution.
- **SYNAPSE**: transient coordination notes.
- **AMYGDALA**: future risk escalation target for blocked waves.

CEREBEL's normal plan/dispatch/record workflow deliberately has no hard runtime imports from AXON/LION/SYNAPSE. LION is declared as an optional peer and loaded through its scoped package path only for `run_wave` or linked cancellation; if unavailable, those actions fail clearly without affecting standalone CEREBEL actions.

CEREBEL provides whole-wave cancellation through `cerebel cancel reason="..."`. Every new CEREBEL→LION link stores both `lion_run_id` and immutable `lion_run_incarnation_id`; cancellation and settlement target that exact execution. CEREBEL waits for every verifiable exact linked LION—including links on assignments already recorded terminal—and for fresh unlinked reservations before terminalizing the wave or releasing capacity. Stale unlinked reservations are recovered before the cancellation gate. Incomplete pre-release links are unsupported and require operator delete/reset. Settlement uses one batched ledger snapshot with adaptive backoff. `CEREBEL_CANCEL_SETTLE_TIMEOUT_MS` defaults to 15,000 ms, accepts positive safe integers through 120,000 ms, and falls back to the default for invalid values. Steering remains per-run and RPC live steering remains explicit opt-in.

---

## Test

```bash
npm test
npx vitest run cerebel
CEREBEL_LIVE=1 npx vitest run cerebel/tests/live.test.ts
```

The live test verifies a real model can call `cerebel plan_wave` and persist an orchestration wave.
