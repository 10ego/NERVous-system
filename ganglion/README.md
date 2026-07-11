# @nervous-system/ganglion

> **GANGLION** — working-group roster and capability allocator for LION agents. It manages LION slots, capabilities, availability, and task allocations. It does **not** execute work.

GANGLION answers: **which LION should take which ready task?** CEREBEL then orchestrates waves and LION executes subprocess work.

Durable state: `<cwd>/.pi/ganglion/ganglion.json`.

---

## Install / run

```bash
pi -e ./ganglion/extension/index.ts
pi install ./ganglion
pi install ./ganglion -l
```

Package surfaces:

- `ganglion` tool
- `/ganglion` command — summary
- `/ganglion:groups` command — group list
- `ganglion` skill
- `/ganglion <context>` prompt template

---

## Tool actions

| Action | Purpose |
|--------|---------|
| `create` | Create a working group with generic or explicit LION members |
| `add_member` | Add a LION slot |
| `update_member` | Update role/capabilities/model/tools/status |
| `remove_member` | Remove an idle member |
| `set_status` | forming/active/paused/draining/completed/cancelled |
| `allocate` | Allocate ready task briefs to available members by capability/capacity |
| `record` | Record an allocation result and return `released`, `already_free`, `member_unavailable`, `retained_by_newer_allocation`, or `not_terminal`; stale historical records cannot clear or claim release of a newer lease |
| `release` | Release a member/allocation manually |
| `get` | Show one/current group |
| `list` | List groups |
| `summary` | Summary counts |
| `delete` | Delete a group |

Example:

```text
ganglion create name="demo" max_parallel=2 members=[
  {id:"lion-api", role:"api", capabilities:["api","node"]},
  {id:"lion-tests", role:"tests", capabilities:["test"]},
  {id:"lion-docs", role:"docs", capabilities:["docs"]}
]

ganglion allocate tasks=[
  {id:"task-001", title:"Implement todo API", priority:"critical", required_capabilities:["api"]},
  {id:"task-002", title:"Add tests", priority:"high", required_capabilities:["test"]}
] context="Goal: todo API with tests"
```

The returned allocations can be passed to CEREBEL/LION:

- allocation `member_id` → LION `agent_id`
- allocation `objective`/`context` → LION objective/context
- allocation `task_id` → AXON/LION task id

When CEREBEL hands off an RPC `cleanup_pending` worker, GANGLION stores the immutable LION run and incarnation on the allocation before foreground authority is released. Late and restart reconciliation use that exact provenance; legacy run-only allocations are not backfilled by inference, replacement incarnations are ignored, and repeated exact terminal settlement does not release capacity twice.

---

## Allocation logic

GANGLION allocates by:

1. task priority (`critical > high > medium > low`),
2. member availability,
3. `max_parallel` remaining capacity,
4. capability match (`required_capabilities` vs member capabilities),
5. stable member id tie-break.

If a task declares required capabilities and no available member matches, the task is skipped rather than assigned badly.

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `<cwd>/.pi/ganglion/ganglion.json` (override with `GANGLION_PATH`) |
| Atomicity | Write to `ganglion.json.tmp` then rename |
| Backup | Previous file copied to `ganglion.json.bak` |
| Concurrency | Advisory lock (`ganglion.json.lock`) with stale-lock detection |
| Corruption | Corrupt file copied aside (`.corrupt-<ts>`) and fresh ledger started |

---

## Architecture

```
ganglion/
├── extension/
│   ├── index.ts        # ganglion tool + /ganglion commands
│   ├── schema.ts       # group/member/allocation/tool schemas
│   ├── store.ts        # pure roster + allocation state machine
│   ├── backend.ts      # durable file backend
│   └── render.ts       # markdown/TUI summaries
├── skills/ganglion/SKILL.md
├── prompts/ganglion.md
└── tests/
```

---

## Relationship to NERVous

- **AXON**: durable tasks.
- **GANGLION**: which LION slot should take which task.
- **CEREBEL**: orchestration wave control.
- **LION**: isolated task execution.
- **SYNAPSE**: transient coordination.
- **CORTEX**: intent/planning/verification.

GANGLION has no hard runtime dependency on AXON/CEREBEL/LION. The agent bridges tools so each package remains independently installable.

---

## Test

```bash
npm test
npx vitest run ganglion
GANGLION_LIVE=1 npx vitest run ganglion/tests/live.test.ts
```

The live test defaults to the configured cheaper GPT-family setup:

```bash
--provider openai-codex --model gpt-5.5 --thinking low
```

Override with `GANGLION_LIVE_PROVIDER`, `GANGLION_LIVE_MODEL`, or `GANGLION_LIVE_THINKING`.
