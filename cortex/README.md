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
cortex set_config drain_mode="on_explicit_nervous" default_drain_policy="default" risk_gate_mode="auto_deliberate"
cortex accept_risk goal_id="goal-001" reason="User accepted scoped risk" evidence="approval ticket-123" actor="user" scope="goal-001"
cortex record_failure goal_id="goal-001" reason="LION run failed" evidence="lion-run-003" retryability="retryable"
cortex reopen goal_id="goal-001" reason="AMYGDALA accepted mitigation" evidence="amygdala-001 resolved"
cortex get goal_id="current"
cortex summary
```

Actions: `analyze`, `plan`, `link`, `verify`, `complete`, `block`, `escalate`, `accept_risk`, `record_failure`, `reopen`, `cancel`, `drain`, `get_config`, `set_config`, `get`, `list`, `summary`, `set_current`.

### Commands

- **`/cortex`** — current goal.
- **`/cortex:goals`** — all goals.
- **`/cortex:resume`** — current goal + a "what's next" hint.
- **`/nervous:config`** — open a TUI menu or show/set persistent drain/risk defaults and shared NERVous model defaults.

### Skill + prompt template

- `/skill:cortex` — force-load the workflow skill.
- **`/cortex <request>`** — run the full CORTEX workflow end-to-end.
- **`/nervous [drain=...] [risk=...] [policy=...] <request>`** — run the drain workflow and optionally ask the agent to apply invocation drain/risk config first.

---

## Goal model

```json
{
  "id": "goal-001",
  "prompt": "Build a simple todo API with tests.",
  "status": "analyzed",          // analyzed|planned|executing|verified|needs_replan|blocked|needs_amygdala|completed|cancelled
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
  "blocker": { "reason": "...", "evidence": "...", "next_revisit_at": "...", "revisit_count": 0 },
  "failure": { "reason": "...", "evidence": "...", "retryability": "unknown|retryable|not_retryable", "attempts": 1, "max_attempts": 3 },
  "risk_acceptance": { "mode": "auto_deliberate|user_accepted|disabled", "actor": "...", "scope": "...", "evidence": "..." },
  "created_at": "", "updated_at": ""
}
```

**Goal lifecycle:** `analyzed → planned → executing → verified → completed`, with `needs_replan` looping back to `planned`, and `cancel` from any non-terminal status. `verify` with `approve` → `verified` (ready for MAGI review); failing checks → `needs_replan`. Drain mode can move any non-terminal goal to `blocked` (resumable after evidence/dependency resolution) or `needs_amygdala` (unsafe uncertainty/risk escalated to AMYGDALA).

---

## Never-stopping / drain mode

For explicit NERVous activation, CORTEX supports a bounded, policy-driven drain mode via `cortex drain`. A drain run snapshots incomplete goals in the active context, separates normal actionable goals from due revisits (`blocked`, `needs_amygdala` whose `next_revisit_at` is due), retryable/needs-classification failures, and waiting goals, then records durable run evidence/budgets.

Drain mode is togglable with persistent CORTEX config. `/nervous:config` also manages shared model defaults for NERVous subprocess systems:

```text
/nervous:config
/nervous:config show
/nervous:config drain=on_explicit_nervous risk=auto_deliberate policy=default
/nervous:config drain=always risk=strict policy=conservative
/nervous:config risk=disabled dangerous_opt_in=true evidence="explicit user-approved automation window"
/nervous:config lion_model=provider/fast magi_model=provider/balanced magi_synthesis_model=provider/strong:high
/nervous:config lion_model=unset

