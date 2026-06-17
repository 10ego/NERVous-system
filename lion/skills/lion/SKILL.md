---
name: lion
description: Delegate one concrete coding assignment to an isolated LION subprocess worker. Use for self-contained AXON tasks that can be safely performed in a separate context. The worker returns a durable WORKER_REPORT stored in .pi/lion/runs.json.
---

# LION — Local Intelligence Operations Node

A **LION** is a single isolated coding subagent: one subprocess, one assignment, one report. Use it when a task is clear enough to delegate without giving the worker the whole conversation.

## When to use

Use `lion run` when:

- an AXON task is self-contained;
- the task has clear acceptance criteria;
- work can proceed from repository state + a concise context brief;
- you want isolation from the main context window.

Do **not** use LION for broad ambiguous planning — use CORTEX/MAGI first.

## Delegation pattern

1. Read the relevant AXON task.
2. Build a narrow `objective` and concise `context`.
3. Call `lion run` with `task_id` when available.
4. Read the returned worker report.
5. Reflect the result into AXON/SYNAPSE/CORTEX:
   - completed/partial → inspect changes and run final checks;
   - blocked → update AXON blocker or escalate to AMYGDALA later;
   - failed → decide whether to retry, replan, or handle manually.

Example:

```text
lion run task_id="task-003" agent_id="lion-api-tests" objective="Add pytest coverage for the todo API endpoints." context="Success: create/update/delete/list are covered; run the project test command; avoid unrelated refactors."
```

## Worker contract

The worker must end with a parseable `WORKER_REPORT` JSON block:

```json
{
  "WORKER_REPORT": {
    "outcome": "completed",
    "summary": "what changed",
    "changed_files": ["path"],
    "tests_run": ["command"],
    "blockers": [],
    "next_steps": []
  }
}
```

The LION package persists that report in `.pi/lion/runs.json`.

## Commands

- `/lion` — run summary.
- `/lion:runs` — recent runs.

## Relationship to the rest of NERVous

- **CORTEX** decides intent/plan/verification.
- **AXON** stores durable task state.
- **CEREBEL** will orchestrate multiple LIONs.
- **SYNAPSE** carries transient coordination notes.
- **LION** executes a single local assignment and reports back.
