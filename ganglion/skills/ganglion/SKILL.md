---
name: ganglion
description: Manage a GANGLION working group of LION slots. Use it to create a roster, track capabilities and availability, and allocate ready AXON tasks to suitable LION members before CEREBEL dispatches workers.
disable-model-invocation: true
---

# GANGLION — LION Working Group

A **GANGLION** is a roster of LION slots with capabilities and capacity. It answers: **which LION should take this ready task?**

GANGLION does not execute work. CEREBEL orchestrates waves; LION runs subprocess workers. GANGLION owns only roster/capability/allocation state.

Durable state: active global NERVous namespace (`~/.pi/nervous/<project>/<context>/ganglion/ganglion.json` by default).

## Standard use

1. Create a group:
   - `ganglion create name="demo" member_count=3 max_parallel=2`
   - or provide explicit `members` with capabilities.
2. Read AXON ready tasks.
3. Call `ganglion allocate tasks=[...] context="..."`.
4. Use the returned allocations as CEREBEL/LION inputs:
   - member id → `agent_id`
   - allocation objective/context → LION objective/context
5. Prefer linking the allocation through CEREBEL by passing `ganglion_id` and `ganglion_allocation_id`; CEREBEL will record/release capacity when the LION outcome is terminal. If not using CEREBEL, after LION completion call `ganglion record` with allocation status and run id, or `ganglion release`.
6. If interrupted bookkeeping leaves members busy after terminal LION runs, call `ganglion reconcile` to conservatively release stale capacity from exact/same-task LION evidence.

## Capability allocation

Tasks may include `required_capabilities`. Members with matching capabilities are preferred. If a task has no required capability, any available member can take it. GANGLION respects `max_parallel` and existing busy members.

## Boundaries

- **AXON** is the durable task ledger.
- **GANGLION** chooses LION slots by capability/capacity.
- **CEREBEL** runs orchestration waves.
- **LION** executes one assignment.
- **SYNAPSE** coordinates transiently.

## Tool actions

`create`, `add_member`, `update_member`, `remove_member`, `set_status`, `allocate`, `record`, `release`, `reconcile`, `get`, `list`, `summary`, `delete`.

## Commands

- `/ganglion` — summary.
- `/ganglion:groups` — list groups.
