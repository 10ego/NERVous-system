# @nervous-system/cortex

> **CORTEX** — the main reasoning core of the [NERVous System](../README.md). Converts a user prompt into a durable goal (intent, success criteria, constraints, risks), decides whether MAGI deliberation is needed, stores an execution plan, links it to AXON tasks, and verifies completed work against the original intent before final review. **Goals persist across compaction/restart so work resumes without the original context window.**

In pi, **the main agent *is* CORTEX** — this package augments it with structured intent/planning/verification tools, a durable goal store, and a workflow skill that wires together MAGI + AXON + SYNAPSE. CORTEX deliberately does **not** import those packages at runtime; the agent bridges them, keeping each package independently installable.

---

## Install

### Try it without installing

```bash
pi -e ./cortex/extension/index.ts
```

### Install as a pi package

```bash
pi install ./cortex        # user scope
pi install ./cortex -l     # project scope
```

Or add to `settings.json`:

```json
{ "packages": ["./cortex"] }
```

---

## The CORTEX workflow

```
1. analyze   → cortex analyze          (intent → durable Goal)
2. magi?     → magi tool (only if needs_magi)
3. plan      → cortex plan             (subtasks; ref MAGI rec if used)
4. create    → axon create (per subtask) → cortex link (record ids)
5. execute   → do the work; axon set_status/add_note; synapse post
6. verify    → read axon summary → cortex verify (vs success criteria)
7. review    → magi (final review) if verify approved
8. complete  → cortex complete; deliver final output
```

### Resume after interruption/compaction

Call `cortex get` with `goal_id: "current"` (or `/cortex:resume`). It returns the durable goal — intent, plan, linked AXON tasks, verification status — plus a "what's next" hint, so you continue exactly where you left off. Then read `axon summary` for task state.

---

## Usage

### The `cortex` tool (single tool, `action`)

```text
cortex analyze prompt="Build a simple todo API with tests" goal="..." success_criteria=["...","..."] risks=[{...}] complexity="medium"
cortex plan goal_id="goal-001" subtasks=[{title="Scaffold"},{title="Tests",dependencies=["Scaffold"]}]
cortex link goal_id="goal-001" links=[{plan_id="plan-001",axon_task_id="task-001"}]
cortex verify goal_id="goal-001" checks=[{criterion="...",passed=true,evidence="..."}] all_axon_complete=true
cortex complete goal_id="goal-001"
cortex get_config
cortex set_config drain_mode="on_explicit_nervous" default_drain_policy="default"
cortex get goal_id="current"
cortex summary
```

Actions: `analyze`, `plan`, `link`, `verify`, `complete`, `block`, `escalate`, `cancel`, `drain`, `get_config`, `set_config`, `get`, `list`, `summary`, `set_current`.

### Commands

- **`/cortex`** — current goal.
- **`/cortex:goals`** — all goals.
- **`/cortex:resume`** — current goal + a "what's next" hint.

### Skill + prompt template

- `/skill:cortex` — force-load the workflow skill.
- **`/cortex <request>`** — run the full CORTEX workflow end-to-end.

---

## Goal model

```json
{
  "id": "goal-001",
  "prompt": "Build a simple todo API with tests.",
  "status": "analyzed",          // analyzed|planned|executing|verified|needs_replan|completed|cancelled
  "intent": {
    "intent_summary": "...", "goal": "...",
    "success_criteria": ["..."], "constraints": ["..."],
    "risks": [{ "description": "...", "severity": "medium" }],
    "expected_output": "...", "complexity": "medium",
    "needs_magi": false, "magi_rationale": "..."
  },
  "plan": {
    "subtasks": [{ "id": "plan-001", "title": "...", "dependencies": ["plan-002"], "priority": "high", "axon_task_id": "task-001" }],
    "magi_used": false
  },
  "axon_task_ids": ["task-001", "task-002"],
  "verification": {
    "checks": [{ "criterion": "...", "passed": true, "evidence": "..." }],
    "all_axon_complete": true, "recommendation": "approve", "ready_for_magi_review": true, "concerns": []
  },
  "created_at": "", "updated_at": ""
}
```

**Goal lifecycle:** `analyzed → planned → executing → verified → completed`, with `needs_replan` looping back to `planned`, and `cancel` from any non-terminal status. `verify` with `approve` → `verified` (ready for MAGI review); failing checks → `needs_replan`. Drain mode can move any non-terminal goal to `blocked` (resumable after evidence/dependency resolution) or `needs_amygdala` (unsafe uncertainty/risk escalated to AMYGDALA).

---

## Never-stopping / drain mode

For explicit NERVous activation, CORTEX supports a bounded, policy-driven drain mode via `cortex drain`. A drain run snapshots incomplete goals in the active context, separates actionable goals (`analyzed`, `planned`, `executing`, `verified`, `needs_replan`) from waiting goals (`blocked`, `needs_amygdala`), and records durable run evidence/budgets.

