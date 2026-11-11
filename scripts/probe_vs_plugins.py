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


def main():
    # Paths must go on the REAL os.environ before the import: the VS core
    # reads VAPOURSYNTH_EXTRA_PLUGIN_PATH at createCore time. (An earlier
    # draft set these on a dict copy — probe returned only the 3 core
    # built-ins while the real environment had 54 registered plugins.)
    user_plugins = os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins")
    vs_python = os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python")
    paths = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    if os.path.isdir(vs_python) and vs_python not in paths:
        paths.insert(0, vs_python)
    if paths:
        os.environ["PYTHONPATH"] = os.pathsep.join(paths)
    if os.path.isdir(user_plugins):
        existing = os.environ.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH", "")
        if user_plugins not in existing.split(os.pathsep):
            os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = (
                user_plugins if not existing else existing + os.pathsep + user_plugins
            )

    try:
        import vapoursynth as vs  # noqa: E402
    except Exception as e:  # pragma: no cover - environment-dependent
        fail(f"vapoursynth import failed: {e}")

    core = vs.core
    namespaces = sorted({p.namespace for p in core.plugins()})
    emit({"ok": True, "namespaces": namespaces})


if __name__ == "__main__":
    main()