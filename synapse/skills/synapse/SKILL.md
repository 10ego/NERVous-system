---
name: synapse
description: Post and read the SYNAPSE transient coordination scratchpad — short, coordination-focused notes (work started/completed, blockers, risks, decisions) shared across LION/GANGLION agents in the NERVous System. Use it to announce what you're doing, surface conflicts early, and stay coordinated. Bounded by retention so it stays transient, not long-term memory.
---

# SYNAPSE — Transient Coordination Scratchpad

SYNAPSE is the **transient shared scratchpad** of the NERVous System. It is the forum where LIONs and CEREBEL coordinate: who started what, what's done, what's blocked, what's risky, and key decisions. It is **not long-term memory** — retention (TTL + max-notes) prunes old notes so it stays transient. **AXON holds durable task state; SYNAPSE holds ephemeral coordination chatter.**

Because CEREBEL and LIONs run as separate `pi` subprocesses, SYNAPSE is stored on disk at `<project>/.pi/synapse/synapse.json` (override with `SYNAPSE_PATH`), shared across all agents.

## When to use SYNAPSE

- **Before starting work**: read the feed to see what other agents are doing and avoid conflicts.
- **When you start something**: post a `started` note so others don't duplicate it.
- **When you finish something**: post a `completed` note.
- **When you hit a blocker or risk**: post a `blocker` / `risk` note *immediately* so others (and CEREBEL/AMYGDALA) react.
- **When you make a coordination-relevant decision**: post a `decision` note.

## The `synapse` tool

Single tool with an `action`:

| Action | Key params | Purpose |
|--------|-----------|---------|
| `post` | `message`, `task_id?`, `agent_id?`, `type?` | Add a coordination note |
| `list` | `task_filter?`, `agent_filter?`, `type_filter?`, `limit?` | Read notes (newest first) |
| `get` | `id` | One note |
| `summary` | `limit?` | Counts + recent notes + retention info |
| `prune` | — | Force retention pruning |
| `clear` | `all?`, `task_filter?`, … | Remove notes |

**Note types:** `started`, `completed`, `blocker`, `risk`, `decision`, `info`.

## Convention for messages

Keep notes **short and coordination-focused**. A good note answers *who / what / why-now*. The conventional compact form is:

```
[task-014][lion-2][started] Refactoring auth middleware. Will avoid touching session store because lion-3 is working there.
[task-021][lion-1][risk] API contract differs from AXON plan. Requesting AMYGDALA review before changing schema.
```

`task_id` is optional (omit for the general channel). `agent_id` is your LION id. Don't put implementation detail, full logs, or durable state here — use AXON for that.

## Retention (why it's transient)

- Notes older than the TTL (default **24h**) are pruned on every save.
- Total notes are capped (default **1000**); oldest dropped beyond the cap.
- Override per project via `SYNAPSE_TTL_MS` / `SYNAPSE_MAX_NOTES` env vars.

If you need a fact to persist, it belongs in **AXON** (progress notes / artifacts), not SYNAPSE.

## Commands

- `/synapse` — feed summary.
- `/synapse:task <task-id|general>` — notes for one task.
- `/synapse:clear` — wipe the scratchpad (backs up first; confirms).

## Design notes

- **Durability + transience together**: atomic writes (temp+rename), cross-process lock, and corrupt-file recovery (same as AXON), so the feed is reliable *within* a working session — but retention keeps it from growing into long-term memory.
- **SYNAPSE ≠ AXON**: AXON = durable plan + status (the source of truth). SYNAPSE = transient chatter (coordination signals). Don't duplicate AXON state here; reference task ids and post *signals*.