Drain mode is togglable with persistent CORTEX config:

```text
cortex get_config
cortex set_config drain_mode="off"
cortex set_config drain_mode="on_explicit_nervous" default_drain_policy="default"
cortex set_config drain_mode="always" default_drain_policy="conservative"
```

Modes:

- `off` — `cortex drain` is disabled unless `force=true` is passed for an explicit one-off run.
- `on_explicit_nervous` — safe default; drain is available when the user explicitly invokes NERVous/drain behavior.
- `always` — explicit opt-in for callers/skills that want drain behavior to be treated as the default active-context posture.

Policies: `default`, `conservative`, `aggressive`. The configured `default_drain_policy` is used when `cortex drain` does not pass `policy_name`.

Safety semantics:

- Drain mode means **never silently abandon** a selected goal; each goal must become completed, cancelled, blocked, or needs_amygdala with evidence.
- It does **not** bypass hard safety gates. Critical/security/data-loss/regression/policy/credential/production signals are auto-excluded from actionable work and escalated to `needs_amygdala` unless explicitly resolved elsewhere.
- The default policy includes bounded budgets (`max_goals`, retry/replan/no-progress limits) to prevent infinite loops and thrashing.
- Use `cortex block` for non-actionable dependency/tooling blockers and `cortex escalate` for unsafe uncertainty requiring AMYGDALA. Both require non-empty evidence; include AXON/AMYGDALA/CEREBEL/LION ids in `related_ids` where available.

Typical loop:

```text
cortex drain                         # snapshot active context
cortex set_current goal-...          # resume each actionable goal
axon summary/list                    # inspect linked task state
cerebel/lion/ganglion as useful      # execute ready work
cortex verify → cortex complete      # close completed goals
cortex block/escalate                # durable evidence for non-actionable/unsafe goals
repeat cortex drain until no actionable goals remain
```

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `<cwd>/.pi/cortex/cortex.json` (override with `CORTEX_PATH`) |
| Atomicity | Write to `cortex.json.tmp` then `fs.rename` |
| Backup | Each save copies the previous file to `cortex.json.bak` |
| Concurrency | Advisory lock (`cortex.json.lock`, O_EXCL) with stale-lock detection |
| Corruption | A corrupt file is copied aside (`.corrupt-<ts>`) and CORTEX starts fresh |

Same durability strategy as AXON/SYNAPSE — the goal file is what makes CORTEX resumable.

---

## Architecture

```
cortex/
├── extension/
│   ├── index.ts        # entry: cortex tool + /cortex* commands
│   ├── schema.ts       # Goal/IntentAnalysis/ExecutionPlan/VerificationReport models + TypeBox schemas
│   ├── store.ts        # GoalStore: pure lifecycle + validation  (no I/O)
│   ├── backend.ts      # FileBackend (atomic/lock/recover) + CortexStore (load→mutate→save)
│   └── render.ts       # TUI rendering + markdown goal summaries
├── skills/cortex/SKILL.md   # the CORTEX workflow skill
├── prompts/cortex.md        # /cortex <request> full-workflow prompt
└── tests/              # store (lifecycle), backend (durability+concurrency), smoke, live
```

**Decoupling:** CORTEX owns only its goal state. The agent bridges AXON (create/link tasks, read summary), MAGI (deliberate, final review), and SYNAPSE (coordination) as the workflow dictates. This matches the pi multi-package model: each package owns its state; CORTEX coordinates.

---

## Develop & test

```bash
npm install
npm test                                       # unit + smoke (no LLM calls)
npx vitest run cortex/tests/backend.test.ts    # durability + concurrency
CORTEX_LIVE=1 npx vitest run cortex/tests/live.test.ts   # real end-to-end
```

The suite covers: analyze + heuristic needs_magi, plan (id assignment + dependency resolution), link, verify (approve/revise), complete (requires verified), cancel, lifecycle transitions, current/list/serialization + coercion, persistence round-trip, atomic writes, corrupt recovery, real 3-process concurrency, and extension factory smoke.

---

## Relation to NERVous

CORTEX is the orchestrator-of-orchestrators:

- **analyze** captures intent durably (survives compaction).
- decides **MAGI** (only when `needs_magi`).
- **plan + link** turn the plan into **AXON** tasks (the durable execution state).
- during execution, agents coordinate via **SYNAPSE**.
- **verify** checks AXON completion against the goal's success criteria.
- on approval, optional **MAGI** final review → **complete**.

Build priority: CORTEX is #3 (after AXON #1 and SYNAPSE #2; MAGI #4 already done). With CORTEX, the top half of the system flow (user → intent → MAGI → plan → AXON → … → verify → MAGI review → output) is fully wired; what remains is the execution/orchestration layer (LION/CEREBEL/GANGLION/AMYGDALA).
