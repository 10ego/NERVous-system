# NERVous prompts vs. raw LLM baseline

[Documentation index](README.md)

A small deterministic benchmark compares GPT 5.5 low-thinking output with and without the NERVous extension prompt and tool surfaces loaded. The tasks ask for concise coding-orchestration guidance for a risky authenticated file-upload API and a blocked data-loss migration handoff.

| Setup | Quality / 1k output tokens | Raw quality score | Output tokens |
|-------|----------------------------|-------------------|---------------|
| Raw GPT 5.5 low, no NERVous extensions | 64.84 | 121 | 1,866 |
| GPT 5.5 low + NERVous extensions | **79.72** | 127 | 1,593 |

On this benchmark, the NERVous prompt and tool surfaces improved useful guidance density by about **23%** versus the raw model. The main observed gains were more reliable component routing, durable state and coordination coverage, and safer blocked-work triage.

> This is a focused regression benchmark, not a universal model leaderboard. It measures rubric-scored guidance density for representative NERVous coding workflows.

## LION progress persistence scaling gate

The deterministic LION storage benchmark builds a small and a 600-run historical canonical ledger, starts one exact-incarnation worker in each, resets operation counters, and flushes one bounded progress snapshot:

```bash
npm run benchmark:lion-progress
```

The merge gate asserts for both ledger sizes:

- `canonical_reads`, `canonical_parses`, `canonical_backups`, `canonical_serializations`, and `canonical_writes` are all zero during the flush;
- canonical bytes read/written are zero;
- sidecar bytes written remain at most two bounded envelopes (primary plus one backup), independent of `runs.json` size.

This instrumentation is the stable complexity proof; wall-clock timing is intentionally not used as the primary assertion because filesystem scheduling is noisy.
