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
| `cancel` | Cancel a wave |
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
  {assignment_id:"assign-001",lion_run_id:"run-001"},
  {assignment_id:"assign-002",lion_run_id:"run-002"}
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

`run_wave` reserves planned assignments under the CEREBEL lock before creating LION workers, creates LION run records, executes LION subprocesses up to the wave's `max_parallel` (or the supplied bounded value), dispatches assignment→run links, records completed/partial/blocked/failed/cancelled outcomes, releases linked GANGLION allocations when possible, and returns a grouped wave summary with a `/nervous:dashboard` hint for live details. A CEREBEL terminal result is committed only after LION finalization succeeds; finalization or unlinked-run cleanup failures surface outward and do not release linked GANGLION capacity. Host `AbortSignal` termination is recorded as LION `aborted` and CEREBEL `cancelled` without claiming a separate durable `lion cancel` request. It skips already-terminal assignments, rejects terminal redispatch, treats missing/unparseable `WORKER_REPORT` output as failed, stops dispatching new batches after blocked/failed/cancelled outcomes, coalesces progress writes, recovers stale reserved assignments that never received a LION run id, and keeps all state in the durable CEREBEL/LION ledgers. Workers launched by `run_wave` are attached to LION's namespace-scoped active-run registry for best-effort active-owner cancellation; ownership is retained until the LION ledger is finalized. Pass `runner_mode="rpc"` when live steering should also be available through LION's RPC path.

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

`run_wave` does **not** orchestrate cancellation or steering across a whole wave. LION owns per-run controls: best-effort active-owner cancellation, queued/pre-start steering, and explicit opt-in RPC live steering. `run_wave` attaches launched workers to that per-run control registry, but callers should still use LION actions directly for individual workers until CEREBEL has a higher-level wave control policy.

---

## Test

```bash
npm test
npx vitest run cerebel
CEREBEL_LIVE=1 npx vitest run cerebel/tests/live.test.ts
```

The live test verifies a real model can call `cerebel plan_wave` and persist an orchestration wave.
