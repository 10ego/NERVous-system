# NERVous prompts vs. raw LLM baseline

[Documentation index](README.md)

A small deterministic benchmark compares GPT 5.5 low-thinking output with and without the NERVous extension prompt and tool surfaces loaded. The tasks ask for concise coding-orchestration guidance for a risky authenticated file-upload API and a blocked data-loss migration handoff.

| Setup | Quality / 1k output tokens | Raw quality score | Output tokens |
|-------|----------------------------|-------------------|---------------|
| Raw GPT 5.5 low, no NERVous extensions | 64.84 | 121 | 1,866 |
| GPT 5.5 low + NERVous extensions | **79.72** | 127 | 1,593 |

On this benchmark, the NERVous prompt and tool surfaces improved useful guidance density by about **23%** versus the raw model. The main observed gains were more reliable component routing, durable state and coordination coverage, and safer blocked-work triage.

> This is a focused regression benchmark, not a universal model leaderboard. It measures rubric-scored guidance density for representative NERVous coding workflows.
