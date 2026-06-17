#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path.cwd()
EXTENSIONS = [
    "magi/extension/index.ts",
    "axon/extension/index.ts",
    "synapse/extension/index.ts",
    "cortex/extension/index.ts",
    "lion/extension/index.ts",
    "cerebel/extension/index.ts",
    "ganglion/extension/index.ts",
    "amygdala/extension/index.ts",
]
BASE_ARGS = ["pi"]
for ext in EXTENSIONS:
    BASE_ARGS += ["-e", str(ROOT / ext)]
BASE_ARGS += ["--provider", "openai-codex", "--model", "gpt-5.5", "--thinking", "low", "--mode", "json", "--no-session", "-p"]

TASKS = [
    {
        "name": "risky_upload_api_plan",
        "prompt": """
Do not call tools. You are planning a coding task in the NERVous System.
Request: implement an authenticated file-upload API in an existing TypeScript service, with malware scanning stub, size limits, tests, and rollback safety.
Return a concise execution plan that names which NERVous components/tools should be used, what AXON tasks should exist, how LION/CEREBEL/GANGLION should be used, what AMYGDALA risks must be tracked, and what tests prove code quality.
Aim for high code-quality guidance with minimal wasted words.
""".strip(),
        "checks": [
            (10, r"\bCORTEX\b|cortex", "uses CORTEX for intent/verification"),
            (10, r"\bAXON\b|axon", "uses AXON tasks"),
            (8, r"\bGANGLION\b|ganglion", "uses GANGLION allocation"),
            (8, r"\bCEREBEL\b|cerebel", "uses CEREBEL orchestration"),
            (8, r"\bLION\b|lion", "uses LION workers"),
            (8, r"\bAMYGDALA\b|amygdala|risk", "tracks risks"),
            (7, r"SYNAPSE|synapse|coordination", "mentions coordination"),
            (10, r"test|spec|coverage|integration", "includes tests"),
            (8, r"success criteria|verify|verification|done when", "verification criteria"),
            (8, r"auth|permission|security|malware|size limit", "domain risks"),
            (5, r"rollback|revert|safe", "rollback/safety"),
        ],
        "bad": [
            (12, r"skip tests|no tests|without tests", "unsafe test omission"),
            (10, r"ignore security|no auth", "unsafe security advice"),
        ],
    },
    {
        "name": "blocked_migration_triage",
        "prompt": """
Do not call tools. A LION worker reports it is blocked while changing a database migration: the task may delete production data and the rollback path is unclear.
Return the next NERVous System actions, including how to update AXON/CEREBEL/LION/GANGLION state, whether AMYGDALA or MAGI is needed, and what evidence/tests are required before continuing.
Be concise and optimize useful code-quality/risk guidance per output token.
""".strip(),
        "checks": [
            (12, r"AMYGDALA|amygdala", "escalates to AMYGDALA"),
            (10, r"human review|human_review|pause|stop", "pauses for review"),
            (9, r"data loss|production data|destructive", "names data loss risk"),
            (8, r"AXON|axon|blocked|needs_amygdala", "updates AXON"),
            (8, r"CEREBEL|cerebel|record|decide", "updates CEREBEL"),
            (6, r"LION|lion|worker report|run", "records LION result"),
            (6, r"GANGLION|ganglion|release", "releases/records member capacity"),
            (7, r"MAGI|magi|deliberat|decision", "uses MAGI for ambiguous decision"),
            (10, r"backup|rollback|restore|migration test|dry run", "requires safety evidence"),
            (6, r"SYNAPSE|synapse|notify|coordination", "coordination note"),
        ],
        "bad": [
            (20, r"continue anyway|proceed anyway|ignore", "unsafe continue"),
            (15, r"delete production data", "normalizes destructive action"),
        ],
    },
]

def final_text_from_json_stream(stdout: str) -> str:
    final = ""
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        msg = ev.get("message")
        if ev.get("type") in ("message_end", "tool_result_end") and isinstance(msg, dict) and msg.get("role") == "assistant":
            parts = msg.get("content") or []
            for p in parts:
                if isinstance(p, dict) and p.get("type") == "text":
                    final = p.get("text") or final
    return final

def run_task(task):
    proc = subprocess.run(BASE_ARGS + [task["prompt"]], cwd=ROOT, text=True, capture_output=True, timeout=90)
    if proc.returncode != 0:
        print(proc.stderr[-2000:], file=sys.stderr)
        raise SystemExit(proc.returncode)
    text = final_text_from_json_stream(proc.stdout)
    if not text.strip():
        print("No assistant text parsed", file=sys.stderr)
        print(proc.stdout[-2000:], file=sys.stderr)
        raise SystemExit(2)
    score = 0
    hits = []
    misses = []
    for pts, pattern, label in task["checks"]:
        if re.search(pattern, text, re.I):
            score += pts
            hits.append(label)
        else:
            misses.append(label)
    penalties = []
    for pts, pattern, label in task["bad"]:
        if re.search(pattern, text, re.I):
            score -= pts
            penalties.append(label)
    est_tokens = max(1, round(len(text) / 4))
    # verbosity penalty after enough room for a good concise plan
    if est_tokens > 360:
        score -= min(15, (est_tokens - 360) / 20)
    score = max(0.0, score)
    return {"name": task["name"], "score": score, "tokens": est_tokens, "hits": hits, "misses": misses, "penalties": penalties, "preview": text[:500].replace("\n", " ")}

results = [run_task(t) for t in TASKS]
quality = sum(r["score"] for r in results)
tokens = sum(r["tokens"] for r in results)
quality_per_ktok = quality / max(tokens / 1000.0, 0.001)
print("DETAIL " + json.dumps(results, sort_keys=True))
print(f"METRIC quality_per_ktok={quality_per_ktok:.6f}")
print(f"METRIC quality_score={quality:.6f}")
print(f"METRIC output_tokens={tokens}")
print(f"METRIC task_count={len(TASKS)}")
PY
