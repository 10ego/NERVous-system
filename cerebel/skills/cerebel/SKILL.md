---
name: cerebel
description: Orchestrate ready AXON tasks into LION worker waves. Use CEREBEL after CORTEX has planned work and AXON has ready tasks. CEREBEL tracks assignment waves, LION run links, outcomes, and next orchestration decisions.
---

# CEREBEL — Orchestration Controller

CEREBEL is the controller for a GANGLION of LION workers. It does not code directly. It forms **waves** of assignments from ready AXON tasks, delegates each assignment to LION, records outcomes, and decides whether to dispatch more work, wait, complete, replan, or escalate.

Durable state: `<project>/.pi/cerebel/cerebel.json`.

## Standard loop

1. Read AXON:
   - `axon summary`
   - `axon list ready_only=true`
2. Plan a wave:
   - `cerebel plan_wave tasks=[...] max_parallel=... context="..."`
3. Dispatch assignments:
   - for each ready assignment, call `lion run task_id=... agent_id=... objective=... context=...`
   - call `cerebel dispatch links=[{assignment_id,lion_run_id}]`
4. Record worker results:
   - read each LION report
   - `cerebel record assignment_id=... lion_run_id=... outcome=... summary=... blockers=[...]`
5. Decide:
   - `cerebel decide`
   - `dispatch` → run more LIONs
   - `wait` → collect outstanding LION runs
   - `complete` → finish wave and return to CORTEX verification
   - `replan` → update AXON/CORTEX plan
   - `escalate_to_amygdala` → mark blockers/risks in AXON; later AMYGDALA handles risk

## Important boundaries

- **CORTEX** owns intent, plan, verification.
- **AXON** owns durable task status.
- **LION** does isolated execution.
- **SYNAPSE** holds transient coordination notes.
- **CEREBEL** owns orchestration state only: waves, assignments, run links, decisions.

## Tool actions

- `plan_wave` — create a wave from AXON task briefs or direct assignments.
- `dispatch` — mark assignments dispatched and link LION run ids.
- `record` — record LION outcome for one assignment.
- `decide` — compute the next controller decision.
- `complete_wave` — finish a successful wave.
- `cancel` — cancel a wave.
- `get`, `list`, `summary` — inspect state.

## Good delegation

Give LION narrow objectives and concrete acceptance criteria. Prefer one AXON task per LION. Do not dispatch ambiguous architectural decisions; return to CORTEX/MAGI first.
