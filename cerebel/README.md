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
| `cancel` | Request cancellation for every linked LION, wait for confirmed settlement, then cancel the wave and release only still-owned GANGLION allocations; unsettled workers retain wave state and capacity |
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

cerebel record assignment_id="assign-001" lion_run_id="run-001" outcome="completed" summary="API implemented"
cerebel record assignment_id="assign-002" lion_run_id="run-002" outcome="blocked" blockers=["test framework missing"]
cerebel decide
```

Or use the bounded active dispatcher after planning a wave:

```text
cerebel run_wave wave_id="current" max_parallel=2 timeout_ms=600000
# optional: runner_mode="rpc" to launch LION workers with RPC live steering support
```

### `run_wave` lifecycle

- Reserves planned assignments under the CEREBEL lock before creating workers.
- Creates exact LION run/incarnation links and executes up to the wave's stored `max_parallel` unless an explicit bounded override is supplied.
- Emits the same `nervous:lion:started`, progress, and terminal telemetry as direct LION execution.
- Time-throttles durable progress writes while sending UI progress immediately and forcing the final snapshot before terminalization.
- Joins every admitted batch with all-settled semantics before returning or propagating failure.
- Records completed, partial, blocked, failed, and cancelled outcomes; terminal GANGLION updates are batched once per group.
- Returns grouped results plus a `/nervous:dashboard` hint. Failed batches retain structured partial `wave` and `run_wave.assignment_results` details, and the TUI renders them with the error.

### Abort and failure behavior

- The exact host `AbortSignal` is checked before and after reservation, creation, launch, adapter completion, and progress drain.
- Unlinked reservations are released when abort wins admission; a custom adapter's late success after abort is classified as LION `aborted` / CEREBEL `cancelled`.
- A CEREBEL terminal result is committed only after LION finalization succeeds. Finalization or unlinked cleanup failure surfaces and does not release linked capacity.
- Host abort does not manufacture a separate durable `lion cancel` request.
- Terminal assignments are not rerun, terminal links cannot be replaced, missing/unparseable `WORKER_REPORT` output fails, and later batches stop after blocked/failed/cancelled outcomes.
- Stale reservations that never received a LION link are recovered. Active ownership remains registered until LION finalization.

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

CEREBEL's normal plan/dispatch/record workflow deliberately has no hard runtime imports from AXON/LION/SYNAPSE. The `run_wave` action dynamically loads the LION runtime only when invoked; if LION is unavailable, it fails clearly without affecting the rest of CEREBEL.

CEREBEL provides whole-wave cancellation through `cerebel cancel reason="..."`. Every new CEREBEL→LION link stores both `lion_run_id` and immutable `lion_run_incarnation_id`; cancellation and settlement target that exact execution. CEREBEL waits for verifiable linked LIONs before terminalizing the wave or releasing capacity. Legacy links without an incarnation fail closed for operator resolution. Settlement uses one batched ledger snapshot with adaptive backoff. `CEREBEL_CANCEL_SETTLE_TIMEOUT_MS` defaults to 15,000 ms, accepts positive safe integers through 120,000 ms, and falls back to the default for invalid values. Steering remains per-run and RPC live steering remains explicit opt-in.

---

## Test

```bash
npm test
npx vitest run cerebel
CEREBEL_LIVE=1 npx vitest run cerebel/tests/live.test.ts
```

The live test verifies a real model can call `cerebel plan_wave` and persist an orchestration wave.
