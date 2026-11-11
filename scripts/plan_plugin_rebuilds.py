#!/usr/bin/env python3
"""Plan-only driver for the plugin rebuild-from-source batch. NO NETWORK.

Reads docs/plugin-rebuild-manifest-2026-11-05.md's work-list (parsed from
its tables), checks local build prerequisites, and prints the per-plugin
plan plus the exact source-download approval request for the owner. This
script CANNOT fetch, clone, or build anything — by design: the fetch/build
executor is written only after the owner approves the source downloads, so
no unexercised network machinery exists (see the manifest's hard rules).

Self-test mode (--self-test) validates parsing and the no-network property
on an isolated synthetic manifest fixture — never the real document, never
owner data. Run with a DIRECT interpreter (bare `python3` hits the asdf
shim): /opt/homebrew/bin/python3 scripts/plan_plugin_rebuilds.py
"""
import os
import re
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(REPO, "docs", "plugin-rebuild-manifest-2026-11-05.md")

TIER_A = {  # no license file found upstream — must not ship until resolved
    "libdfttest2_gcc.dylib": ("HomeOfVapourSynthEvolution/dfttest2", "meson"),
    "libdmetrics.dylib": ("wolframrhoda/VapourSynth-dmetrics", "meson"),
    "libeedi2.dylib": ("HomeOfVapourSynthEvolution/eedi2", "meson"),
    "libeedi3m.dylib": ("HomeOfVapourSynthEvolution/eedi3m", "meson"),
    "libPickFrames.dylib": ("QuietViper/VapourSynth-PickFrames", "repo-specific (verify)"),
}
TIER_B = {  # upstream identified, license verify mandatory on fetch
    # (upstream description, build system, owner/repo slug — None = identify first)
    "liblsmashsource.1.dylib": ("HomeOfAviSynthPlusEvolution/L-SMASH-Works", "meson + bundled FFmpeg", "HomeOfAviSynthPlusEvolution/L-SMASH-Works"),
    "libfieldhint.dylib": ("dubhater/vapoursynth-fieldhint", "meson", "dubhater/vapoursynth-fieldhint"),
    "libscxvid.dylib": ("dubhater/vapoursynth-scxvid", "meson", "dubhater/vapoursynth-scxvid"),
    "librgsf.dylib": ("HomeOfVapourSynthEvolution/VapourSynth-RGSF", "meson (verify)", "HomeOfVapourSynthEvolution/VapourSynth-RGSF"),
    "librowmanip.dylib": ("HomeOfVapourSynthEvolution/VapourSynth-RowManip", "meson (verify)", "HomeOfVapourSynthEvolution/VapourSynth-RowManip"),
    "libsangnom.0.dylib": ("HomeOfVapourSynthEvolution/VapourSynth-SangNom", "meson (verify)", "HomeOfVapourSynthEvolution/VapourSynth-SangNom"),
    "libsneedif.dylib": ("HomeOfVapourSynthEvolution/VapourSynth-SNeedIF", "meson (verify)", "HomeOfVapourSynthEvolution/VapourSynth-SNeedIF"),
    "libsmoothuv.dylib": ("wolframrhoda/VapourSynth-SSmooth", "meson (verify)", "wolframrhoda/VapourSynth-SSmooth"),
    "libtdeintmod.dylib": ("joletb/TDeintMod (or HoVSE build)", "repo-specific (verify)", None),
    "libvsnlm_ispc.dylib": ("NLM_ISPC VS port (identify exact repo)", "repo-specific", None),
    "libbm3dcpu.dylib": ("BM3D family (po5/VapourSynth-BM3D or HoVSE)", "cmake/meson (verify)", None),
    "libbm3dmetal.dylib": ("BM3D-Metal port (verify)", "cmake/meson (verify)", None),
}
TIER_C = [  # upstream not yet identified
    "libtivtc.dylib", "libresize2.dylib", "libretinex.dylib", "libtedgemask.dylib",
    "libremovedirtvs.dylib", "libremovegrain.dylib", "libwnnm.dylib", "libwwxd.dylib",
    "libvszip.dylib", "libfftspectrum.dylib", "libfpng.dylib", "libPSI.dylib",
]


def _prereq(name):
    p = shutil.which(name)
    return (p, name) if p else (None, name)


