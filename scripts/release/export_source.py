#!/usr/bin/env python3
"""Route A source export (licensing review 2026-11-11, §"release paths").

Builds a CLEAN, allowlisted source tree of THIS project — no Git history, no
build outputs, no vendor binaries, no client/private material — plus a
sha256 manifest. The licensing review's rules this implements:

  * "Create the export from an explicit allowlist."
  * "Exclude unqualified vendor binary outputs, build/app/DMG trees, model
    packs, unlicensed helper copies, private evidence, unrelated
    media/screenshots and any historical files whose redistribution has not
    been checked."
  * "A new clean source repository or release archive is a low-cost way to
    keep the published scope understandable."

THIRD-PARTY SOURCE is NOT included by default (vendor/ is fully excluded):
including third-party source under its component terms is an owner
rights-map decision (see docs/notices-index.md). Use --include-vendor-source
to opt in per path.

Hard exclusions apply REGARDLESS of the allowlist: any binary/media artifact
is refused by extension, and large files are reported for review.

Usage:
  python3 scripts/release/export_source.py --out /path/to/export-dir
  python3 scripts/release/export_source.py --out DIR --include-vendor-source \
      vendor/vapoursynth-mvtools
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# ── Allowlist ────────────────────────────────────────────────────────────────
# Top-level entries included verbatim (minus hard exclusions below).
INCLUDE_ROOTS = [
    "common",
    "platform",
    "scripts",
    "tests",
    "docs",
    "companion-app",
    ".github",
    "tools",
]
# NOTE: README.md is deliberately NOT exported. The public landing-page
# README is owned by the public repo workflow (edit it in place on main);
# the private tree's README.md is development documentation. Syncs must
# also pass --exclude=README.md so --delete cannot remove it.
INCLUDE_ROOT_FILES = [
    "LICENSE",
    "CMakeLists.txt",
    ".tool-versions",
    ".gitignore",
    "CONTRIBUTING.md",
    "SECURITY.md",
]

# never copied, whatever the allowlist says (directory names, any depth):
EXCLUDE_DIR_NAMES = {
    ".git", ".cache", ".venv", "__pycache__", "node_modules", "vendor",
    "build", "dist", "build-portable", "build-ffprobe", "build-ffprobe-wip",
    "release-export", "checkout", "pal-recovery", "target",
}
# directory-name patterns (fnmatch), any depth:
EXCLUDE_DIR_GLOBS = ["build-*", "*.app", "*.framework", "*.xcodeproj"]

# docs/ exclusions — client material, legal drafts, internal process records.
# (Knobs: --docs-include-all restores everything not hard-excluded.)
DOCS_EXCLUDED_GLOBS = [
    "*briefing*",            # client briefing material
    "*adjudication*",        # client adjudication records
    "legal-drafts",
    "counsel-*",
    "credential-hygiene.md",
    "HANDOFF-*.md",
    "review-handoff-*",
    "local-*",               # dated internal batch records…
    "*-batch-*",
    "batch-record-*",
    "overnight-plan*",
    "pal-recovery-*",
    "candidate-manifest-*",
    "distribution-audit-*",
    "plugin-rebuild-*",
    "requirements-reconciliation-*",
    "release-status.md",
    "owner-live-session-checklist.md",
    "*-brief.md",            # reviewer briefs (process records)
    "MASTER-PLAN-*",
    "agentic*",              # internal roadmap/spec drafts
    "continuation-*",
    "release-gates.md",
    "release-readiness-*",
    "requirements-checklist.md",
    "audit-fixes-*",
    "notice-source-followup*",
    "rights-map-*",          # internal until owner-reviewed
    "rights-*",              # rights working records (grant maps, drafts)
    "owner-decisions-guide-*",  # internal decision support until owner-reviewed
    "authorship-record-*",   # internal until the upstream grant is filed
]
DOCS_EXCLUDED_EXCEPTIONS = []  # every internal working record is excluded by default

# Root-level files never exported (internal process/handoff docs).
ROOT_FILE_EXCLUSIONS = ["HANDOFF.md"]

# Job-specific utilities (client recovery tooling) — not part of the product.
EXCLUDED_FILE_BASENAMES = {
    "segmented_recovery.py",
    "diagnose_combling.py",
}

# Binary/media extensions refused by construction (review: no vendor binary
# outputs, model packs, media/screenshots in the source export).
BINARY_EXTS = {
    ".dylib", ".so", ".a", ".o", ".obj", ".lib", ".dll", ".exe",
    ".mov", ".mp4", ".m4v", ".mkv", ".avi", ".webm",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff",
    ".psd", ".svgz",
    ".onnx", ".mlmodel", ".mlpackage", ".safetensors", ".pth", ".pt",
    ".weights", ".bin", ".ckpt",
    ".dmg", ".pkg", ".zip", ".tar", ".gz", ".tgz", ".xz", ".7z",
    ".wav", ".mp3", ".aac", ".flac", ".m4a",
    ".icns", ".ico", ".ttf", ".otf", ".woff", ".woff2",
    ".pdf", ".sketch", ".fig",
    ".lwi", ".edl",
    ".DS_Store",
}
# Text-ish formats that are definitely fine even with odd names.
TEXT_EXTS = {
    ".md", ".txt", ".py", ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx",
    ".json", ".jsonc", ".toml", ".yaml", ".yml", ".cmake", ".cpp", ".h",
    ".hpp", ".mm", ".c", ".cc", ".sh", ".bash", ".zsh", ".html", ".css",
    ".scss", ".plist", ".entitlements", ".vpy", ".patch", ".diff", ".csv",
    ".cfg", ".ini", ".conf", ".gitignore", ".tool-versions", ".edn",
}
LARGE_FILE_REVIEW_BYTES = 2 * 1024 * 1024  # report anything bigger


@dataclass
class ExportStats:
    copied = 0
    bytes = 0
    skipped_dirs = 0
    refused_binary = 0
    refused_large: list


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def excluded_dir(name: str) -> bool:
    if name in EXCLUDE_DIR_NAMES:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in EXCLUDE_DIR_GLOBS)


def docs_excluded(rel_to_docs: str, include_all_docs: bool) -> bool:
    if include_all_docs:
        return False
    top = rel_to_docs.split("/", 1)[0]
    for pat in DOCS_EXCLUDED_GLOBS:
        if fnmatch.fnmatch(top, pat) or fnmatch.fnmatch(rel_to_docs, pat):
            if any(rel_to_docs.startswith(ex) or top == ex
                   for ex in DOCS_EXCLUDED_EXCEPTIONS):
                return False
            return True
    return False


def is_refused_binary(path: Path) -> bool:
    ext = path.suffix.lower()
    if ext in TEXT_EXTS:
        return False
    return ext in BINARY_EXTS


def walk_and_copy(src_root: Path, out_root: Path, include_all_docs: bool,
                  stats: ExportStats, manifest: list, docs_root: bool = False,
                  manifest_prefix: str = ""):
    import os
    stack = [src_root]
    while stack:
        dirpath = stack.pop()
        try:
            entries = sorted(os.listdir(dirpath))
        except OSError:
            continue
        for name in entries:
            src_file = dirpath / name
            if src_file.is_symlink():
                print(f"  skipped symlink: {src_file.relative_to(src_root)}")
                continue
            if src_file.is_dir():
                if excluded_dir(name):
                    continue
                if docs_root and docs_excluded(f"{name}/", include_all_docs):
                    continue
                stack.append(src_file)
                continue
            if name in EXCLUDED_FILE_BASENAMES:
                continue
            rel = src_file.relative_to(src_root)
            rel_str = rel.as_posix()
            if docs_root and docs_excluded(rel_str, include_all_docs):
                continue
            if is_refused_binary(src_file):
                stats.refused_binary += 1
                continue
            size = src_file.stat().st_size
            if size > LARGE_FILE_REVIEW_BYTES and src_file.suffix.lower() not in TEXT_EXTS:
                stats.refused_large.append((manifest_prefix + rel_str, size))
                continue
            dst = out_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, dst)
            manifest.append((manifest_prefix + rel_str, sha256_file(dst), size))
            stats.copied += 1
            stats.bytes += size


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="output directory (created/cleaned)")
    ap.add_argument("--docs-include-all", action="store_true",
                    help="include all docs/ except hard exclusions (default: curated)")
    ap.add_argument("--include-root", action="append", default=[],
                    help="extra top-level path to include (repeatable)")
    ap.add_argument("--include-vendor-source", action="append", default=[],
                    help="opt in a vendor/ subtree (third-party source; owner rights-map decision)")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    if out == REPO or REPO in out.parents:
        print("refusing to export into (or under) the repository itself", file=sys.stderr)
        return 2
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    stats = ExportStats(refused_large=[])
    manifest: list = []

    # Root files
    for name in INCLUDE_ROOT_FILES:
        f = REPO / name
        if not f.exists() or name in ROOT_FILE_EXCLUSIONS:
            continue
        dst = out / name
        shutil.copy2(f, dst)
        manifest.append((name, sha256_file(dst), f.stat().st_size))
        stats.copied += 1
        stats.bytes += f.stat().st_size

    # Allowlisted roots
    for root_name in INCLUDE_ROOTS + args.include_root:
        root = REPO / root_name
        if not root.exists():
            print(f"  (skipping missing allowlist root: {root_name})")
            continue
        walk_and_copy(root, out / root_name, args.docs_include_all, stats, manifest,
                      docs_root=(root_name == "docs"), manifest_prefix=f"{root_name}/")

    # Explicit vendor source opt-ins (per-path)
    for vend in args.include_vendor_source:
        root = REPO / vend
        if not root.exists():
            print(f"  (skipping missing vendor source: {vend})", file=sys.stderr)
            continue
        walk_and_copy(root, out / vend, args.docs_include_all, stats, manifest,
                      manifest_prefix=f"{vend}/")

    # Manifest + export readme
    manifest.sort()
    with open(out / "MANIFEST.sha256", "w") as fh:
        for rel_str, digest, size in manifest:
            fh.write(f"{digest}  {rel_str}\n")
    (out / "EXPORT-INFO.txt").write_text(
        "Source export built by scripts/release/export_source.py.\n"
        "Scope: allowlisted project source only — no Git history, no build\n"
        "outputs, no vendor binaries, no client/private material. Third-party\n"
        "components are NOT included; their notices and source duties are\n"
        "tracked in docs/notices-index.md (owner rights-map decisions open).\n"
        f"Files: {stats.copied}  Bytes: {stats.bytes}\n"
    )

    print(f"\nexported {stats.copied} files ({stats.bytes / 1e6:.1f} MB) -> {out}")
    print(f"refused binaries/media: {stats.refused_binary}")
    if stats.refused_large:
        print("large non-text files refused (review if any are intentional):")
        for rel_str, size in stats.refused_large:
            print(f"  {rel_str} ({size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
