# NERVous System End-to-End Demo

This directory contains the final deterministic end-to-end flow for the NERVous System.

The demo proves the complete component chain composes correctly without live LLM calls or subprocesses:

```text
User request
  ↓
CORTEX     analyze intent → plan → verify → complete
  ↓
AXON       durable task ledger
  ↓
GANGLION   choose LION slots by capability/capacity
  ↓
CEREBEL    create/dispatch/record orchestration waves
  ↓
LION       simulated worker run reports
  ↕
SYNAPSE    transient started/completed coordination notes
  ↓
AMYGDALA   risk incident triage/resolution
  ↓
CORTEX     final verification against original success criteria
```

## Scenario

The demo request is:

```text
Build a simple todo API with tests.
```

The deterministic flow creates:

- one CORTEX goal with success criteria;
- three AXON tasks:
  - `Implement todo API`
  - `Add API tests`
  - `Document usage`
- a GANGLION with three LION slots:
  - `lion-api`
  - `lion-tests`
  - `lion-docs`
- two CEREBEL waves:
  - wave 1: API + docs
  - wave 2: tests after API dependency completion
- three LION run reports;
- SYNAPSE coordination notes;
- one AMYGDALA risk incident that is resolved;
- final CORTEX verification and completion.

All state is written under a temp project’s `.pi/` directory using the same durable stores the real tools use.

## Run

```bash
npm run test:e2e
```

or directly:

```bash
npx vitest run demo/tests/e2e-flow.test.ts
```

## What the test asserts

The E2E test verifies:

- CORTEX goal reaches `completed`;
- all AXON tasks reach `completed`;
- all LION runs complete;
- both CEREBEL waves complete;
- all GANGLION members are released/available;
- AMYGDALA risk is resolved;
- SYNAPSE captured transient coordination notes;
- every durable `.pi/.../*.json` state file exists.

This is the offline proof that the NERVous architecture works end to end.
