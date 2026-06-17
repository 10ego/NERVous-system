---
name: magi
description: Convene the MAGI deliberation council (The Mind, The Heart, The Hand) for hard, ambiguous, risky, or architecturally significant decisions. Returns a structured multi-perspective recommendation. Use before major decisions or final review.
---

# MAGI — Deliberation Council

MAGI is a configurable council of **at most 3 councillors** that deliberates a decision from distinct perspectives and returns a single, synthesized recommendation. MAGI **advises only** — it never executes work. CORTEX (or the main agent) converts the recommendation into a plan.

## When to convene MAGI

Convene MAGI when a decision is one or more of:

- **Hard / complex** — multiple interacting concerns.
- **Ambiguous** — unclear tradeoffs or requirements.
- **Risky / high-impact** — destructive side effects, security, data loss, public API.
- **Architectural** — a major structural decision with long-term consequences.
- **Final review** — a multi-perspective sign-off before delivery.

Do **not** convene MAGI for simple, well-understood tasks.

## Default council

| Councillor | Symbol | Perspective | Prevents |
|------------|--------|-------------|----------|
| The Analytical Critic | The Mind | Cold facts, worst-case, logical rigor | Groupthink, sloppy execution |
| The Empathetic Sage | The Heart | Users, maintainability, long-term health | User-hostile, short-term decisions |
| The Pragmatic Strategist | The Hand | Execution, tradeoffs, sequencing | Paralysis, unrealistic plans |

The Hand leads synthesis by default.

## How to invoke

Call the **`magi`** tool (preferred, programmatic path) with:

- `issue` (required) — the decision to deliberate.
- `context`, `constraints`, `decision_needed`, `options` — optional framing.
- `council` — optional: `"default"` | `"two"` | `"one"`, a config name, a path to a council JSON file, or inline JSON.
- `critique` — optional: run the cross-critique round (default on for 2+ councillors).

From the terminal, `/magi <issue>` runs the default council and displays the result, and `/deliberate <issue>` is a prompt template that convenes MAGI via the tool and then acts on the recommendation.

## Output contract

MAGI returns:

- `individual_opinions` — each councillor's position, concerns, recommendation (and critiques if the critique round ran).
- `points_of_agreement`, `points_of_disagreement`, `risks`, `rejected_options`.
- `final_recommendation` — a single actionable recommendation for CORTEX.
- `confidence` — `low` | `medium` | `high`.

## Configuring the council

Councillor config is the single source of truth. Resolution order: explicit `council` arg → project `<cwd>/.pi/magi/council.json` → user `~/.pi/agent/magi/council.json` → bundled default.

A councillor is defined by: `id`, `name`, `symbol`, `archetype`, `core_trait`, `role`, `danger_prevented`, and optional `system_prompt`, `model`, `tools`. Configurations with **more than 3 councillors are rejected**. See `config/council.*.json` for examples.
