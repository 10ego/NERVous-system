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
| **E2E demo** | Deterministic full-system todo API flow | ✅ [`demo/`](./demo) |

### Execution flow (target)

```
User → CORTEX →(if hard)→ MAGI → CORTEX → AXON → CEREBEL → GANGLION{LION…}
                                              │            ↕ SYNAPSE
                                              └─→ AMYGDALA (on risk)
LIONs complete → update AXON → CEREBEL assigns more → … → CORTEX checks → MAGI final review
```

**Key principle:** AXON is durable state; SYNAPSE is transient coordination. Interrupted work resumes from AXON without the original context window.

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
└── demo/            # ✅ deterministic final end-to-end flow
```

## Getting started

```bash
npm install
npm test                       # run all component + demo tests
npm run test:e2e               # run the deterministic final end-to-end flow

# Try MAGI without installing:
pi -e ./magi/extension/index.ts

# Or install it:
pi install ./magi
```

See component READMEs for usage and architecture: [`magi/`](./magi), [`axon/`](./axon), [`synapse/`](./synapse), [`cortex/`](./cortex), [`lion/`](./lion), [`cerebel/`](./cerebel), [`ganglion/`](./ganglion), [`amygdala/`](./amygdala).

## Why pi packages?

Each NERVous component is a pi package (TypeScript extension loaded via jiti, plus optional skills/prompts/themes). This gives every component: lifecycle hooks, custom tools/commands, session persistence, subagent subprocess capabilities, and distribution via `pi install`. Components compose by reading shared durable state (AXON) and transient notes (SYNAPSE).
