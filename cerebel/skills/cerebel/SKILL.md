---
name: cerebel
description: Orchestrate ready AXON tasks into LION worker waves. Use CEREBEL after CORTEX has planned work and AXON has ready tasks. CEREBEL tracks assignment waves, LION run links, outcomes, and next orchestration decisions.
disable-model-invocation: true
---

# CEREBEL — Orchestration Controller

CEREBEL is the controller for a GANGLION of LION workers. It does not code directly. It forms **waves** of assignments from ready AXON tasks, delegates each assignment to LION, records outcomes, and decides whether to dispatch more work, wait, complete, replan, or escalate.

Durable state: active global NERVous namespace (`~/.pi/nervous/<project>/<context>/cerebel/cerebel.json` by default).

## Standard loop

1. Read AXON:
   - `axon summary`
   - `axon list ready_only=true`
2. Plan a wave:
   - `cerebel plan_wave tasks=[...] max_parallel=... context="..."`
3. Either run the active dispatcher:
   - `cerebel run_wave wave_id="current" max_parallel=...`
   - optionally pass `runner_mode="rpc"` when live LION steering may be needed
   - use this when CEREBEL should create/run LION workers and record grouped outcomes directly
4. Or dispatch manually:
   - for each ready assignment, call `lion run task_id=... agent_id=... objective=... context=...`
   - call `cerebel dispatch links=[{assignment_id,lion_run_id,lion_run_incarnation_id}]`, using both values returned by `lion run`
   - if the assignment came from GANGLION, include `ganglion_id` and `ganglion_allocation_id` in the assignment or dispatch link so CEREBEL can release capacity later
5. Record worker results:
   - read each LION report
   - `cerebel record assignment_id=... lion_run_id=... lion_run_incarnation_id=... outcome=... summary=... blockers=[...]`
   - for linked GANGLION allocations, terminal outcomes automatically record/release the GANGLION allocation
6. Decide:
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
- **CEREBEL** owns orchestration lifecycle: waves, assignments, run links, decisions, and release of linked GANGLION capacity leases when LION outcomes are terminal.

## Tool actions

- `plan_wave` — create a wave from AXON task briefs or direct assignments.
- `dispatch` — mark assignments dispatched and link LION run ids.
- `record` — record LION outcome for one assignment. Prefer explicit `assignment_id`/`task_id`; selection by `lion_run_id` requires the exact `lion_run_incarnation_id`.
- `run_wave` — actively reserve planned assignments, create/run linked LION workers, attach them to LION per-run controls, recover stale reservations without run ids, join every admitted sibling before returning, stop/release admission after host abort, and record grouped outcomes. An RPC `cleanup_pending` result remains dispatched and retains its GANGLION lease behind a durable exact-incarnation settlement obligation until process-local supervision or a fresh-process reconciler proves the exact LION terminal and settles CEREBEL/GANGLION once; replacement incarnations are ignored. Omitted `timeout_ms` defaults to 600,000; explicit values outside integer range 1..2,147,483,647 fail before worker creation rather than falling back.
- `decide` — compute the next controller decision.
- `complete_wave` — finish a successful wave.
- `cancel` — target each exact `lion_run_id` + `lion_run_incarnation_id`, batch-wait for settlement, then cancel the wave and release only still-owned GANGLION capacity. Legacy/unverifiable or unsettled links fail closed and retain their leases.
- `get`, `list`, `summary` — inspect state.

## Good delegation

Give LION narrow objectives and concrete acceptance criteria. Prefer one AXON task per LION. Do not dispatch ambiguous architectural decisions; return to CORTEX/MAGI first.
