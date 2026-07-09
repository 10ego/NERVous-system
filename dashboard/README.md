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
- **LION** — worker runs/subagents, status, linked AXON task, live progress snapshots, reports, blockers, tests, next steps.
- **CEREBEL** — orchestration waves, assignments, linked LION aggregate progress, decisions.
- **GANGLION** — rosters, member status/capabilities, allocations.
- **AMYGDALA** — risk incidents, severity, recommendations, mitigation notes.

MAGI history is recorded for successful future `magi` tool calls and `/magi` commands in the active global NERVous namespace (`~/.pi/nervous/<project>/<context>/magi/history.json` by default); older deliberations from before this feature may not appear unless referenced from CORTEX.

## Keys

- `tab` / `←` / `→` — switch system tabs
- `↑` / `↓` — move selection
- `enter` — open selected item details
- `esc` / `backspace` — close details
- `r` — reload AXON/LION state from disk
- `q` / `esc` — close dashboard

The dashboard reads component state through existing store APIs and does not mutate state. It can display empty tabs when a component has not yet produced persisted state. Set `NERVOUS_CONTEXT=<work-id>` before launching pi to view or resume a specific work context.

LION progress is read from the optional bounded `LionRun.progress` snapshot written by recent LION runs. Older runs without snapshots remain visible with a fallback message, and running/queued snapshots older than the staleness threshold are labeled as stale. CEREBEL wave details summarize linked LION run status/progress but do not dispatch, cancel, steer, or notify workers.
