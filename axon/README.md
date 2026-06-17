# @nervous-system/axon

> **AXON** — the durable task ledger for the [NERVous System](../README.md). The persistent source of truth for multi-agent work state: it survives context compaction, agent interruption, process restart, failed subagent execution, and destructive workflow interruption. **Interrupted work resumes from AXON without needing the original context window.**

AXON is readable and writable by CORTEX, CEREBEL, and LION agents. Because CEREBEL and LIONs run as separate `pi` subprocesses (with `--no-session`), AXON is **project-scoped file state** — not session state.

---

## Install

### Try it without installing

```bash
pi -e ./axon/extension/index.ts
```

### Install as a pi package

```bash
pi install ./axon          # user scope
pi install ./axon -l       # project scope
```

Or add to `settings.json`:

```json
{ "packages": ["./axon"] }
```

---

## Usage

### The `axon` tool (single tool, `action` param)

```text
axon summary
axon list ready_only=true
axon create title="Scaffold project" priority=high
axon create title="Write tests" dependencies=["task-002","task-003"]
axon set_status id="task-001" status="in_progress" note="starting"
axon add_note id="task-001" note="endpoints done" author="lion-1"
axon set_status id="task-001" status="completed"
axon get id="task-002"
axon recompute
```

Actions: `create`, `get`, `list`, `update`, `set_status`, `add_note`, `add_blocker`, `resolve_blocker`, `add_artifact`, `set_review`, `assign`, `delete`, `recompute`, `summary`.

### Commands

- **`/axon`** — board summary.
- **`/axon:list [status]`** — list tasks (e.g. `/axon:list ready`).
- **`/axon:task <id>`** — one task's detail.
- **`/axon:reset`** — wipe the ledger (backs up to `ledger.json.bak`; confirms first).

### Skill

The `axon` skill is auto-discovered; force-load it with `/skill:axon`.

---

## Task model

```json
{
  "id": "task-001",
  "title": "Implement AXON task store",
  "description": "Create persistent task ledger with CRUD operations.",
  "parent_id": null,
  "dependencies": [],
  "assigned_to": null,
  "status": "pending",
  "priority": "medium",
  "progress_notes": [],
  "artifacts": [],
  "blockers": [],
  "review_status": "not_reviewed",
  "created_at": "",
  "updated_at": ""
}
```

**Statuses:** `pending`, `ready`, `in_progress`, `blocked`, `needs_amygdala`, `needs_review`, `completed`, `failed`, `cancelled`.

**Status state machine:**

```
pending ─(deps satisfied)─▶ ready ─▶ in_progress ─▶ needs_review ─▶ completed
                                │         │ │          │
                                │         │ ├──▶ blocked
                                │         │ ├──▶ needs_amygdala
                                │         │ └──▶ failed / cancelled
                                └──▶ pending / cancelled / failed
```

- A task is auto-promoted `pending → ready` when all `dependencies` are `completed`.
- `completed` is terminal. `failed`/`cancelled` can be reopened to `pending`.
- Cycles are rejected (self-deps, dependency cycles, parent-chain cycles).

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `<cwd>/.pi/axon/ledger.json` (override with `AXON_LEDGER_PATH`) |
| Atomicity | Write to `ledger.json.tmp` then `fs.rename` — a crash never leaves a half-written ledger |
| Backup | Each successful save copies the previous file to `ledger.json.bak` |
| Concurrency | Advisory lock file (`ledger.json.lock`, O_EXCL) with stale-lock detection (dead PID / age > 30s); serializes CEREBEL + LION writers across processes |
| Corruption | A corrupt ledger is copied aside as `.corrupt-<ts>` and AXON starts fresh rather than crashing |
| Consistency | Every mutation loads the latest ledger, applies the change, and saves — so AXON always reflects on-disk truth |

### Why not session entries?

`pi.appendEntry()` persists to the *session*, but AXON must survive "without needing the original context window" and be shared with separate subprocess agents (`--no-session`). File state is the only option that satisfies this. (Session entries remain useful for SYNAPSE-style transient state later.)

---

## Architecture

```
axon/
├── extension/
│   ├── index.ts        # entry: axon tool + /axon* commands
│   ├── schema.ts       # Task model, enums, TypeBox schemas, AxonError
│   ├── task_status.ts  # status state machine (TRANSITIONS, canTransition)
│   ├── store.ts        # Ledger: pure in-memory logic + validation  (no I/O)
│   ├── backend.ts      # FileBackend (atomic/lock/recover) + AxonStore (load→mutate→save)
│   └── render.ts       # TUI rendering + markdown summaries
├── config/demo.ledger.json   # sample board for the "todo API" demo
├── skills/axon/SKILL.md
└── tests/              # status, store, backend, extension smoke, concurrency
```

**Design:** the pure `Ledger` (logic + validation, zero I/O) is separated from the `FileBackend` (durability + locking + recovery) and the `AxonStore` wrapper (load→mutate→save). This makes all ledger semantics unit-testable without touching the filesystem, while the backend is tested separately with temp dirs and real concurrent processes.

---

## Develop & test

```bash
npm install
npm test                                  # unit + smoke tests (no LLM calls)
npx vitest run axon/tests/backend.test.ts # durability + locking + recovery
```

The suite covers: status state machine, CRUD, dependency-driven readiness, cycle prevention, append-only notes/blockers/artifacts, referential cleanup on delete, persistence round-trip, atomic write, concurrent-write locking (real cross-process), and corrupt-file recovery.

---

## Relation to NERVous

AXON is the spine the rest of the system hangs on:

- **CORTEX** converts an execution plan / MAGI recommendation into AXON tasks (`create`).
- **CEREBEL** reads AXON for `ready` tasks (`list ready_only`) and assigns them to LIONs (`assign`).
- **LIONs** update status as they work (`set_status`, `add_note`, `add_artifact`) and flag risk (`needs_amygdala`) or blockers (`blocked`).
- **CORTEX** checks completion via AXON before final review.

Build priority: AXON is #1 because every other component depends on durable, resumable state.
