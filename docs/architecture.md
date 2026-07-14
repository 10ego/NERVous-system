# Architecture

[Documentation index](README.md)

NERVous System is a version-aligned collection of pi packages that share durable and transient state to coordinate coding work.

## Components

| Component | Role | Documentation |
|-----------|------|---------------|
| **CORTEX** | Main reasoning core: intent, planning, and verification | [README](../cortex/README.md) |
| **MAGI** | Configurable deliberation council with up to three councillors | [README](../magi/README.md) |
| **AXON** | Persistent task ledger that survives compaction and restart | [README](../axon/README.md) |
| **CEREBEL** | Orchestration controller for LION worker waves | [README](../cerebel/README.md) |
| **LION** | Isolated coding subagent with durable live progress telemetry | [README](../lion/README.md) |
| **GANGLION** | Working-group roster and capability allocator for LIONs | [README](../ganglion/README.md) |
| **SYNAPSE** | Transient shared coordination scratchpad | [README](../synapse/README.md) |
| **AMYGDALA** | Risk escalation and safety triage | [README](../amygdala/README.md) |
| **Dashboard** | Read-only TUI modal for NERVous state | [README](../dashboard/README.md) |
| **State** | Shared global project/context state resolver | — |
| **E2E demo** | Deterministic full-system todo API flow | [README](../demo/README.md) |

## Execution flow

```text
User → CORTEX frame once → analyze →(if hard)→ MAGI → CORTEX plan → AXON → CEREBEL → GANGLION{LION…}
                                                               │            ↕ SYNAPSE
                                                               └─→ AMYGDALA (on risk)
LIONs complete → update AXON → CEREBEL assigns more → … → CORTEX checks → MAGI final review
```

**Key principle:** CORTEX frames an abstract request once before durable analysis and reuses that brief on resume or replan; AXON is durable task state; SYNAPSE is transient coordination. Interrupted work resumes without repeating discovery or requiring the original context window.

LION keeps lifecycle authority singular: canonical `runs.json` owns run existence, immutable incarnation, active/terminal status, control, and final output. Newly executed exact incarnations may have an adjacent bounded latest-progress sidecar, but it is only an active-run read overlay and local open/closed stale-writer fence. Progress flushes and terminal folds share the canonical namespace lock; terminal canonical state always wins.

## Repository layout

Each component is an independent, installable pi package so it can be used and shipped separately:

```text
nervous-system/
├── magi/            # MAGI deliberation council (extension + skill + prompts + config + tests)
├── axon/            # AXON durable task ledger (extension + skill + config + tests)
├── synapse/         # SYNAPSE transient coordination scratchpad (extension + skill + tests)
├── cortex/          # CORTEX main reasoning core: goals + workflow (extension + skill + prompt + tests)
├── lion/            # LION isolated pi coding subagent worker (extension + skill + prompt + tests)
├── cerebel/         # CEREBEL orchestration controller for LION waves (extension + skill + prompt + tests)
├── ganglion/        # GANGLION LION roster + capability allocator (extension + skill + prompt + tests)
├── amygdala/        # AMYGDALA risk escalation + safety triage (extension + skill + prompt + tests)
├── dashboard/       # read-only TUI dashboard for all NERVous system state
├── state/           # shared global project/context state resolver
└── demo/            # deterministic final end-to-end flow
```

## Component documentation

- [MAGI](../magi/README.md)
- [AXON](../axon/README.md)
- [SYNAPSE](../synapse/README.md)
- [CORTEX](../cortex/README.md)
- [LION](../lion/README.md)
- [CEREBEL](../cerebel/README.md)
- [GANGLION](../ganglion/README.md)
- [AMYGDALA](../amygdala/README.md)
- [Dashboard](../dashboard/README.md)
- [End-to-end demo](../demo/README.md)

## Why pi packages?

Each NERVous component is a pi package: a TypeScript extension loaded via jiti, plus optional skills, prompts, and themes. This gives every component lifecycle hooks, custom tools and commands, session persistence, subagent subprocess capabilities, and distribution through `pi install`.

The root package's always-loaded controller is also an activation boundary. In a fresh session chain it removes the root suite's model tools from Pi's active set. The exact user/RPC `/nervous` extension command waits for an existing run to finish, activates only the operator-permitted component subset, and persists authorization on the current session branch. Descendant turns and resumed sessions retain coordinated access; branches before the marker remain inactive. A `tool_call` hook blocks unauthorized or operator-excluded component calls, and branch transitions mutate only NERVous tools so unrelated capability changes survive. Standalone component packages do not load this root controller and therefore retain their independent behavior.

Components compose by reading shared durable state in AXON and transient notes in SYNAPSE. The workspace is released as one version-aligned distribution; see the [release policy](../RELEASES.md) for the 1.x compatibility and clean-slate state policy.
