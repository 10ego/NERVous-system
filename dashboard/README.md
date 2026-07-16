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
- `r` — manually reload state from disk
- `q` / `esc` — close dashboard

While open, the dashboard resolves component state paths once, checks their file fingerprints after about one second, and reloads only the component ledgers whose fingerprints changed. Unchanged checks back off adaptively to eight seconds; a detected change resets the interval. Dashboard-level failed reloads remain dirty and retry on the next interval, while changes detected during an in-flight reload are latched for one follow-up reload. Manual `r` remains immediate, and tab, selection, and detail state are preserved across refreshes.

The dashboard reads component state through existing store APIs and does not mutate state. It can display empty tabs when a component has not yet produced persisted state. If one component rejects its persisted schema, that tab is cleared and a bounded warning is shown while healthy components remain available; the rejected file is left untouched until it changes or the operator resets it. Use `/nervous:state` to inspect the namespace and `/nervous:reset` to archive the whole cross-referenced context before starting clean. Set `NERVOUS_CONTEXT=<work-id>` before launching pi to view, resume, or reset a specific work context.

LION progress is read from the optional bounded `LionRun.progress` snapshot written by recent LION runs. Older runs without snapshots remain visible with a fallback message, and running/queued snapshots older than the staleness threshold are labeled as stale. CEREBEL wave details summarize linked LION run status/progress but do not dispatch, cancel, steer, or notify workers.
