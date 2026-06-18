---
name: cortex
description: Run CORTEX, the main reasoning core of the NERVous System. Turn a user request into a durable goal (intent, success criteria, constraints, risks), decide whether MAGI deliberation is needed, plan it into subtasks linked to AXON, and verify completed work against the original intent. Use it for any non-trivial multi-step task so progress survives compaction and restart.
---

# CORTEX — Main Reasoning Core

CORTEX is the NERVous System's main reasoning core. **You are CORTEX.** This skill gives you the structured tools and the workflow to: understand intent, decide when to convene MAGI, plan into durable AXON tasks, coordinate via SYNAPSE, and verify work against the original goal.

The central idea: **capture intent + plan + verification as a durable Goal** so that work can resume after compaction or restart *without the original context window*. The goal lives in the active global NERVous namespace (`~/.pi/nervous/<project>/<context>/cortex/cortex.json` by default).

## The CORTEX workflow

Follow this flow. Each step uses a tool.

```
1. analyze   → cortex analyze          (intent → durable Goal)
2. magi?     → magi (only if needs_magi)
3. plan      → cortex plan             (subtasks; ref MAGI rec if used)
4. create    → axon create (per subtask) → cortex link (record ids)
5. execute   → do the work; axon set_status/add_note; synapse post
6. verify    → read axon summary → cortex verify (vs success criteria)
7. review    → magi (final review) if verify approved
8. complete  → cortex complete; deliver final output to the user
```

### 1. Analyze intent (`cortex analyze`)
Call `cortex analyze` with the user's `prompt` plus your structured analysis: `intent_summary`, `goal`, `success_criteria[]`, `constraints[]`, `risks[]` (`{description, severity}`), `expected_output`, `complexity` (low|medium|high). Set `needs_magi` when the task is hard/ambiguous/risky/architectural (a heuristic suggests it for high complexity or high-severity risks; you can override). The tool returns a goal id and persists the analysis durably.

### 2. Convene MAGI? (only if `needs_magi`)
If the goal's `needs_magi` is true, call the **magi** tool with the issue (and the goal's context/constraints/options). Then carry its `final_recommendation` into planning. Otherwise skip to plan. Do **not** convene MAGI for simple, well-understood tasks.

### 3. Plan (`cortex plan`)
Call `cortex plan` with the goal id and a list of `subtasks` (`title`, `description`, `dependencies`, `priority`). If MAGI was used, set `magi_used=true` and `magi_output_ref`. The tool assigns plan-ids (`plan-001`…) and resolves dependency titles to plan-ids.

### 4. Create AXON tasks + link
For each planned subtask, call **axon create** (passing `dependencies` as the *AXON* task ids of upstream tasks once they exist, or create them in dependency order). Then call `cortex link` with `{plan_id, axon_task_id}` pairs (or just `axon_task_id`s) so CORTEX tracks the linkage. This moves the goal to `executing`.

### 5. Execute
Do the actual work. As you go: `axon set_status` to move tasks `ready→in_progress→needs_review→completed`, `axon add_note` for durable milestones, and **synapse post** for transient coordination signals (started/completed/blocker/risk/decision) — especially if other agents are involved.

### 6. Verify (`cortex verify`)
When AXON work is complete, read the **axon summary** (and per-task status). Then call `cortex verify` with a `checks[]` entry per success criterion (`criterion`, `passed`, `evidence`), `all_axon_complete`, and a `recommendation` (approve|revise|replan|escalate_to_magi). Approval → goal `verified` and ready for MAGI final review. Problems → `needs_replan` (revise the plan and repeat).

### 7. Final MAGI review
If verify approved, optionally convene **magi** for a final review (high-impact goals). Address any required revisions.

### 8. Complete (`cortex complete`)
Call `cortex complete` (requires `verified`), then deliver the final user-facing output summarizing what was done.

## Resuming after interruption / compaction

If you've been interrupted or your context was compacted, call **`cortex get`** with `goal_id: "current"` (or `/cortex:resume`). It returns the durable goal — intent, plan, linked AXON tasks, verification status — and a resume hint, so you can continue exactly where you left off. Then read **axon summary** to see task state.

## Key principles

- **AXON is durable state** (the plan + status — source of truth). **SYNAPSE is transient** coordination. **CORTEX** holds the goal/intent/verification that ties them together. Don't duplicate: reference ids.
- **Capture intent before acting.** A 30-second `cortex analyze` makes the work resumable and verifiable.
- **MAGI is for hard calls, not routine work.** Respect its `needs_magi` signal.
- **Verify against the original success criteria**, not just "tasks are done."

## Commands

- `/cortex` — current goal.
- `/cortex:goals` — all goals.
- `/cortex:resume` — current goal + a "what's next" hint.

## Scope note

CORTEX works on its own durable state even if AXON/MAGI/SYNAPSE aren't installed, but it's designed to orchestrate them. For simple one-shot tasks (a single edit, a quick question), skip CORTEX and just do the work.
