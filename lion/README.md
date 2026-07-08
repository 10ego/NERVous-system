# @nervous-system/lion

> **LION** — Local Intelligence Operations Node. A LION is one isolated pi coding subagent: one subprocess, one concrete assignment, one durable worker report.

LION is the worker abstraction that lets CEREBEL/GANGLION delegate actual coding work without stuffing the main context window. It persists every run to `<cwd>/.pi/lion/runs.json` so orchestrators can inspect outcomes later.

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
| `run` | Spawn one isolated pi subprocess worker and persist its report |
| `get` | Show one run |
| `list` | List runs, optionally filtered by status/agent/task |
| `summary` | Summary counts + recent/running runs |
| `delete` | Delete a run record |

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

While a run is active, LION now records a bounded `progress` snapshot in the run ledger and emits best-effort lifecycle events when `pi.events` is available:

- `nervous:lion:started`
- `nervous:lion:progress`
- `nervous:lion:completed`
- `nervous:lion:blocked`
- `nervous:lion:failed`

Progress is derived defensively from headless `pi --mode json` events such as tool start/end, text deltas, message end, and turn end. It is optional and backward-compatible: old ledgers without `progress` still load, malformed/missing subprocess events are ignored, and retained text is bounded so progress does not become an unbounded transcript.

This PR intentionally does **not** add FleetView/widget UI, CEREBEL auto-dispatch/grouped notifications, steering, or subprocess cancellation. Those can consume the durable/evented progress contract in follow-up work.

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

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | Active NERVous namespace `lion/runs.json` (override with `LION_RUNS_PATH`) |
| Progress | Optional bounded `progress` snapshot is persisted while running and shown in summaries when present |
| Atomicity | Write to `runs.json.tmp` then rename |
| Backup | Previous file copied to `runs.json.bak` |
| Concurrency | Advisory lock (`runs.json.lock`) with stale-lock detection |
| Corruption | Corrupt file copied aside (`.corrupt-<ts>`) and fresh ledger started |

---

## Architecture

```
lion/
├── extension/
│   ├── index.ts        # lion tool + /lion commands
│   ├── schema.ts       # run/report/tool schemas
│   ├── store.ts        # pure run ledger lifecycle
│   ├── backend.ts      # durable file backend
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
LION_LIVE=1 npx vitest run lion/tests/live.test.ts
```

The live test spawns a real pi subprocess and verifies the parsed worker report.
