# @nervous-system/magi

> **MAGI** — a configurable deliberation council (at most 3 councillors) for the [NERVous System](../README.md). Default council: **The Mind**, **The Heart**, **The Hand**.

MAGI convenes a small council of distinct personas to deliberate a hard, ambiguous, risky, or architecturally significant decision. Each councillor reasons independently, they (optionally) critique one another, and a synthesizer (The Hand by default) produces a single, actionable recommendation. **MAGI advises only — it never executes work.** CORTEX (or the main agent) converts the recommendation into a plan.

This is a self-contained [pi](https://pi.dev) package: an extension (tool + commands), a skill, a prompt template, and bundled council configs.

---

## Install

### Try it without installing

```bash
pi -e ./magi/extension/index.ts
```

### Install as a pi package (local path)

```bash
pi install ./magi                 # user scope (~/.pi/agent)
pi install ./magi -l              # project scope (.pi)
```

Or add to `settings.json`:

```json
{ "packages": ["./magi"] }
```

The package manifest (`magi/package.json` → `pi`) registers the extension, skill, and prompt template automatically.

---

## Usage

### 1. The `magi` tool (preferred, LLM-callable)

```text
Use the magi tool to decide whether to adopt a monorepo.
  issue: "Adopt a monorepo for services A and B?"
  context: "shared types, two deployable services"
  constraints: ["must not block next release"]
  options: ["polyrepo", "monorepo"]
  council: "default"          # optional
  critique: true              # optional
```

Parameters:

| Param | Required | Description |
|-------|----------|-------------|
| `issue` | yes | The decision to deliberate. |
| `context` | no | Background / current state. |
| `constraints` | no | Hard constraints. |
| `decision_needed` | no | The specific decision MAGI must recommend. |
| `options` | no | Candidate options to evaluate. |
| `council` | no | `"default"` \| `"two"` \| `"one"`, a config name, a path, or inline JSON. |
| `critique` | no | Run the cross-critique round (default on for 2+ councillors). |

### 2. Commands

- **`/magi <issue>`** — convene the default council and display the result.
- **`/magi:council`** — show the active council configuration and where it was resolved from.

### 3. Prompt template

- **`/deliberate <issue>`** — convene MAGI **via the tool** and then act on the recommendation (triggers an agent turn).

### 4. Skill

The `magi` skill is auto-discovered and tells the agent when/how to convene the council (progressive disclosure). Force-load it with `/skill:magi`.

---

## Output contract

MAGI returns a structured object (the tool returns this as `details`; the text content is a markdown summary):

```json
{
  "council_used": ["mind", "heart", "hand"],
  "individual_opinions": [
    { "councillor": "mind", "position": "...", "concerns": ["..."], "recommendation": "...",
      "critiques": [ { "of": "heart", "note": "..." } ] }
  ],
  "points_of_agreement": ["..."],
  "points_of_disagreement": ["..."],
  "risks": ["..."],
  "rejected_options": ["..."],
  "final_recommendation": "A single, actionable recommendation.",
  "confidence": "low | medium | high",
  "meta": { "critique_used": true, "synthesizer": "hand", "rounds": 3, "warnings": [] }
}
```

---

## Configuration

The councillor JSON config is the single source of truth. **Councils may have 1–3 councillors; configurations with more than 3 are rejected.**

A councillor:

```json
{
  "id": "mind",
  "name": "The Analytical Critic",
  "symbol": "The Mind",
  "archetype": "Exacting Realist / Devil's Advocate",
  "core_trait": "Uncompromising, hyper-precise, and emotionally detached.",
  "role": "Strips away emotion to dissect the cold facts ...",
  "danger_prevented": "Groupthink, blind optimism, and sloppy execution.",
  "system_prompt": "(optional) full persona override",
  "model": "(optional) claude-sonnet-4-5",
  "tools": ["read", "grep", "find", "ls"]
}
```

If `system_prompt` is omitted, the persona prompt is generated from the structured fields. The council object may also set `synthesizer` (councillor id; default `hand` if present), `critique` (default on for ≥2), and `synthesis_model`.

### Shared NERVous model defaults

Explicit council model fields still win. Otherwise, MAGI uses `models.magi.default` from the shared NERVous config (`~/.pi/agent/nervous.json`, overlaid by trusted `<repo>/.pi/nervous.json`) for councillors and synthesis. If it is unset, `models.magi.fallback` is used instead. If both are unset, MAGI preserves the previous behavior and passes no `--model`.

```text
/nervous:config magi_model=provider/balanced magi_fallback_model=provider/strong:high
/nervous:config magi_model=unset magi_fallback_model=unset
```

**Resolution order** (first match wins):

1. Explicit `council` argument (preset name / inline JSON / file path)
2. Project config: `<cwd>/.pi/magi/council.json`
3. User config: `~/.pi/agent/magi/council.json`
4. Bundled default: `magi/config/council.default.json`

Bundled presets: `config/council.default.json` (Mind+Heart+Hand), `config/council.two.json` (Mind+Hand), `config/council.one.json` (Mind only).

---

## Architecture

```
magi/
├── extension/
│   ├── index.ts        # entry: registers magi tool + /magi, /magi:council commands
│   ├── schema.ts       # types + TypeBox schemas (Councillor, CouncilConfig, MagiInput/Output)
│   ├── config.ts       # defaults, validation (max-3), resolution  (pure)
│   ├── council.ts      # prompt building + deliberation flow + JSON coercion  (pure)
│   ├── subprocess.ts   # production GenerateFn: headless pi subprocess per call
│   └── render.ts       # TUI rendering + summaries (pi-tui isolated here)
├── config/             # bundled council presets
├── skills/magi/        # SKILL.md (progressive disclosure)
├── prompts/            # /deliberate prompt template
└── tests/              # config, council, subprocess, extension smoke, live (gated)
```

**Design principle:** the deliberation core (`council.ts`) is pure and takes an injectable `GenerateFn`, so it is fully unit-tested with stub generators. The production runner (`subprocess.ts`) spawns a headless `pi` process per councillor (one isolated context each), mirroring the proven subagent pattern. This makes MAGI genuinely multi-agent while keeping the logic testable.

**Deliberation flow:** independent opinions (parallel) → optional cross-critique (parallel) → synthesis (The Hand) → `MagiOutput`.

---

## Develop & test

```bash
npm install
npm test                       # unit + smoke tests (no LLM calls)
MAGI_LIVE=1 npx vitest run magi/tests/live.test.ts   # real end-to-end (spawns pi, costs tokens)
```

The live test uses a 1-councillor council on a cheap model (`MAGI_LIVE_MODEL`, default `claude-haiku-4-5`). 35 tests pass offline; 1 live test is gated behind `MAGI_LIVE=1`.

---

## Relation to NERVous

Per the system design, **MAGI is called by CORTEX** for hard/ambiguous/risky/architectural decisions and for final review. Until CORTEX exists, the `magi` tool can be invoked by the main agent directly. MAGI's output (`final_recommendation`, `risks`, `rejected_options`) is exactly what CORTEX converts into an AXON execution plan.
