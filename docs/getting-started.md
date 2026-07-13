# Getting started

[Documentation index](README.md)

## Install from npm

Install the full NERVous System pi package from npm:

```bash
pi install npm:nervous-system
```

This installs the root pi package and enables all NERVous extensions, skills, and prompt templates: MAGI, AXON, SYNAPSE, CORTEX, LION, CEREBEL, GANGLION, AMYGDALA, and the dashboard.

## Turn the suite on or off

Keep the package installed and use the persistent control command:

```text
/nervous:config enabled=false  # unload the suite and reload the current session
/nervous:config enabled=true   # reload it with the suite enabled again
```

When disabled, NERVous removes its tools, workflow commands, skills, and prompt templates. It leaves only `/nervous:config` available so you can turn it back on. The user-level setting is stored in `~/.pi/agent/nervous.json`; Pi's existing trusted project package settings continue to control which package resources are available per repository.

`pi config` remains an alternative for enabling or disabling individual package resources across any installed pi package.

Verify that pi can see the package:

```bash
pi list
```

## Start a workflow

NERVous components are opt-in. When loaded, their prompt guidance tells the agent to use or mention them only for explicit NERVous, durable-state, orchestration, delegation, coordination, or risk-triage requests. The CORTEX package ships a `/nervous` prompt template for explicit activation:

```text
/nervous implement this feature with durable planning and worker delegation
```

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
