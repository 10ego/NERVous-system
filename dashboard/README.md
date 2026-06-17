# NERVous Dashboard

Read-only pi TUI dashboard for NERVous runtime state.

## Command

```text
/nervous:dashboard
```

Opens a centered modal overlay with tabs for:

- **CORTEX** — goals, status, success criteria, risks, MAGI usage, AXON links, verification.
- **MAGI** — recorded consultations, councillor opinions/critiques, agreement/disagreement, risks, final resolution.
- **AXON** — tasks, status, priority, assignment, blockers, notes, artifacts.
- **SYNAPSE** — transient coordination notes.
- **LION** — worker runs/subagents, status, linked AXON task, reports, blockers, tests, next steps.
- **CEREBEL** — orchestration waves, assignments, decisions.
- **GANGLION** — rosters, member status/capabilities, allocations.
- **AMYGDALA** — risk incidents, severity, recommendations, mitigation notes.

MAGI history is recorded for successful future `magi` tool calls and `/magi` commands in `.pi/magi/history.json`; older deliberations from before this feature may not appear unless referenced from CORTEX.

## Keys

- `tab` / `←` / `→` — switch system tabs
- `↑` / `↓` — move selection
- `enter` — open selected item details
- `esc` / `backspace` — close details
- `r` — reload AXON/LION state from disk
- `q` / `esc` — close dashboard

The dashboard reads component state through existing store APIs and does not mutate state. It can display empty tabs when a component has not yet produced persisted state.
