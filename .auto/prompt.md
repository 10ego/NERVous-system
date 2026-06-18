# Autoresearch: GPT 5.5 Low Code-Quality Output per Token

## Objective
Optimize the NERVous System pi package prompt/tooling surfaces so a cheap/low-thinking GPT-family model (`openai-codex` provider, `gpt-5.5`, `--thinking low`) produces higher-quality coding/orchestration guidance per output token. The target is not raw verbosity; it is concise, correct, risk-aware guidance that uses the right NERVous components for multi-agent coding work.

## Metrics
- **Primary**: `quality_per_ktok` (unitless, higher is better) — deterministic rubric quality points divided by estimated output tokens / 1000.
- **Secondary**:
  - `quality_score` — total rubric points across fixed benchmark prompts.
  - `output_tokens` — approximate output tokens (`chars/4`) across benchmark prompts.
  - `task_count` — benchmark prompt count.

## How to Run
`./.auto/measure.sh` — runs real `pi` invocations using `--provider openai-codex --model gpt-5.5 --thinking low`, loads all NERVous extensions, asks representative orchestration/code-quality prompts, scores the final assistant text, and emits `METRIC name=value` lines.

## Files in Scope
You may modify generic prompt/tooling surfaces and docs that influence model behavior:
- `*/extension/index.ts` — tool descriptions and prompt guidelines.
- `*/skills/*/SKILL.md` — workflow instructions and role guidance.
- `*/prompts/*.md` — prompt templates.
- README/demo docs only if they materially improve package usability.

You may also make small schema/render/store fixes if a benchmark/check uncovers a real bug, but the main target is quality-per-token of model guidance.

## Off Limits
- Do not edit `.auto/measure.sh` to make the benchmark easier after baseline unless adding neutral diagnostics; do not change scoring to favor a specific experiment.
- Do not hardcode benchmark answers or benchmark prompt text into package prompts.
- Do not remove important safety/risk guidance just to reduce tokens.
- Do not bypass tests/checks or disable tools to inflate the metric.
- Do not change package behavior in a way that breaks independent installability.

## Constraints
- Use `openai-codex` / `gpt-5.5` / `--thinking low` as the test model.
- Optimize for robust code-quality/orchestration guidance, not benchmark overfitting.
- Keep all TypeScript packages typechecking.
- Full offline test suite must pass for kept changes.
- Be careful not to overfit to the benchmark prompts and do not cheat on benchmarks.

## Benchmark Design
The benchmark intentionally uses multiple representative prompts:
1. Planning a risky authenticated file-upload API implementation.
2. Handling a blocked migration/data-loss LION result.

The rubric rewards concise answers that use the correct NERVous components, include concrete tests/success criteria, identify risks, and avoid unsafe advice. It penalizes dangerous recommendations and excessive verbosity.

## What's Been Tried
- Baseline pending.
