#!/usr/bin/env python3
"""Capability matrix probe: every REGISTERED namespace with its callable
functions and real signatures, written as JSON. This is the ground truth the
library/harness/snapshot reconcile against — never a hand-curated guess.
Env: same evaluation environment as the chain (user plugin dir + vs-python).
"""
import json
import os
import sys

os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = os.path.expanduser(
    "~/Library/Application Support/VapourSynth/Plugins")
sys.path.insert(0, os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"))
_local = os.path.expanduser(
    "~/development_projects/00_vs_for_resolve/01_codebase/VapourSynth-for-Resolve"
    "/vendor/vapoursynth/install-R75/lib/python3.14/site-packages")
if os.path.isdir(_local):
    sys.path.insert(0, _local)

import vapoursynth as vs  # noqa: E402

core = vs.core
matrix = {}
for p in core.plugins():
    fns = {}
    for name in dir(core.__getattr__(p.namespace)) if False else []:
        pass
    matrix[p.namespace] = {
        "name": p.name,
        # identifiers available on the namespace
    }
# dir() on the namespace proxy:
for ns in sorted({p.namespace for p in core.plugins()}):
    proxy = core.__getattr__(ns)
    fns = {}
    for fn in sorted(a for a in dir(proxy) if not a.startswith("_")):
        try:
            sig = str(proxy.__getattr__(fn).signature)
        except Exception:
            sig = None
        fns[fn] = sig
    matrix[ns]["functions"] = fns

print(json.dumps({"ok": True, "arch": os.uname().machine, "matrix": matrix}))