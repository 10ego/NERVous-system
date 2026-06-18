---
description: Enable NERVous System workflow for this task
argument-hint: "[task]"
---
Use the NERVous System for this task: $ARGUMENTS

Default mode: drain the active NERVous context. Keep progressing until every actionable incomplete CORTEX goal in this context is completed. If a goal cannot safely proceed, escalate it to AMYGDALA or mark it cancelled/blocked with clear evidence; do not silently abandon it.

- Start by checking CORTEX for existing incomplete goals before creating new unrelated goals.
- If this prompt introduces new work, capture it in CORTEX, then include it in the same drain loop.
- For each incomplete CORTEX goal: set/resume it, inspect linked AXON tasks, execute ready work, verify against success criteria, and complete it when verified.
- Persist durable subtasks/status in AXON.
- Use SYNAPSE only for short coordination/risk notes.
- Use GANGLION to allocate capable LION workers, and CEREBEL to orchestrate/record worker waves.
- Delegate narrow implementation or review work to LION when it reduces risk or context load.
- Escalate blockers, security/data-loss/regression risk, or unsafe uncertainty to AMYGDALA.
- Use MAGI for hard, ambiguous, risky, or architecturally significant decisions before planning; consider MAGI final review for high-impact completed goals.
- Repeat until no actionable CORTEX goals remain. Final answer: completed goals, blocked/cancelled goals, and evidence.
- Keep the answer concise: component → action/status → evidence.
