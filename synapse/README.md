# @nervous-system/synapse

> **SYNAPSE** — the transient shared coordination scratchpad for the [NERVous System](../README.md). Short, coordination-focused notes (work started/completed, blockers, risks, decisions) shared across LION/GANGLION agents. **Bounded by retention so it stays transient, not long-term memory.**

SYNAPSE is the forum where agents coordinate: who started what, what's done, what's blocked, what's risky, and key decisions. CEREBEL reads it to coordinate a GANGLION; LIONs post to it as they work. **AXON holds durable task state; SYNAPSE holds ephemeral coordination chatter.**

Because CEREBEL and LIONs run as separate `pi` subprocesses, SYNAPSE is **project-scoped file state** — shared across all agents — but retention prunes old notes so it never becomes long-term memory.

---

## Install

### Try it without installing

```bash
pi -e ./synapse/extension/index.ts
```

### Install as a pi package

```bash
pi install ./synapse        # user scope
pi install ./synapse -l     # project scope
```

Or add to `settings.json`:

```json
{ "packages": ["./synapse"] }
```

---

## Usage

### The `synapse` tool (single tool, `action` param)

Post coordination notes and read the feed:

```text
synapse post message="Refactoring auth middleware; avoiding session store (lion-3 owns it)" task_id="task-014" agent_id="lion-2" type="started"
synapse post message="API contract differs from AXON plan; requesting AMYGDALA review" task_id="task-021" agent_id="lion-1" type="risk"
synapse list task_filter="task-014"
synapse summary
synapse prune
synapse clear all=true
```

Actions: `post`, `list`, `get`, `summary`, `prune`, `clear`.

**Note types:** `started`, `completed`, `blocker`, `risk`, `decision`, `info`.

### Commands

- **`/synapse`** — feed summary.
- **`/synapse:task <task-id|general>`** — notes for one task.
- **`/synapse:clear`** — wipe the scratchpad (backs up first; confirms).

### Skill

The `synapse` skill is auto-discovered; force-load it with `/skill:synapse`.

---

## Note model

```json
{
  "id": "note-001",
  "task_id": "task-001",   // or null for the general channel
  "agent_id": "lion-1",     // or null for system/anonymous
  "type": "started",        // started|completed|blocker|risk|decision|info
  "message": "Short coordination note.",
  "created_at": ""
}
```

Messages are capped at 1000 chars to keep notes concise.

---

## Retention (why it's transient)

SYNAPSE is deliberately **not** append-forever. On every save:

- Notes older than the TTL are pruned (default **24h**).
- Total notes are capped (default **1000**); oldest dropped beyond the cap.

Override per project via env vars:

```
SYNAPSE_TTL_MS=3600000      # 1h
SYNAPSE_MAX_NOTES=500
```

If a fact must persist, it belongs in **AXON** (progress notes / artifacts), not SYNAPSE.

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `<cwd>/.pi/synapse/synapse.json` (override with `SYNAPSE_PATH`) |
| Atomicity | Write to `synapse.json.tmp` then `fs.rename` — a crash never leaves a half-written file |
| Backup | Each save copies the previous file to `synapse.json.bak` |
| Concurrency | Advisory lock file (`synapse.json.lock`, O_EXCL) with stale-lock detection; serializes CEREBEL + LION writers across processes |
| Corruption | A corrupt file is copied aside (`.corrupt-<ts>`) and SYNAPSE starts fresh rather than crashing |
| Retention | TTL + max-notes pruning applied on every save (and via the `prune` action) |

The durability strategy mirrors AXON (reliable within a working session); retention is what makes SYNAPSE *transient* by contrast.

---

## Architecture

```
synapse/
├── extension/
│   ├── index.ts        # entry: synapse tool + /synapse* commands
│   ├── schema.ts       # Note model, types (NoteType), TypeBox schemas, SynapseError
│   ├── store.ts        # NoteLog: pure in-memory logic + retention  (no I/O)
│   ├── backend.ts      # FileBackend (atomic/lock/recover) + SynapseStore (load→mutate→prune→save)
│   └── render.ts       # TUI rendering + markdown feed/board summaries
├── skills/synapse/SKILL.md
└── tests/              # store, backend (durability+retention+concurrency), smoke, live
```

**Design:** the pure `NoteLog` (posting, filtering, retention) is separated from the `FileBackend` (durability + locking + recovery) and the `SynapseStore` wrapper (load→mutate→prune→save). Retention runs inside every `mutate` save so the feed can never grow unbounded, even under concurrent writers.

---

## Develop & test

```bash
npm install
npm test                                       # unit + smoke (no LLM calls)
npx vitest run synapse/tests/backend.test.ts   # durability + retention + concurrency
SYNAPSE_LIVE=1 npx vitest run synapse/tests/live.test.ts   # real end-to-end
```

The suite covers: posting + id generation, filtering/sorting (with stable tie-breaking), summary, TTL + max-notes retention, filtered clear, serialization round-trip + coercion, persistence round-trip, atomic writes, retention-on-save, corrupt-file recovery, real 3-process concurrency, and extension factory smoke.

---

## Relation to NERVous

- **LIONs** post `started`/`completed`/`blocker`/`risk`/`decision` notes as they work.
- **CEREBEL** reads SYNAPSE to coordinate a GANGLION and detect conflicts.
- **AMYGDALA** is triggered by `risk`/`blocker` notes (via CEREBEL or directly).
- **SYNAPSE ≠ AXON**: AXON = durable plan + status (source of truth). SYNAPSE = transient signals (coordination). Always reference AXON task ids; don't duplicate durable state here.

Build priority: SYNAPSE is #2 (after AXON) because CEREBEL and LIONs need a shared coordination channel before orchestration works.