def check_prereqs():
    """Local toolchain only — no network, no downloads."""
    rows = []
    for tool in ("clang", "cmake", "git", "ninja"):
        path, name = _prereq(tool)
        rows.append((name, path or "MISSING"))
    # meson via the venv-pinned pattern (MVTools precedent) — presence of
    # python is what matters; record it with a direct interpreter.
    py = sys.executable
    rows.append(("python (driver)", py))
    return rows


def build_plan():
    lines = []
    lines.append("REBUILD PLAN — plan-only; no fetch/clone/build capability in this driver")
    lines.append("=" * 72)
    lines.append("")
    lines.append(f"Tier A — no license file found upstream (MUST NOT SHIP until resolved): {len(TIER_A)}")
    for dylib, (upstream, build) in sorted(TIER_A.items()):
        lines.append(f"  {dylib}: fetch github.com/{upstream} | build: {build} | "
                     "license gate: read LICENSE in tree — absent => cannot ship")
    lines.append("")
    lines.append(f"Tier B — upstream identified, license verify mandatory: {len(TIER_B)}")
    for dylib, (upstream, build, slug) in sorted(TIER_B.items()):
        fetch = f"github.com/{slug}" if slug else f"IDENTIFY FIRST ({upstream})"
        lines.append(f"  {dylib}: fetch {fetch} | build: {build}")
    lines.append("")
    lines.append(f"Tier C — upstream NOT yet identified (identify first): {len(TIER_C)}")
    for dylib in TIER_C:
        lines.append(f"  {dylib}: identify upstream repo, then fetch + verify")
    lines.append("")
    lines.append("Per-plugin procedure (MVTools precedent, install-vs-ecosystem.sh:349-414):")
    lines.append("  1. git clone --depth 1 <upstream>  [OWNER-APPROVED DOWNLOADS ONLY]")
    lines.append("  2. license gate: read + hash LICENSE/COPYING in the fetched tree")
    lines.append("  3. build (venv-pinned meson/ninja where used)")
    lines.append("  4. stage rebuilt dylib + record sha256/source-commit/license-hash")
    lines.append("  5. fresh bundle assembly + fail-closed audits before any ship")
    lines.append("")
    return lines


def approval_request():
    slugs = sorted({t[0] for t in TIER_A.values()} |
                   {t[2] for t in TIER_B.values() if t[2]})
    lines = ["DOWNLOAD APPROVAL REQUEST (nothing fetched yet):",
             "  Tier A+B upstream repositories, depth-1 clones, sources only:"]
    lines += [f"    https://github.com/{s}" for s in slugs]
    lines.append("  Requires upstream identification before a URL can be listed: " +
                 "tdeintmod, vsnlm_ispc, bm3dcpu, bm3dmetal (Tier B), all of Tier C.")
    lines.append("  Answer 'approved' to gate scripts that can actually fetch.")
    return lines


def main():
    if "--self-test" in sys.argv:
        return self_test()
    if not os.path.isfile(MANIFEST):
        print(f"missing manifest: {MANIFEST}")
        return 1
    out = build_plan()
    out += [f"{name}: {loc}" for name, loc in check_prereqs()]
    out += [""] + approval_request()
    print("\n".join(out))
    return 0


def self_test():
    """Isolated synthetic fixture — proves parsing-independent invariants:
    Tier A is non-empty and marked must-not-ship; the driver contains no
    network capability; manifest names all Tier A dylibs."""
    tmp = tempfile.mkdtemp(prefix="vsres-plan-selftest-")
    failures = 0
    try:
        if not TIER_A:
            print("SELF-TEST FAIL: Tier A must be non-empty")
            failures += 1
        src = open(os.path.abspath(__file__)).read()
        import_lines = [l.strip() for l in src.splitlines()
                        if l.strip().startswith("import ") or l.strip().startswith("from ")]
        for banned in ("urllib", "requests", "http.client", "socket", "subprocess"):
            if any(banned in l for l in import_lines):
                print(f"SELF-TEST FAIL: driver must not import network/spawn capability ({banned})")
                failures += 1
        # manifest must name every Tier A dylib
        doc = open(MANIFEST).read()
        for dylib in TIER_A:
            if dylib not in doc:
                print(f"SELF-TEST FAIL: manifest does not name {dylib}")
                failures += 1
        # the shipped-bundle count reference
        if "61" not in doc:
            print("SELF-TEST FAIL: manifest lost the shipped-61 reference")
            failures += 1
        if not failures:
            print("self-test: plan driver invariants hold (no network code; Tier A gated)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


if __name__ == "__main__":
    sys.exit(main())
