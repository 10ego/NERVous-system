# Operations and configuration

[Documentation index](README.md)

## Live worker controls

- **Telemetry:** LION persists bounded exact-incarnation progress sidecars and emits `nervous:lion:*` lifecycle and progress events; direct LION, CEREBEL, and dashboard reads use the same canonical-authority overlay.
- **Orchestration:** CEREBEL can optionally `run_wave` planned assignments through LION and records grouped outcomes while preserving partial results.
- **Exact provenance:** CEREBEL links and settles exact immutable LION incarnations before cancellation releases GANGLION capacity. RPC `cleanup_pending` runs remain running/dispatched with capacity retained until their process-local owner observes exit and completes late settlement. Incomplete pre-release links require operator delete/reset; provenance is never backfilled.
- **Control:** Cancellation is best-effort, pre-start steering is queued, and RPC live steering requires explicit `runner_mode="rpc"` opt-in. JSON remains the default and rejects running steering.

## Dashboard

Run the read-only state browser with:

```text
/nervous:dashboard
```

The dashboard opens a modal overlay with tabs for CORTEX, MAGI, AXON, SYNAPSE, LION, CEREBEL, GANGLION, and AMYGDALA. Use arrow keys or tab to navigate, enter for details, `r` to refresh, and `q` or escape to close. See the [dashboard documentation](../dashboard/README.md) for implementation details.

## State isolation

NERVous runtime state is global but isolated by project and work context. By default, component ledgers live under:

```text
~/.pi/nervous/<project-slug>-<path-hash>/<context>/<component>/...
```

- **Project namespace** prevents cross-repository contamination. It is derived from the git root path; set `NERVOUS_PROJECT=<name>` to override it.
- **Context namespace** prevents stale completed work from bleeding into a new effort. It defaults to the current git branch, or `default` outside git; set `NERVOUS_CONTEXT=<work-id>` to intentionally start or resume a workstream.
- Set `NERVOUS_STATE_ROOT=/path/to/root` to move all NERVous state elsewhere.
- Existing explicit component paths still win, including `AXON_LEDGER_PATH`, `CORTEX_PATH`, `SYNAPSE_PATH`, `LION_RUNS_PATH`, `CEREBEL_PATH`, `GANGLION_PATH`, `AMYGDALA_PATH`, and `MAGI_HISTORY_PATH`. LION resolves a direct-file symlink override to one canonical operational target so canonical data, the namespace lock, active ownership, and adjacent `runs.json.progress/` sidecars cannot split namespaces. Cleanup supervision is process-local only; after restart, persisted PID/PGID data is observational and never authorizes reattachment or signaling.

Examples:

```bash
# Start a clean, named work context in the current repository
NERVOUS_CONTEXT=upload-api pi

# Resume that same work context later
NERVOUS_CONTEXT=upload-api pi --session <session-id>

# Put all NERVous state under a custom global root
NERVOUS_STATE_ROOT="$HOME/.pi/nervous" pi
```

NERVous does not automatically migrate or delete old repository-local `.pi/` state. If you have existing state you want to keep, copy it into the corresponding global namespace manually. LION also does not backfill sidecars for legacy or null-incarnation runs; their existing inline progress remains readable.

### LION sidecar recovery

`lion/runs.json` is the only lifecycle and identity authority. A progress envelope is visible only when its full namespace/run/incarnation matches an active canonical run. Closed envelopes represent an interrupted terminal fold and remain retryable; terminal canonical records ignore post-commit cleanup orphans. Malformed progress files produce bounded warnings/quarantine and never trigger canonical reset. Cleanup is classification-based: active and unclassifiable files are never removed merely because they are old or storage pressure exists. Run `npm run benchmark:lion-progress` in a source checkout to verify the zero-canonical-I/O flush gate.

## Suite enablement, drain, risk gates, and model defaults

Keep NERVous installed while disabling its runtime surface with `/nervous:config enabled=false`. Pi reloads the current session with every NERVous tool, workflow command, skill, and prompt removed, except for `/nervous:config` itself. Run `enabled=true` to reload with the full suite again. The setting is persistent and defaults to enabled; trusted project config can override user config.

CORTEX drain mode can keep progressing through the active context while preserving durable evidence for work that cannot proceed yet. Configure when drain runs separately from how risky work is authorized, and optionally set default models for NERVous subprocess systems:

```text
/nervous:config                                                       # open TUI settings menu; selected values apply immediately
/nervous:config enabled=false                                         # disable the suite and reload; config command remains available
/nervous:config enabled=true                                          # enable the suite and reload
/nervous:config show                                                  # show persistent defaults as markdown
/nervous:config drain=always risk=auto_deliberate                     # set defaults used by /nervous
/nervous:config lion_implementation_model=provider/fast lion_review_model=provider/strong # set LION role model defaults
/nervous:config lion_review_model=unset                               # clear a model default back to pi default
/nervous risk=user_accepted implement the migration                   # apply drain/risk tokens for one invocation
```

`auto_deliberate` is the default and proceeds only with recorded MAGI or AMYGDALA approval evidence. `strict` always blocks hard-stop risk for review, `user_accepted` requires scoped user acceptance evidence, and `disabled` requires an explicit dangerous opt-in plus audit evidence.

Suite enablement and model defaults are stored in `~/.pi/agent/nervous.json` with the trusted project overlay `.pi/nervous.json`. A missing `enabled` value defaults to `true`. Unset model keys preserve the current behavior: NERVous passes no `--model`, so pi uses the session or default model.

Failed work is recorded with retryability through `cortex record_failure`. Skipped or blocked work gets `next_revisit_at` metadata and can be returned to the workflow with `cortex reopen` after resolution.

## Compatibility and limitations

The workspace is released as one version-aligned distribution. See [RELEASES.md](../RELEASES.md) for the 1.x compatibility commitment, clean-slate state policy, and known architectural limitations.
