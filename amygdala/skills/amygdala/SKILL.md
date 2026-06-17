---
name: amygdala
description: Use AMYGDALA for risk escalation: blocked AXON tasks, blocked CEREBEL waves, failed LION/GANGLION allocations, security/data-loss/regression risks, or uncertainty that should pause/replan/MAGI/human review.
---

# AMYGDALA — Risk Escalation

AMYGDALA captures durable risk incidents and recommends what to do next: continue, retry, pause, replan, convene MAGI, request human review, or stop.

Use it when:
- AXON task is `blocked` or `needs_amygdala`.
- CEREBEL decision is `escalate_to_amygdala`.
- LION/GANGLION reports a blocker/failure.
- Work risks security, credentials, data loss, production impact, privacy/policy, or major regression.
- Requirements are ambiguous enough that proceeding blindly is unsafe.

Workflow:
1. `amygdala assess` with description, source/source_id, related ids, and evidence.
2. Follow the recommendation:
   - `human_review`/`stop` → pause affected work.
   - `convene_magi` → ask MAGI for decision support.
   - `pause` → mark AXON blocked and define unblock condition.
   - `replan` → return to CORTEX/CEREBEL.
3. Add mitigation notes with `amygdala add_note`.
4. `resolve` or `accept` before final CORTEX completion.

AMYGDALA owns risk state only. AXON remains the task ledger; CORTEX verifies final success.
