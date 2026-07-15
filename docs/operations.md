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

## Invocation gating, suite enablement, drain, risk gates, and model defaults

When the suite is enabled, its extensions remain loaded but all eight model-callable NERVous tools are inactive in a fresh session chain. The root `/nervous [request]` extension command waits for any streaming run to become idle and verifies Pi's effective file-backed native auto-retry setting before activation. If retry is disabled, unreadable, or has `maxRetries < 1`, it starts no workflow, activates no tools, and writes no branch marker; enable retry with at least one attempt in Pi settings and rerun `/nervous`. Once preflight passes, the command enables only the NERVous subset allowed by the initial active-tool configuration, records an activation marker on the current branch, and dispatches the bundled workflow prompt. Later turns and resumed sessions on that branch remain activated; navigating to a branch before the marker removes only NERVous tools.

A tool-call guard rejects all component calls in a fresh chain and rejects operator-excluded components in an activated chain, even if another extension makes them visible. The controller does not restore a whole-tool-set snapshot, so unrelated tool changes and revocations made after activation survive.

Pi owns transport retry classification, backoff, attempt limits, and cancellation. If an active NERVous workflow still ends on a transient transport failure, the controller waits for Pi's `agent_settled` event and posts a visible pause notice without starting another model turn. Run `/nervous:resume` to continue explicitly; its recovery prompt first reconciles durable CORTEX, AXON, CEREBEL, and LION state so committed work and active workers are not duplicated. A successful native retry clears the pending notice, while disabled, exhausted, or cancelled retry ends at the manual release valve. NERVous does not modify Pi's persistent retry setting.

This invocation gate is separate from package enablement. Keep NERVous installed while removing its component runtime surface with `/nervous:config enabled=false`. Pi reloads the current session without the component tools, workflow commands, skills, and prompts. The always-loaded controller retains `/nervous:config` and an inert `/nervous` command that reports the disabled configuration. Run `enabled=true` to reload the resources; fresh chains return to their gated state, while a branch carrying an activation marker resumes the coordinated workflow. The user-level setting is persistent and defaults to enabled; Pi's trusted project package settings still determine which package resources apply in that repository.

CORTEX drain mode can keep progressing through the active context while preserving durable evidence for work that cannot proceed yet. Configure when drain runs separately from how risky work is authorized, and optionally set default models for NERVous subprocess systems:

```text
/nervous:config                                                       # open TUI settings menu; selected values apply immediately
/nervous:config enabled=false                                         # disable the suite and reload; config command remains available
/nervous:config enabled=true                                          # enable the suite and reload
/nervous:config show                                                  # show persistent defaults as markdown
/nervous:config drain=always risk=auto_deliberate                     # set defaults used by /nervous
/nervous:config max_parallel=6                                        # default concurrent LIONs for new CEREBEL waves (1-10)
/nervous:config lion_implementation_model=provider/fast lion_review_model=provider/strong # set LION role model defaults
/nervous:config lion_review_model=unset                               # clear a model default back to pi default
/nervous risk=user_accepted implement the migration                   # apply drain/risk tokens for one invocation
```

`auto_deliberate` is the default and proceeds only with recorded MAGI or AMYGDALA approval evidence. `strict` always blocks hard-stop risk for review, `user_accepted` requires scoped user acceptance evidence, and `disabled` requires an explicit dangerous opt-in plus audit evidence.

Suite enablement and CEREBEL's `max_parallel` default are stored at user scope in `~/.pi/agent/nervous.json`; missing values default to `true` and `3`, respectively. Model defaults use that same file with the trusted project overlay `.pi/nervous.json`. Unset model keys preserve the current behavior: NERVous passes no `--model`, so pi uses the session or default model.

Failed work is recorded with retryability through `cortex record_failure`. Skipped or blocked work gets `next_revisit_at` metadata and can be returned to the workflow with `cortex reopen` after resolution.

## Compatibility and limitations

The settled transport pause requires Pi 0.80.7 or newer for the extension-facing `agent_settled` lifecycle event.

The workspace is released as one version-aligned distribution. See [RELEASES.md](../RELEASES.md) for the 1.x compatibility commitment, clean-slate state policy, and known architectural limitations.
