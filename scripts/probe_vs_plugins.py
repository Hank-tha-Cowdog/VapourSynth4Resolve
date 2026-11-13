#!/usr/bin/env python3
"""Enumerate the VapourSynth plugin namespaces ACTUALLY registered at runtime.

The static manifest (companion-app/src/services/installed-plugins.ts) is a
curated guide; the Oct 26 live refusal ("There is no attribute or namespace
named fft3dfilter") proved it can overclaim — Skippy trusted the manifest and
wrote a step calling a namespace that was never registered. This probe is the
honest source: it imports vapoursynth in the SAME evaluation environment the
sample renderer / plugin chain uses (user plugin dir on
VAPOURSYNTH_EXTRA_PLUGIN_PATH, vs-python helpers on PYTHONPATH) and prints the
real set of registered core.* namespaces as JSON on stdout.

No arguments. Exit 0 with {"namespaces": [...]} on success; non-zero with a
message on stderr when the runtime itself is unavailable (python missing,
vapoursynth import failed) — the caller surfaces that as probe-unavailable
rather than an empty plugin set.
"""
import json
import os
import sys


def emit(payload):
    print(json.dumps(payload))
    sys.exit(0)


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def _first_existing(candidates):
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            return candidate
    return None


def main():
    # Paths must go on the REAL os.environ before the import: the VS core
    # reads VAPOURSYNTH_EXTRA_PLUGIN_PATH at createCore time. (An earlier
    # draft set these on a dict copy — probe returned only the 3 core
    # built-ins while the real environment had 54 registered plugins.)
    #
    # SHIPPED RUNTIME FIRST (fix, live 2026-11-12): the probe must speak for
    # the same runtime the installed plugin uses. The legacy user copies hold
    # HELPER modules only (havsfunc/adjust/mvsfunc) — no `vapoursynth`
    # package — so an import rooted there fails outright and the FilterLibrary
    # degrades every step to "missing" (live symptom: only Levels + Script
    # visible in Configure). Resolve bundle-relative from this script's own
    # location: <Contents/Resources>/scripts → <Contents/Resources>/OFX/...
    here = os.path.dirname(os.path.abspath(__file__))
    resources = os.path.dirname(here)
    ofx_contents = os.path.join(resources, "OFX", "VapourSynth.ofx.bundle", "Contents")

    vs_python = _first_existing([
        os.path.join(ofx_contents, "Resources", "vs-python"),
        os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"),
    ])
    plugins = _first_existing([
        os.path.join(ofx_contents, "Plugins"),
        os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins"),
    ])

    paths = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    for candidate in [
        vs_python,
        os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python"),
    ]:
        if candidate and os.path.isdir(candidate) and candidate not in paths:
            paths.insert(0, candidate)
    if paths:
        os.environ["PYTHONPATH"] = os.pathsep.join(paths)
    if plugins:
        # SINGLE-PATH VAR (empirical, R79 vscore loadAllPluginsInPath treats
        # the value as ONE path): appending produces a colon-list that loads
        # NOTHING. Live fallout (2026-11-12): the Configure popout is spawned
        # by the plugin inside Resolve and inherits Resolve's env, where the
        # var already points at the /Library bundle — the probe's append
        # degraded every step to "missing" (only Levels + Script visible).
        # The probe must speak for the SHIPPED set unconditionally; replace.
        os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = plugins

    try:
        import vapoursynth as vs  # noqa: E402
    except Exception as e:  # pragma: no cover - environment-dependent
        fail(f"vapoursynth import failed: {e}")

    core = vs.core
    namespaces = sorted({p.namespace for p in core.plugins()})
    emit({"ok": True, "namespaces": namespaces})


if __name__ == "__main__":
    main()