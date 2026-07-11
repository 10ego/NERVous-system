# NERVous System

A durable multi-agent orchestration and coding-agent coordination framework for [pi](https://pi.dev). NERVous System helps coding agents **plan, delegate, coordinate, execute, recover from interruptions, and review** work continuously.

**You can just give it a task description and walk away.**

Find it in the [pi package directory](https://pi.dev/packages) by searching for **multi-agent orchestration**, **coding-agent coordination**, **subagent delegation**, **durable task planning**, **workflow recovery**, or **risk triage**.

## Quick start

```bash
pi install npm:nervous-system
```

Then start a durable workflow:

```text
/nervous implement this feature with durable planning and worker delegation
```

NERVous installs the complete suite: CORTEX, MAGI, AXON, SYNAPSE, LION, CEREBEL, GANGLION, AMYGDALA, and the dashboard.

## Highlights

- Durable goals and task state that survive compaction, restarts, and interruptions
- Deliberation, risk triage, and explicit verification for difficult work
- Parallel coding subagents with orchestration, capacity allocation, and live progress
- Project- and context-isolated state with a read-only dashboard

## Documentation

| Guide | Contents |
|-------|----------|
| [Documentation index](docs/README.md) | Suggested reading paths and all guides |
| [Getting started](docs/getting-started.md) | Installation, first use, updates, removal, and local development |
| [Architecture](docs/architecture.md) | Components, execution flow, repository layout, and package design |
| [Operations](docs/operations.md) | Worker controls, dashboard, state isolation, and configuration |
| [Benchmark](docs/benchmark.md) | NERVous prompts compared with a raw LLM baseline |
| [Release policy](RELEASES.md) | Version compatibility, state policy, and known limitations |

> **Status:** The complete core component set and deterministic end-to-end demo are implemented and tested.