cortex get_config
cortex set_config drain_mode="on_explicit_nervous" default_drain_policy="default" risk_gate_mode="auto_deliberate"
```

In TUI mode, empty `/nervous:config` opens a settings-style menu for drain mode, risk gate, drain policy, and model defaults. When pi's model registry is available, model rows open a searchable picker. Selected values apply immediately; Esc closes the menu. Use `/nervous:config show` for markdown output. Outside TUI, empty `/nervous:config` falls back to markdown.

For one-off prompt invocation, include config tokens in `/nervous` arguments; the prompt instructs the agent to apply them first:

```text
/nervous risk=user_accepted drain=always implement the migration
/nervous risk=disabled dangerous_opt_in=true evidence="approved automation window" run the full backlog
```

Modes:

- `off` — `cortex drain` is disabled unless `force=true` is passed for an explicit one-off run.
- `on_explicit_nervous` — safe default; drain is available when the user explicitly invokes NERVous/drain behavior.
- `always` — explicit opt-in for callers/skills that want drain behavior to be treated as the default active-context posture.

Policies: `default`, `conservative`, `aggressive`. The configured `default_drain_policy` is used when `cortex drain` does not pass `policy_name`. Policies tune budgets; they do not decide risk authorization.

Risk gate modes:

- `strict` — hard-stop signals are escalated to `needs_amygdala` with revisit evidence.
- `auto_deliberate` — default; risky work may proceed only after MAGI/AMYGDALA approval is recorded with `cortex accept_risk ... risk_gate_mode="auto_deliberate"`.
- `user_accepted` — risky work may proceed only after scoped user acceptance evidence is recorded with `cortex accept_risk`.
- `disabled` — dangerous explicit opt-in; requires `dangerous_opt_in=true` and `risk_gate_evidence`, and drain records accepted-risk evidence instead of silently bypassing gates.

Model defaults:

- Stored in `~/.pi/agent/nervous.json`, with trusted project overlay from `<repo>/.pi/nervous.json`.
- Keys: `models.lion.default`, `models.magi.councillorDefault`, `models.magi.synthesisDefault`.
- Runtime precedence preserves explicit choices: `lion run model=...` beats the configured LION default; MAGI council `model` / `synthesis_model` beats configured MAGI defaults. If only `magi.councillorDefault` is set, synthesis follows MAGI's existing synthesizer-model fallback.
- Unset keys preserve the previous behavior: NERVous passes no `--model`, so the subprocess uses pi's current/default model.

Safety/recovery semantics:

- Drain mode means **never silently abandon** a selected goal; each goal remains workable, waiting with revisit/retry evidence, completed, or explicitly cancelled.
- Failed work must be recorded with `cortex record_failure`; drain surfaces `retryability="unknown"` for classification and `retryable` failures when `next_retry_at` is due and attempts remain.
- Blocked/skipped work carries `next_revisit_at`, `revisit_count`, and unblock conditions; due revisits are returned in every drain run until resolved, reopened with `cortex reopen`, or explicitly terminal.
- The default policy includes bounded budgets (`max_goals`, retry/replan/no-progress limits) to prevent infinite loops and thrashing.
- Use `cortex block` for non-actionable dependency/tooling blockers and `cortex escalate` for unsafe uncertainty requiring AMYGDALA. Both require non-empty evidence; include AXON/AMYGDALA/CEREBEL/LION ids in `related_ids` where available.

Typical loop:

```text
cortex drain                         # snapshot active context
cortex set_current goal-...          # resume each workable/actionable/due-revisit/retry goal
axon summary/list                    # inspect linked task state
cerebel/lion/ganglion as useful      # execute ready work
cortex verify → cortex complete      # close completed goals
cortex block/escalate                # durable evidence + next_revisit_at for non-actionable/unsafe goals
cortex record_failure                # retryability + next_retry_at for failed work
cortex accept_risk                   # scoped approval evidence for non-strict risk gates
cortex reopen                        # move resolved blocked/needs_amygdala work back to needs_replan
repeat cortex drain until no workable goals remain and waiting goals have explicit revisit/retry evidence
```

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `~/.pi/nervous/<project>/<context>/cortex/cortex.json` (override with `CORTEX_PATH`) |
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
