# NERVous System

A modular multi-agent coding-agent extension framework for [pi](https://pi.dev), inspired by Evangelion naming but built as a practical system where multiple coding agents **plan, coordinate, execute, recover from interruptions, and review** work continuously.

> **Status:** 🟢 Core component set and final deterministic end-to-end demo are complete and tested: **MAGI**, **AXON**, **SYNAPSE**, **CORTEX**, **LION**, **CEREBEL**, **GANGLION**, **AMYGDALA**, plus [`demo/`](./demo).

## Components

| Component | Role | Status |
|-----------|------|--------|
| **CORTEX** | Main reasoning core: intent, planning, verification | ✅ [`cortex/`](./cortex) |
| **MAGI** | Configurable deliberation council (≤3 councillors) | ✅ [`magi/`](./magi) |
| **AXON** | Persistent task ledger (survives compaction/restart) | ✅ [`axon/`](./axon) |
| **CEREBEL** | Orchestration controller for LION worker waves | ✅ [`cerebel/`](./cerebel) |
| **LION** | Local Intelligence Operations Node — an isolated coding subagent | ✅ [`lion/`](./lion) |
| **GANGLION** | Working-group roster/capability allocator for LIONs | ✅ [`ganglion/`](./ganglion) |
| **SYNAPSE** | Transient shared coordination scratchpad | ✅ [`synapse/`](./synapse) |
| **AMYGDALA** | Risk escalation and safety triage | ✅ [`amygdala/`](./amygdala) |
| **Dashboard** | Read-only TUI modal for all NERVous system state | ✅ [`dashboard/`](./dashboard) |
| **State** | Shared global project/context state resolver | ✅ [`state/`](./state) |
| **E2E demo** | Deterministic full-system todo API flow | ✅ [`demo/`](./demo) |

### Execution flow (target)

```
User → CORTEX →(if hard)→ MAGI → CORTEX → AXON → CEREBEL → GANGLION{LION…}
                                              │            ↕ SYNAPSE
                                              └─→ AMYGDALA (on risk)
LIONs complete → update AXON → CEREBEL assigns more → … → CORTEX checks → MAGI final review
```

**Key principle:** AXON is durable state; SYNAPSE is transient coordination. Interrupted work resumes from AXON without the original context window.

## State isolation

NERVous runtime state is global but isolated by project and work context. By default, component ledgers live under:

```text
~/.pi/nervous/<project-slug>-<path-hash>/<context>/<component>/...
```

- **Project namespace** prevents cross-repo contamination. It is derived from the git root path; set `NERVOUS_PROJECT=<name>` to override.
- **Context namespace** prevents stale completed work from bleeding into a new effort. It defaults to the current git branch, or `default` outside git; set `NERVOUS_CONTEXT=<work-id>` to intentionally start/resume a workstream.
- Set `NERVOUS_STATE_ROOT=/path/to/root` to move all NERVous state elsewhere.
- Existing explicit component paths still win, e.g. `AXON_LEDGER_PATH`, `CORTEX_PATH`, `SYNAPSE_PATH`, `LION_RUNS_PATH`, `CEREBEL_PATH`, `GANGLION_PATH`, `AMYGDALA_PATH`, `MAGI_HISTORY_PATH`.

Examples:

```bash
# Start a clean, named work context in the current repo
NERVOUS_CONTEXT=upload-api pi

# Resume that same work context later
NERVOUS_CONTEXT=upload-api pi --session <session-id>

# Put all NERVous state under a custom global root
NERVOUS_STATE_ROOT="$HOME/.pi/nervous" pi
```

NERVous does not auto-migrate or delete old repo-local `.pi/` state. If you have existing state you want to keep, copy it into the corresponding global namespace manually.

## NERVous prompts vs. raw LLM baseline

A small deterministic benchmark compares GPT 5.5 low-thinking output with and without the NERVous extension prompt/tool surfaces loaded. The tasks ask for concise coding-orchestration guidance for a risky authenticated file-upload API and a blocked data-loss migration handoff.

| Setup | Quality / 1k output tokens | Raw quality score | Output tokens |
|-------|----------------------------|-------------------|---------------|
| Raw GPT 5.5 low, no NERVous extensions | 64.84 | 121 | 1,866 |
| GPT 5.5 low + NERVous extensions | **79.72** | 127 | 1,593 |

On this benchmark, the NERVous prompt/tool surfaces improved useful guidance density by about **23%** versus the raw model. The main observed gains were more reliable component routing, durable state/coordination coverage, and safer blocked-work triage.

> Benchmark note: this is a focused regression benchmark, not a universal model leaderboard. It measures rubric-scored guidance density for representative NERVous coding workflows.

## Repository layout

Each component is an independent, installable pi package so they can be used and shipped separately:

```
nervous-system/
├── magi/            # ✅ MAGI deliberation council (extension + skill + prompts + config + tests)
├── axon/            # ✅ AXON durable task ledger (extension + skill + config + tests)
├── synapse/         # ✅ SYNAPSE transient coordination scratchpad (extension + skill + tests)
├── cortex/          # ✅ CORTEX main reasoning core: goals + workflow (extension + skill + prompt + tests)
├── lion/            # ✅ LION isolated pi coding subagent worker (extension + skill + prompt + tests)
├── cerebel/         # ✅ CEREBEL orchestration controller for LION waves (extension + skill + prompt + tests)
├── ganglion/        # ✅ GANGLION LION roster + capability allocator (extension + skill + prompt + tests)
├── amygdala/        # ✅ AMYGDALA risk escalation + safety triage (extension + skill + prompt + tests)
├── dashboard/       # ✅ read-only TUI dashboard for all NERVous system state
├── state/           # ✅ shared global project/context state resolver
└── demo/            # ✅ deterministic final end-to-end flow
```

## Getting started

```bash
npm install
npm test                       # run all component + demo tests
npm run test:e2e               # run the deterministic final end-to-end flow
npm run test:dashboard         # run dashboard tests
npm run test:state             # run shared state resolver tests

# Try MAGI without installing:
pi -e ./magi/extension/index.ts

# Or install it:
pi install ./magi
```

See component READMEs for usage and architecture: [`magi/`](./magi), [`axon/`](./axon), [`synapse/`](./synapse), [`cortex/`](./cortex), [`lion/`](./lion), [`cerebel/`](./cerebel), [`ganglion/`](./ganglion), [`amygdala/`](./amygdala), [`dashboard/`](./dashboard).

### Opt-in usage

NERVous components are designed to be opt-in: when loaded, their prompt guidance tells the agent to use or mention them only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests. The CORTEX package also ships a `/nervous` prompt template for explicit activation:

```text
/nervous implement this feature with durable planning and worker delegation
```

For a read-only state browser, install/load the dashboard package and run:

```text
/nervous:dashboard
```

The dashboard opens a modal overlay with tabs for CORTEX, MAGI, AXON, SYNAPSE, LION, CEREBEL, GANGLION, and AMYGDALA; use arrow keys/tab to navigate, enter for details, `r` to refresh, and `q`/escape to close.

## Why pi packages?

Each NERVous component is a pi package (TypeScript extension loaded via jiti, plus optional skills/prompts/themes). This gives every component: lifecycle hooks, custom tools/commands, session persistence, subagent subprocess capabilities, and distribution via `pi install`. Components compose by reading shared durable state (AXON) and transient notes (SYNAPSE).
