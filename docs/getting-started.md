# Getting started

[Documentation index](README.md)

## Install from npm

Install the full NERVous System pi package from npm:

```bash
pi install npm:nervous-system
```

This installs and loads the root pi package resources: MAGI, AXON, SYNAPSE, CORTEX, LION, CEREBEL, GANGLION, AMYGDALA, and the dashboard. The component tools remain inactive and absent from the model's ordinary tool prompt until `/nervous` explicitly activates them.

## Turn the suite on or off

Keep the package installed and use the persistent control command:

```text
/nervous:config enabled=false  # unload the suite and reload the current session
/nervous:config enabled=true   # reload it with the suite enabled again
```

When disabled, NERVous removes its component tools, workflow commands, skills, and prompt templates. The always-loaded controller leaves `/nervous:config` available so you can turn the suite back on; `/nervous` remains as an inert entry point that reports that no component tools are enabled. The user-level setting is stored in `~/.pi/agent/nervous.json`; Pi's existing trusted project package settings continue to control which package resources are available per repository.

`pi config` remains an alternative for enabling or disabling individual package resources across any installed pi package.

Verify that pi can see the package:

```bash
pi list
```

## Start a workflow

NERVous components are runtime-gated. In a fresh session chain, their tools, schemas, snippets, and tool-specific guidelines are removed from Pi's active tool set. The root controller owns an exact interactive/RPC `/nervous` extension command:

```text
/nervous implement this feature with durable planning and worker delegation
```

If another run is already streaming, the command waits for it to become idle before enabling any NERVous capability or dispatching the bundled workflow prompt. It then verifies Pi's native auto-retry setting. When retry is disabled, unreadable, or configured with fewer than one retry attempt, no workflow starts and no activation marker is written; enable retry with `maxRetries >= 1` in Pi settings and rerun `/nervous`. Activation adds only the NERVous tools that were present in the operator's initial active-tool selection; excluded components remain blocked.

For new work, CORTEX first performs one bounded task-framing pass: it inspects relevant project context when useful and makes the objective, scope, non-goals, assumptions, success criteria, candidate options, and any MAGI decision concrete before persisting the goal with `cortex analyze`. It asks for clarification only when ambiguity blocks a responsible goal definition. If analyze reports a missing MAGI framing field, `cortex refine` repairs that same analyzed goal in place before deliberation instead of creating a duplicate. The framing is stored with the goal and is not repeated on resume, retry, revisit, or replan.

Activation is persisted on the current session branch. Later prompts in that chain continue to use the coordinated NERVous workflow, including after resume or compaction. A new session—or tree navigation to a branch before the activation marker—starts with NERVous inactive. Merely mentioning `/nervous`, requesting orchestration in prose, or injecting `/nervous` from another extension does not activate the suite.

Pi owns native transport retries. If a transient transport failure remains when Pi fully settles, NERVous displays a pause notice without starting more work. Run `/nervous:resume` to reconcile durable state and continue explicitly.

A tool-call guard rejects NERVous calls outside an activated chain and rejects configured component exclusions inside one. The controller mutates only NERVous tools when entering or leaving a branch, so unrelated tool changes and lease-time revocations are not overwritten.

For a read-only state browser, run:

```text
/nervous:dashboard
```

See [Operations](operations.md#dashboard) for dashboard controls and [Architecture](architecture.md) for how the components work together.

## Update or remove

Update the package with:

```bash
pi update npm:nervous-system
```

Remove it with:

```bash
pi remove npm:nervous-system
```

## Local development

```bash
git clone git@github.com:10ego/NERVous-system.git
cd NERVous-system
npm install
npm test                       # run all component + demo tests
npm run test:e2e               # run the deterministic final end-to-end flow
npm run test:dashboard         # run dashboard tests
npm run test:state             # run shared state resolver tests

# Load the full suite from this checkout without installing globally:
pi -e .

# Or install this checkout as a local package:
pi install .
```

For package-specific implementation and usage details, follow the component links in [Architecture](architecture.md#component-documentation).
