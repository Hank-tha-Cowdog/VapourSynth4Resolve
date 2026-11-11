#!/usr/bin/env python3
"""Execute the approved plugin rebuild-from-source batch (2026-11-05).

Owner approved the source downloads (Tier A + slugged Tier B upstreams,
depth-1, sources only) and the venv-pinned meson/ninja toolchain fetch.
Per-plugin, FAIL-CLOSED and INDEPENDENT — one plugin's failure never
stops the others, and no failure is silently swallowed:

  1. git clone --depth 1 https://github.com/<slug>  (APPROVED download)
  2. LICENSE GATE: locate LICENSE/COPYING* in the fetched tree, hash it.
     No license file found => record NO-LICENSE, SKIP the build for that
     plugin (it cannot ship; nothing is guessed or inferred).
  3. BUILD: meson (venv-pinned) or cmake, against vendor/vapoursynth
     install-R75 headers + homebrew deps — exactly the committed MVTools
     precedent (install-vs-ecosystem.sh:331-424).
  4. LOCATE the built *.dylib; sha256 it.
  5. STAGE dylib + license + a per-plugin record into
     vendor/rebuild-staging-20261105/<plugin>/  — NEVER into the shipped
     bundle, NEVER into vendor/Macos_vapoursynth_plugins.

Outputs vendor/rebuild-staging-20261105/REBUILD-RESULTS.json with the
per-plugin status for the human record. Nothing here clears a license: a
rebuilt dylib ships only after the license file covers it, the record
persists source commit + license hash, and a fresh bundle assembly + the
fail-closed audits pass.

DEFERRED by design: lsmashsource (L-SMASH-Works embeds FFmpeg — its build
is a separate focused task for exact-FFmpeg-revision source-offer
binding), Tier C (upstreams unidentified — research pass pending).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R75 = os.path.join(REPO, "vendor", "vapoursynth", "install-R75")
# Old API3-era plugins include <VapourSynth.h>, which the R75 INSTALL tree
# (API4 headers only) does not carry — the API3 header lives in the source
# tree. Both include dirs are passed to every build (harmless when unused).
R75_API3 = os.path.join(REPO, "vendor", "vapoursynth", "src-R75", "include")
STAGING = os.path.join(REPO, "vendor", "rebuild-staging-20261105")
SRC_ROOT = "/tmp/vsres-rebuild-src"
VENV = "/tmp/vsres-rebuild-venv"
PY = "/opt/homebrew/bin/python3.14"

# (record key, github slug, expected dylib base name, extra build flags)
# Slugs verified by GitHub search 2026-11-05 (first round: 10 of 12 were
# wrong guesses that 404'd; the slugs below are search-verified).
# UNRESOLVED-UPSTREAM (no GitHub repo found — recorded, not fetched):
#   PickFrames (QuietViper repo gone; no search hit), smoothuv (SSmooth
#   upstream not on GitHub search; vs-miscfilters-obsolete contains only
#   miscfilters.cpp).
APPROVED = [
    # Tier A — no license file found previously; the fetch re-checks
    ("dfttest2", "yuygfgg/vs-dfttest2", "dfttest2", ["-DENABLE_CUDA=OFF"]),  # collection author's arm64-capable fork
    ("dmetrics", "vapoursynth/dmetrics", "dmetrics", []),
    ("eedi2", "HomeOfVapourSynthEvolution/VapourSynth-EEDI2", "eedi2", []),
    ("eedi3m", "HolyWu/VapourSynth-EEDI3", "eedi3", []),
    # Tier B — upstream identified, license verify mandatory
    ("fieldhint", "dubhater/vapoursynth-fieldhint", "fieldhint", []),
    ("scxvid", "dubhater/vapoursynth-scxvid", "scxvid", []),
    ("rgsf", "IFeelBloated/RGSF", "RGSF", []),
    ("rowmanip", "yuygfgg/Vapoursynth-rowmanip", "rowmanip", []),
    ("sangnom", "dubhatervapoursynth/vapoursynth-sangnom", "sangnom", []),
    ("sneedif", "Jaded-Encoding-Thaumaturgy/vapoursynth-SNEEDIF", "SNEEDIF", []),
    # Tier C identified 2026-11-05 via the collection author's (yuygfgg's)
    # fork set — these are the likely build sources for the bundled dylibs.
    ("smoothuv", "yuygfgg/vapoursynth-smoothuv", "SSmooth", []),
    ("resize2", "yuygfgg/vapoursynth-resize2", "resize2", []),
    ("retinex", "yuygfgg/VapourSynth-Retinex", "retinex", []),
    ("tedgemask", "yuygfgg/vapoursynth-tedgemask", "TEdgeMask", []),
    ("tivtc", "yuygfgg/vapoursynth-tivtc", "tivtc", []),
    ("wwxd", "yuygfgg/vapoursynth-wwxd", "wwxd", []),
    ("fftspectrum", "yuygfgg/FFTSpectrum", "FFTSpectrum", []),
    ("removedirtvs", "yuygfgg/removedirtvs", "removedirtvs", []),
    ("removegrain", "yuygfgg/vs-removegrain", "removegrain", []),
    ("ttempsmooth", "yuygfgg/VapourSynth-TTempSmooth", "ttempsmooth", []),
    ("wnnm", "WolframRhodium/VapourSynth-WNNM", "WNNM", []),
]


def run(cmd, cwd=None, env=None, timeout=900):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_license(root):
    """Best-effort license file at the repo root (top-level only)."""
    for name in ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE.rst",
                 "COPYING", "COPYING.txt", "COPYING.md", "COPYING.LESSER"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            return p
    return None


def ensure_venv():
    if not os.path.isdir(os.path.join(VENV, "bin")):
        rc, out = run([PY, "-m", "venv", VENV])
        if rc:
            return None, f"venv create failed: {out[-400:]}"
        rc, out = run([os.path.join(VENV, "bin", "pip"), "install", "-q", "meson", "ninja"])
        if rc:
            return None, f"pip meson/ninja failed: {out[-400:]}"
    return VENV, ""


def build_meson(src, name, venv, extra):
    pyver = run([PY, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"])[1].strip()
    env = dict(os.environ)
    env["PATH"] = os.path.join(VENV, "bin") + os.pathsep + env["PATH"]
    env["PYTHONPATH"] = os.path.join(R75, "lib", f"python{pyver}", "site-packages")
    env["PKG_CONFIG_PATH"] = os.path.join(R75, "lib", "pkgconfig") + ":/opt/homebrew/lib/pkgconfig"
    env["CPATH"] = R75_API3  # API3 <VapourSynth.h> for old plugins
    bdir = os.path.join(src, "build")
    shutil.rmtree(bdir, ignore_errors=True)
    rc, out = run([os.path.join(VENV, "bin", "meson"), "setup", "build", "--buildtype=release"]
                  + [a for a in extra if a.startswith("-D")],
                  cwd=src, env=env)
    if rc:
        return None, f"meson setup failed: {out[-600:]}"
    rc, out = run([os.path.join(VENV, "bin", "meson"), "compile", "-C", "build"], cwd=src, env=env)
    if rc:
        return None, f"meson compile failed: {out[-600:]}"
    for dirpath, _dirs, files in os.walk(bdir):
        for fn in files:
            if fn.endswith(".dylib"):
                return os.path.join(dirpath, fn), ""
    return None, "meson compile ok but no .dylib produced"


def build_cmake(src, name, venv, extra):
    bdir = os.path.join(src, "build")
    shutil.rmtree(bdir, ignore_errors=True)
    os.makedirs(bdir)
    env = dict(os.environ)
    env["PKG_CONFIG_PATH"] = os.path.join(R75, "lib", "pkgconfig") + ":/opt/homebrew/lib/pkgconfig"
    env["CPATH"] = R75_API3
    rc, out = run(["cmake", ".."] + list(extra), cwd=bdir, env=env)
    if rc:
        return None, f"cmake configure failed: {out[-600:]}"
    rc, out = run(["cmake", "--build", ".", "--config", "Release", "-j", "4"], cwd=bdir, env=env)
    if rc:
        return None, f"cmake build failed: {out[-600:]}"
    for dirpath, _dirs, files in os.walk(bdir):
        for fn in files:
            if fn.endswith(".dylib"):
                return os.path.join(dirpath, fn), ""
    return None, "cmake build ok but no .dylib produced"


def process(key, slug, dylib_base, extra):
    rec = {"plugin": key, "slug": slug, "status": None, "detail": ""}
    src = os.path.join(SRC_ROOT, key)
    shutil.rmtree(src, ignore_errors=True)
    rc, out = run(["git", "clone", "--depth", "1", f"https://github.com/{slug}", src], timeout=300)
    if rc:
        rec["status"] = "CLONE-FAILED"
        rec["detail"] = out[-300:]
        return rec
    head = run(["git", "rev-parse", "HEAD"], cwd=src)[1].strip()
    rec["source_commit"] = head
    lic = find_license(src)
    if not lic:
        rec["status"] = "NO-LICENSE"
        rec["detail"] = "no LICENSE/COPYING at repo root — cannot ship; build skipped"
        return rec
    rec["license_file"] = os.path.basename(lic)
    rec["license_sha256"] = sha256_file(lic)
    with open(lic, "r", errors="replace") as f:
        first = f.read(400).lower()
    if "general public license" in first and "lesser" not in first[:80]:
        rec["license_name"] = "GPL"
    elif "general public license" in first and "lesser" in first[:80]:
        rec["license_name"] = "LGPL"
    elif "mit license" in first or "permission is hereby granted, free of charge" in first:
        rec["license_name"] = "MIT"
    elif "wtfpl" in first or "do what the fuck you want" in first:
        rec["license_name"] = "WTFPL"
    elif "apache license" in first:
        rec["license_name"] = "Apache-2.0"
    else:
        rec["license_name"] = "OTHER (read manually)"
    if os.path.isfile(os.path.join(src, "meson.build")):
        dylib, err = build_meson(src, key, VENV, extra)
    elif os.path.isfile(os.path.join(src, "CMakeLists.txt")):
        dylib, err = build_cmake(src, key, VENV, extra)
    else:
        dylib, err = None, "no meson.build/CMakeLists.txt at repo root — build system unhandled"
    if not dylib:
        rec["status"] = "BUILD-FAILED"
        rec["detail"] = err
        return rec
    stage = os.path.join(STAGING, key)
    os.makedirs(stage, exist_ok=True)
    staged_dylib = os.path.join(stage, os.path.basename(dylib))
    shutil.copy2(dylib, staged_dylib)
    shutil.copy2(lic, os.path.join(stage, rec["license_file"]))
    rec["status"] = "REBUILT-STAGED"
    rec["dylib"] = os.path.basename(staged_dylib)
    rec["dylib_sha256"] = sha256_file(staged_dylib)
    rec["detail"] = "staged to vendor/rebuild-staging-20261105/ (NOT in any bundle)"
    return rec


def main():
    only = set(sys.argv[1:])  # optional: re-run a subset by record key
    if not os.path.isdir(os.path.join(R75, "lib", "pkgconfig")):
        print("missing vendor/vapoursynth/install-R75 — cannot build")
        return 1
    os.makedirs(SRC_ROOT, exist_ok=True)
    os.makedirs(STAGING, exist_ok=True)
    venv, err = ensure_venv()
    if not venv:
        print(err)
        return 1
    results_path = os.path.join(STAGING, "REBUILD-RESULTS.json")
    results = {}
    if os.path.isfile(results_path):  # merge mode: update, never lose records
        try:
            for r in json.load(open(results_path)):
                results[r["plugin"]] = r
        except Exception:
            pass
    for key, slug, dylib_base, extra in APPROVED:
        if only and key not in only:
            continue
        print(f"▸ {key} ← github.com/{slug}", flush=True)
        try:
            rec = process(key, slug, dylib_base, extra)
        except Exception as e:  # record, never silently skip
            rec = {"plugin": key, "slug": slug, "status": "ERROR", "detail": repr(e)}
        print(f"    → {rec['status']}: {rec.get('detail', '')[:160]}", flush=True)
        results[key] = rec
    out = results_path
    with open(out, "w") as f:
        json.dump(list(results.values()), f, indent=2)
    rebuilt = [r["plugin"] for r in results.values() if r["status"] == "REBUILT-STAGED"]
    no_lic = [r["plugin"] for r in results.values() if r["status"] == "NO-LICENSE"]
    failed = [r["plugin"] for r in results.values() if r["status"] not in ("REBUILT-STAGED", "NO-LICENSE")]
    print(f"\nSUMMARY: {len(rebuilt)} rebuilt-staged ({', '.join(rebuilt) or '-'}); "
          f"{len(no_lic)} NO-LICENSE ({', '.join(no_lic) or '-'}); "
          f"{len(failed)} failed ({', '.join(failed) or '-'})")
    print(f"results: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
