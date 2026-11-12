#!/usr/bin/env python3
"""Repair and install the vendored VapourSynth plugin set into the user path.

Why this exists: the vendored dylibs (vendor/Macos_vapoursynth_plugins/lib)
were built with a non-macOS-default toolchain and reference
@rpath/libc++.1.0.dylib, which does not resolve anywhere on this machine —
dlopen fails, so plugins like CAS and fft3dfilter never register (live
evidence: the refused chain's 'no attribute or namespace named
fft3dfilter'). Loading the whole vendor dir at once also crashes the VS
process (at least one other dylib is bad), which is why a curated user path
exists without these.

What this does — per dylib, isolated in a subprocess:
  1. copy to a staging dir and rewrite @rpath/libc++.1.0.dylib → /usr/lib/libc++.1.dylib
     (a load-path repair; no code change)
  2. probe-load it alone through VapourSynth; collect the namespaces it registers
  3. install ONLY dylibs that (a) load cleanly and (b) register at least one
     namespace NOT already registered in the user path — never overwrite or
     duplicate an existing registration.

An unavailable baseline probe stops before staging. New plugins are published
with an exclusive hard link from a completed same-directory temporary file;
existing entries (including dangling symlinks) are never replaced.

Idempotent; prints a per-dylib report. Nothing is downloaded. Existing user
plugins are never modified or replaced. --dry-run prints the plan.
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_LIB = os.path.join(REPO, "vendor", "Macos_vapoursynth_plugins", "lib")
USER_PLUGINS = os.path.expanduser("~/Library/Application Support/VapourSynth/Plugins")
VENDOR_SITE = os.path.join(REPO, "vendor", "vapoursynth", "active",
                           "lib", "python3.14", "site-packages")  # active prefix (currently R82)

BAD_RPATH = "@rpath/libc++.1.0.dylib"
FIX_RPATH = "/usr/lib/libc++.1.dylib"

PROBE = r"""
import json, sys
sys.path.insert(0, {site!r})
import os
os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = {plugindir!r}
import vapoursynth as vs
namespaces = sorted({{p.namespace for p in vs.core.plugins()}} - set({base!r}))
print(json.dumps({{"ok": True, "namespaces": namespaces}}))
"""


def load_namespaces(plugindir, base):
    code = PROBE.format(site=VENDOR_SITE, plugindir=plugindir, base=sorted(base))
    try:
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return None
    line = out.stdout.strip().splitlines()
    if out.returncode != 0 or not line:
        return None
    try:
        parsed = json.loads(line[-1])
        return parsed.get("namespaces") if parsed.get("ok") else None
    except ValueError:
        return None


def publish_plugin(source, target):
    """Publish a complete new regular file without replacing any target entry.

    A target-local temporary file avoids cross-filesystem links. Its bytes and
    mode are complete before the atomic no-replace link; no copy/rename fallback
    can overwrite a concurrently created target or follow a dangling target link.
    """
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(source_fd, "rb") as incoming:
        source_stat = os.fstat(incoming.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("plugin source is not a regular file")
        fd, temporary = tempfile.mkstemp(prefix=".vsres-plugin-", dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, "wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
                os.fchmod(outgoing.fileno(), stat.S_IMODE(source_stat.st_mode))
                outgoing.flush()
                os.fsync(outgoing.fileno())
            try:
                os.link(temporary, target, follow_symlinks=False)
            except FileExistsError:
                return False
            return True
        finally:
            try:
                os.unlink(temporary)
            except OSError as error:
                # Publication may already have succeeded: preserve that result
                # and report retained scratch, rather than deleting the final.
                print(f"WARNING: retained plugin temporary file {temporary}: {error}",
                      file=sys.stderr)


def main():
    dry = "--dry-run" in sys.argv
    # Unknown is not an empty namespace set: never install after a failed probe.
    baseline = load_namespaces(USER_PLUGINS, set())
    if baseline is None:
        print("FAIL: cannot inspect existing plugin namespaces; no plugins installed", file=sys.stderr)
        return 1
    base = set(baseline)
    print(f"user path registers {len(base)} namespaces")

    staged = tempfile.mkdtemp(prefix="vsres-plugin-stage-")
    installed, skipped, failed = [], [], []
    # Curated-set hygiene (2026-11-12 rights map, flag R2-K): libbore and
    # libnnedi3cl are excluded from every final distribution path (no
    # established rights binding). The shipped portable bundle already
    # excludes them; this user-path installer must match.
    EXCLUDED_DYLIBS = {"libbore.dylib", "libnnedi3cl.dylib"}
    for name in sorted(os.listdir(VENDOR_LIB)):
        if not name.endswith(".dylib"):
            continue
        if name in EXCLUDED_DYLIBS:
            print(f"  - {name}: excluded (curated set)")
            continue
        src = os.path.join(VENDOR_LIB, name)
        dst = os.path.join(staged, name)
        shutil.copy2(src, dst)
        # Repair the load path. -change fails if the ref is absent; ignore then.
        subprocess.run(["install_name_tool", "-change", BAD_RPATH, FIX_RPATH, dst],
                       capture_output=True)
        namespaces = load_namespaces(staged, base)
        if namespaces is None:
            failed.append(name)
            os.unlink(dst)
            continue
        if not namespaces:
            skipped.append((name, "no new namespaces"))
            os.unlink(dst)
            continue
        target = os.path.join(USER_PLUGINS, name)
        if os.path.lexists(target):
            skipped.append((name, "already installed"))
            os.unlink(dst)
            continue
        if dry:
            print(f"[dry-run] would install {name}: +{namespaces}")
        else:
            os.makedirs(USER_PLUGINS, exist_ok=True)
            if not publish_plugin(dst, target):
                skipped.append((name, "target appeared before publication"))
                os.unlink(dst)
                continue
            print(f"installed {name}: +{namespaces}")
        installed.append(name)
        base.update(namespaces)
        os.unlink(dst)
    if dry:
        print(f"[dry-run] plan: {len(installed)} installable, {len(failed)} failed")
    else:
        print(f"installed {len(installed)}: {installed}")
    print(f"skipped: {skipped}")
    print(f"failed to load: {failed}")
    shutil.rmtree(staged, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())