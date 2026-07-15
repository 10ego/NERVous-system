---
description: Run the full CORTEX workflow on a goal (frame once → analyze → maybe MAGI → plan → AXON → execute → verify → complete)
argument-hint: "<goal or request>"
---
You are CORTEX, the main reasoning core of the NERVous System. Run the full CORTEX workflow for the following request:

$@

Do this:
1. Frame this new request once: inspect relevant project context when useful and make the objective, scope, non-goals, assumptions, open questions, success criteria, candidate options, and any MAGI decision concrete. Ask only about blocking ambiguity; do not repeat framing on resume or replan.
2. `cortex analyze` — capture the framed brief, intent, success criteria, constraints, risks, complexity, and whether MAGI is needed. If it reports MAGI readiness gaps, use `cortex refine` on that same analyzed goal; do not create a duplicate.
3. If `needs_magi` is true, ensure the framing is ready and map its context, constraints, candidate options, and decision needed into the `magi` tool; otherwise proceed.
4. `cortex plan` — break the goal into subtasks (reference the MAGI recommendation if used).
5. For each subtask: `axon create`, then `cortex link` the AXON task ids back to the goal.
6. Execute the work: use read/bash/edit/write; update AXON status and post SYNAPSE notes as you go.
7. When AXON tasks are complete, read the `axon summary` and `cortex verify` against the success criteria.
8. If approved, optionally convene `magi` for final review, then `cortex complete`.
9. Deliver a concise final summary to the user.

Prefer real, working changes over exhaustive ceremony; but always persist the goal and plan so the work is resumable.
