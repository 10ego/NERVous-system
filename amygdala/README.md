# @nervous-system/amygdala

> **AMYGDALA** — risk escalation and safety triage layer for the NERVous System.

AMYGDALA captures blockers, unsafe operations, failed orchestration, and uncertainty as durable incidents. It recommends whether to continue, retry, pause, replan, convene MAGI, request human review, or stop.

Durable state: `<cwd>/.pi/amygdala/amygdala.json`.

---

## Tool actions

| Action | Purpose |
|--------|---------|
| `assess` | Create/triage a risk incident |
| `update` | Edit severity/category/recommendation/mitigation |
| `set_status` | open/acknowledged/mitigating/resolved/accepted/escalated/cancelled |
| `add_note` | Add mitigation/progress note |
| `resolve` | Mark resolved |
| `accept` | Accept residual risk |
| `get` | Show one incident |
| `list` | List incidents with filters |
| `summary` | Risk summary |
| `delete` | Delete incident |

Example:

```text
amygdala assess \
  source="cerebel" source_id="wave-001" \
  description="LION blocked: task requires deleting production data and exposes auth token"
```

AMYGDALA will infer severity/category/recommendation unless explicitly provided.

---

## Heuristic triage

- security/credentials/data loss/policy → usually `critical` + `human_review`
- blocker → `high` + `pause`
- scope/uncertainty/architecture → `convene_magi`
- regression → `replan`
- dependency failure → `retry`

---

## Storage & durability

| Aspect | Behavior |
|--------|----------|
| Location | `<cwd>/.pi/amygdala/amygdala.json` (override with `AMYGDALA_PATH`) |
| Atomicity | Write to `amygdala.json.tmp` then rename |
| Backup | Previous file copied to `amygdala.json.bak` |
| Concurrency | Advisory lock (`amygdala.json.lock`) with stale-lock detection |
| Corruption | Corrupt file copied aside (`.corrupt-<ts>`) and fresh ledger started |

---

## Relationship to NERVous

- **AXON**: mark blocked/needs_amygdala tasks.
- **CEREBEL**: escalates blocked waves.
- **LION/GANGLION**: report blockers/failures.
- **MAGI**: deliberates ambiguous/high-level risks.
- **CORTEX**: final verification should ensure unresolved critical risks are handled.

AMYGDALA owns risk state only; it does not execute work.

---

## Test

```bash
npm test
npx vitest run amygdala
AMYGDALA_LIVE=1 npx vitest run amygdala/tests/live.test.ts
```

Live tests default to:

```bash
--provider openai-codex --model gpt-5.5 --thinking low
```
