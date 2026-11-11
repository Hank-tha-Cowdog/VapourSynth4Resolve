#!/usr/bin/env python3
"""Per-filter QUALIFICATION harness — ISOLATED subprocess evaluation.

Each candidate runs in its OWN python subprocess (30s-capped): a plugin that
crashes the process (observed: dfttest2_gcc SIGABRT) is recorded as CRASH
and cannot take the harness down, block other candidates, or hang the
session. The parent merges per-candidate JSON results.

Measures: combing signature (d1/d2), HF/vertical energy (d2), Laplacian
sharpness band. Fixtures (tests/fixtures, deterministic ProRes): motion,
noise, interlaced. Passthrough check: same-format/dims ⇒ output must
differ from input. Exit 0 iff every candidate passes its assertions.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = "/opt/homebrew/opt/python@3.14/bin/python3.14"
CHILD = os.path.join(HERE, "qualify_one.py")

CANDIDATES = {
    # spatial denoise — noise fixture
    "bm3dmetal": {"fixture": "noise"},
    "dfttest": {"fixture": "noise"},
    "nlm_ispc": {"fixture": "noise"},
    "wnnm": {"fixture": "noise"},
    # temporal denoise — flicker fixture (temporal metrics in child)
    "ttmpsm": {"fixture": "flicker"},
    "focus2_temporal": {"fixture": "flicker"},
    "zsmooth_temporal": {"fixture": "flicker"},
    # deband / deblock
    "neo_f3kdb": {"fixture": "noise"},
    "deblock": {"fixture": "noise"},
    # sharpen
    "cas": {"fixture": "motion"},
    "asharp": {"fixture": "motion"},
    "warp_awarpsharp2": {"fixture": "motion"},
    # field ops
    "sangnom": {"fixture": "interlaced"},
    "eedi2": {"fixture": "interlaced"},
    "eedi3": {"fixture": "interlaced"},
    # restore
    "lghost": {"fixture": "motion"},
    "tcomb": {"fixture": "interlaced"},
    "rdvs_restore": {"fixture": "interlaced"},
    # chroma / levels
    "smoothuv": {"fixture": "interlaced"},
    "tweak": {"fixture": "motion"},
    # interpolation / scaling / diagnostics
    "mv_blockfps": {"fixture": "motion"},
    "nnedi3_upscale": {"fixture": "motion"},
    "descale_debicubic": {"fixture": "motion"},
    "text_clipinfo": {"fixture": "motion"},
    "scdetect": {"fixture": "motion"},
}

results = {}
t_all = time.time()
for name, spec in sorted(CANDIDATES.items()):
    t0 = time.time()
    try:
        proc = subprocess.run(
            [PY, CHILD, name, spec["fixture"]],
            capture_output=True, text=True, timeout=45)
        lines = [l for l in (proc.stdout or "").splitlines() if l.startswith("{")]
        if not lines:
            results[name] = {"status": "CRASH" if proc.returncode != 0 else "FAIL",
                              "why": ((proc.stderr or "") or proc.stdout or "no output").strip()[:240]}
        else:
            results[name] = json.loads(lines[-1])
    except subprocess.TimeoutExpired:
        results[name] = {"status": "TIMEOUT", "why": "exceeded 45s evaluation bound"}
    except Exception as e:
        results[name] = {"status": "FAIL", "why": str(e)[:200]}
    results[name]["secs"] = round(time.time() - t0, 1)
    r = results[name]
    note = r.get("why") or r.get("note") or ""
    print(f"{r['status']:12s} {name:20s} {note[:62]}")

fails = [k for k, v in results.items() if not v.get("status", "").startswith("PASS")]
os.makedirs(os.path.join(HERE, "..", "tests", "results"), exist_ok=True)
with open(os.path.join(HERE, "..", "tests", "results", "qualify_filters.json"), "w") as f:
    json.dump({"ok": not fails, "results": results}, f, indent=1)
print()
print(json.dumps({"ok": not fails, "total": len(results),
                  "passed": len(results) - len(fails), "failed": fails,
                  "secs": round(time.time() - t_all, 1)}, ensure_ascii=False))
sys.exit(0 if not fails else 1)