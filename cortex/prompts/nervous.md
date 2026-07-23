---
description: Enable NERVous System workflow for this task
argument-hint: "[drain=<off|on_explicit_nervous|always>] [risk=<strict|auto_deliberate|user_accepted|disabled>] [task]"
---
Use the NERVous System for this invocation.

Invocation arguments: $ARGUMENTS

Optional invocation configuration tokens may be included in the arguments: `drain=<off|on_explicit_nervous|always>`, `risk=<strict|auto_deliberate|user_accepted|disabled>`, `policy=<default|conservative|aggressive>`, `evidence="..."`, `dangerous_opt_in=true`. If present, first call `cortex set_config` with those values, then treat the remaining arguments as the task. If `risk=disabled` is requested without explicit `dangerous_opt_in=true` and non-empty `evidence`, stop and ask the user for confirmation/evidence instead of proceeding. Model defaults for LION/MAGI are persisted separately with `/nervous:config lion_model=... lion_fallback_model=... magi_model=... magi_fallback_model=...` before invoking this prompt; unset model defaults preserve pi's current/default model behavior.

Default mode: drain the active NERVous context. Keep progressing until every workable incomplete CORTEX goal in this context is completed. Workable includes normal actionable goals, skipped/blocked goals due for revisit, and failed goals due for retry or retryability classification. If a goal cannot safely proceed, escalate it to AMYGDALA or mark it cancelled/blocked with clear evidence plus revisit/retry metadata; do not silently abandon it.

- Start by checking CORTEX config and applying invocation config tokens if supplied; users can also persist defaults with `/nervous:config` before invoking this prompt.
- Check CORTEX for existing incomplete goals before creating new unrelated goals.
- If this prompt introduces new work, perform one bounded task-framing pass before `cortex analyze`: inspect relevant project context when useful; make the objective, scope, non-goals, assumptions, success criteria, candidate options, and any MAGI decision concrete. Ask the user only about ambiguity that blocks a responsible goal; record non-blocking uncertainty as assumptions or open questions. Persist the result in `cortex analyze.framing`. If analyze reports MAGI readiness gaps, repair that same analyzed goal with `cortex refine` rather than creating a duplicate, then include it in the same drain loop.
- Framing happens once for new work. Do not repeat it when resuming, replanning, retrying, or revisiting an existing goal; use the durable framing already stored on the goal.
- Check CORTEX config/risk_gate_mode, then drain/list goals; for each workable CORTEX goal: set/resume it, inspect linked AXON tasks, execute ready/retry/revisit work, verify against success criteria, and complete it when verified.
- Persist durable subtasks/status in AXON.
- Use SYNAPSE only for short coordination/risk notes.
- Use GANGLION to allocate capable LION workers, and CEREBEL to orchestrate/record worker waves.
- Delegate narrow implementation or review work to LION when it reduces risk or context load; use `model_role="review"` for LION review/QA assignments.
- Escalate blockers, security/data-loss/regression risk, or unsafe uncertainty to AMYGDALA unless risk_gate_mode has explicit approval evidence (`auto_deliberate`, `user_accepted`, or dangerous `disabled`).
- Use MAGI for hard, ambiguous, risky, or architecturally significant decisions before planning. Before convening, ensure the framed objective, scope, success criteria, and `decision_needed` are concrete; map framing context, constraints, candidate options, and decision needed into the MAGI call. Consider MAGI final review for high-impact completed goals.
- Record failed work with retryability; record skipped work with next_revisit_at/unblock conditions; revisit due skipped work and use `cortex reopen` when resolved so it can be replanned/completed.
- Repeat until no workable CORTEX goals remain. Final answer: completed goals, waiting/retry/skipped/cancelled goals, and evidence.
- Keep the answer concise: component → action/status → evidence.
