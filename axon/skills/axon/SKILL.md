---
name: axon
description: Read and write the AXON durable task ledger — the persistent source of truth for multi-agent work state. Use it to plan tasks into durable subtasks, find ready work, track status (pending→ready→in_progress→needs_review→completed), record blockers, and resume interrupted work after restart or compaction. Survives across sessions, subprocess agents, and crashes.
disable-model-invocation: true
---

# AXON — Durable Task Ledger

AXON is the **durable work state** of the NERVous System. It is a project-scoped task ledger that survives context compaction, agent interruption, process restart, failed subagent execution, and destructive workflow interruption. **Interrupted work resumes from AXON without needing the original context window.**

AXON is readable/writable by CORTEX, CEREBEL, and LION agents (and by you, via the `axon` tool). Because CEREBEL and LIONs run as separate `pi` subprocesses, AXON is stored on disk in the active global NERVous namespace (`~/.pi/nervous/<project>/<context>/axon/ledger.json` by default; override with `AXON_LEDGER_PATH`), **not** in the chat session.

## When to use AXON

- **Before starting non-trivial work**: persist the plan as tasks so work survives interruption.
- **To find the next work**: list ready tasks.
- **As work progresses**: update status, add progress notes, record artifacts.
- **When blocked or risky**: mark a task `blocked` or `needs_amygdala` instead of stalling silently.
- **After restart/compaction**: read AXON to recover where work left off.

## The `axon` tool

Single tool with an `action`. Common operations:

| Action | Key params | Purpose |
|--------|-----------|---------|
| `summary` | — | Board overview (counts + ready/in_progress/blocked lists) |
| `list` | `ready_only`, `blocked_only`, `status_filter`, `assigned_filter` | Find work |
| `create` | `title`, `description?`, `dependencies?`, `parent_id?`, `priority?`, `assigned_to?` | Add a task |
| `get` | `id` | Full task detail |
| `set_status` | `id`, `status`, `note?` | Move a task through its lifecycle |
| `assign` | `id`, `assigned_to` | Assign to a LION/GANGLION |
| `add_note` | `id`, `note`, `author?` | Concise progress update |
| `add_blocker` / `resolve_blocker` | `id`, `blocker` / `blocker_index` | Track blockers |
| `add_artifact` | `id`, `artifact{path,kind?}` | Record what was produced |
| `set_review` | `id`, `review_status` | not_reviewed/under_review/approved/changes_requested |
| `update` | `id`, + fields | Edit metadata |
| `delete` | `id` | Remove a task (cleans references) |
| `recompute` | — | Re-evaluate dependency-driven readiness |

## Task lifecycle (status state machine)

```
pending ──(deps satisfied)──▶ ready ──▶ in_progress ──▶ needs_review ──▶ completed
                                  │           │ │           │
                                  │           │ ├──▶ blocked
                                  │           │ ├──▶ needs_amygdala
                                  │           │ └──▶ failed / cancelled
                                  └──▶ pending / cancelled / failed
```

- A task is auto-promoted `pending → ready` when all its `dependencies` are `completed`.
- `completed` is terminal. `failed`/`cancelled` can be reopened to `pending`.
- Cycles are rejected (self-deps, dependency cycles, parent-chain cycles).

## Task shape

```
id, title, description, parent_id, dependencies[], assigned_to,
status, priority (low|medium|high|critical),
progress_notes[], artifacts[], blockers[],
review_status (not_reviewed|under_review|approved|changes_requested),
created_at, updated_at
```

## Commands

- `/axon` — board summary.
- `/axon:list [status]` — list tasks (e.g. `/axon:list ready`).
- `/axon:task <id>` — one task's detail.
- `/axon:reset` — wipe the ledger (backs up to `ledger.json.bak`; confirms first).

## Design notes

- **Durability**: writes are atomic (temp file + rename); the previous version is kept as `ledger.json.bak`. Concurrent writers (CEREBEL + LIONs) are serialized by an advisory lock file with stale-lock detection. A corrupt ledger is copied aside (`.corrupt-<ts>`) and AXON starts fresh rather than crashing.
- **Consistency**: every mutating call loads the latest ledger, applies the change, and saves — so AXON always reflects on-disk truth even with multiple processes.
- **AXON ≠ SYNAPSE**: AXON is durable state (the plan + status). SYNAPSE is transient coordination chatter. Don't store ephemeral notes in AXON — use `add_note` only for meaningful progress milestones.
