#!/usr/bin/env python3
"""Release-payload allowlist guard — comprehensive + mandatory.

Scans ALL release payload surfaces for forbidden content and fails closed:
  1. extraResources sources (electron-builder copies these into the app)
  2. build.files globs (the app.asar content — resolved from package.json)
  3. Actual dist OUTPUT artifacts when present (the .app tree and bounded
     ASAR filename index) — the final word on payload names.

Forbidden: credential-like basenames, key material, .env, source maps,
developer paths INSIDE payload-relative paths, test files, __pycache__, and
the non-runtime fast-uri benchmark subtree.
Allowlist is explicit and documented (CPython stdlib test certs, certifi CA
bundle, stdlib secrets.py — see docs/SBOM.md).

--self-test plants SYNTHETIC markers in an ISOLATED TEMP fixture (never the
real staging tree, never the owner's files) and proves fail-closed.

Names/paths only — file bodies are never read or printed; ASAR filename
metadata is read with explicit size/framing bounds. --inputs-only precedes
packaging; --output-only requires and checks a built app afterward.
Exit 1 on any finding => wire into `dist` so packaging cannot ship a bad
payload (see package.json dist:audit hook).
"""
import fnmatch
from functools import lru_cache
import json
import os
import re
import shutil
import sys
import struct
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(REPO, "companion-app")

FORBIDDEN_NAMES = [
    "secrets.json", "secrets.*", ".env", ".env.*", "*.pem", "*.key",
    "id_rsa*", "credentials.json", "*.kdbx", "token.json",
]
FORBIDDEN_PATTERNS = [
    r"(^|/)zachalberd(/|$)", r"(^|/)Users(/|$)",
    r"(^|/)development_projects(/|$)",
    r"__pycache__", r"(?i)\.py[co]$", r"\.map$", r"(^|/)__test_",
    r"(^|/)node_modules/fast-uri/benchmark(/|$)",
]
ALLOWED_NAMES = {
    "secrets.py",           # Python stdlib module, not a credential
    "idle.py",
}


def _pkg():
    with open(os.path.join(APP, "package.json")) as f:
        return json.load(f)


def _walk(root, rel_of):
    for dirpath, dirnames, filenames in os.walk(root):
        # Directories matter too: an empty forbidden cache must not disappear
        # from the actual-output scan. Input exclusions are applied explicitly.
        for name in dirnames + filenames:
            yield rel_of(os.path.join(dirpath, name), root), name


def _glob_match(rel, pattern):
    """Slash-aware *, ?, [] and ** for this repository's packaging patterns.

    Refuse unimplemented brace/extglob syntax rather than claim full parity
    with electron-builder. Its actual copier and final payload remain separate
    checks. Unlike fnmatch on a whole path, * never crosses a slash.
    """
    if any(c in pattern for c in "{}()|\\") or pattern.startswith("/") or ".." in pattern.split("/"):
        raise ValueError("unsupported packaging glob: " + pattern)
    parts, pats = tuple(rel.replace(os.sep, "/").split("/")), tuple(pattern.split("/"))
    @lru_cache(None)
    def match(i, j):
        if j == len(pats):
            return i == len(parts)
        if pats[j] == "**":
            return match(i, j + 1) or (i < len(parts) and match(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], pats[j]) and match(i + 1, j + 1)
    return match(0, 0)


def _validate_patterns(patterns):
    if not patterns:
        return
    negative_seen = False
    for pattern in patterns:
        if not isinstance(pattern, str) or not pattern:
            raise ValueError("invalid packaging glob")
        if pattern.startswith("!"):
            negative_seen = True
        elif negative_seen:
            raise ValueError("unsupported re-inclusion after packaging exclusion")
        _glob_match("", pattern[1:] if pattern.startswith("!") else pattern)


def _selected(rel, patterns):
    if not patterns:
        return True
    includes = [p for p in patterns if not p.startswith("!")]
    excludes = [p[1:] for p in patterns if p.startswith("!")]
    # Excluding a directory excludes its descendants, as the copier does.
    ancestors = ["/".join(rel.replace(os.sep, "/").split("/")[:i])
                 for i in range(1, len(rel.replace(os.sep, "/").split("/")) + 1)]
    return (not includes or any(_glob_match(rel, p) for p in includes)) and not any(
        _glob_match(a, p) for p in excludes for a in ancestors)


def audit_extra_resources():
    """extraResources sources → the shipped Resources tree layout.
    Applies the repository's supported include/exclude glob forms: only
    matching entries are inspected — dev-only
    siblings in the same source dir are NOT shipped and must NOT be
    flagged (but any filtered-in file still is)."""
    findings = []
    for entry in _pkg()["build"].get("extraResources", []):
        src = entry["from"]
        root = src if os.path.isabs(src) else os.path.normpath(os.path.join(APP, src))
        if not os.path.isdir(root):
            findings.append(("missing-root", src, "extraResources source missing"))
            continue
        patterns = entry.get("filter")
        if isinstance(patterns, str):
            patterns = [patterns]
        _validate_patterns(patterns)
        for rel, name in _walk(root, os.path.relpath):
            if not _selected(rel, patterns):
                continue
            findings.extend(_check(rel, name, in_bundle=True))
    return findings


def audit_files_globs():
    """build.files → app.asar inputs (the app's own code the DMG ships).
    Include patterns give the base directory (`a/**/*` → walk `a/`);
    exclusion patterns (`!...`) are applied per file, matching the
    electron-builder glob semantics closely enough for a fail-closed guard."""
    files = _pkg()["build"].get("files", [])
    _validate_patterns(files)
    includes = [p for p in files if not p.startswith("!")]

    findings = []
    for pattern in includes:
        base = pattern.split("/**")[0].rstrip("/*")
        root = base if os.path.isabs(base) else os.path.normpath(os.path.join(APP, base))
        if os.path.isfile(root):
            rel = os.path.relpath(root, APP)
            if _selected(rel, files):
                findings.extend(_check(rel, os.path.basename(root), in_bundle=False))
            continue
        if not os.path.isdir(root):
            findings.append(("missing-root", pattern, "files glob base missing"))
            continue
        for rel, name in _walk(root, os.path.relpath):
            full_rel = os.path.relpath(os.path.join(root, rel), APP)
            if _selected(full_rel, files):
                findings.extend(_check(full_rel, name, in_bundle=False))
    return findings


def audit_dist_output():
    """ACTUAL built artifacts: the .app tree (unpacked asar included)."""
    findings = []
    dist = os.path.join(APP, "dist")
    if not os.path.isdir(dist):
        return findings, []
    apps = []
    for dirpath, dirnames, _f in os.walk(dist):
        if dirpath.endswith(".app"):
            apps.append(dirpath)
            dirnames[:] = []
            continue
    for app in apps:
        for rel, name in _walk(app, os.path.relpath):
            findings.extend(_check(rel, name, in_bundle=True))
            if name == "app.asar" and os.path.isfile(os.path.join(app, rel)):
                findings.extend(_audit_asar(os.path.join(app, rel)))
    return findings, apps


def _audit_asar(archive):
    """Read bounded ASAR filename metadata, never archived file bodies."""
    findings = []
    try:
        with open(archive, "rb") as stream:
            header = struct.unpack("<4I", stream.read(16))
            if not (header[0] == 4 and 0 < header[3] < header[1] < 16 * 1024 * 1024
                    and header[1] == header[2] + 4
                    and header[2] == ((4 + header[3] + 3) // 4) * 4
                    and os.fstat(stream.fileno()).st_size >= 8 + header[1]):
                raise ValueError("invalid ASAR header bounds")
            node = json.loads(stream.read(header[3]))
        if not isinstance(node, dict) or not isinstance(node.get("files"), dict):
            raise ValueError("invalid ASAR root")
        stack, count = [("app.asar", node)], 0
        while stack:
            prefix, node = stack.pop()
            for name, info in node.get("files", {}).items():
                count += 1
                if (count > 100000 or not isinstance(info, dict)
                        or name in ("", ".", "..") or "/" in name or "\\" in name
                        or ("files" in info and not isinstance(info["files"], dict))):
                    raise ValueError("invalid ASAR entry or entry bound exceeded")
                rel = prefix + "/" + name
                findings.extend(_check(rel, name, in_bundle=False))
                stack.append((rel, info))
    except (OSError, ValueError, TypeError, AttributeError, struct.error, RecursionError) as error:
        findings.append(("invalid-asar", "app.asar", type(error).__name__))
    return findings


def _check(rel, name, in_bundle):
    rel = rel.replace(os.sep, "/")
    out = []
    # Structural forbidden paths are never exempted by a certificate directory.
    for pat in FORBIDDEN_PATTERNS:
        if re.search(pat, rel):
            out.append(("forbidden-path", rel, f"matches {pat}"))
            break
    public_test_cert = "/lib/python3.14/test/" in "/" + rel and name.endswith((".pem", ".key"))
    public_ca = "/pip/_vendor/certifi/" in "/" + rel and name == "cacert.pem"
    if name in ALLOWED_NAMES:
        return out
    for pat in FORBIDDEN_NAMES:
        if fnmatch.fnmatch(name.lower(), pat.lower()):
            if pat in ("*.pem", "*.key") and (public_test_cert or public_ca):
                continue
            out.append(("forbidden-name", rel, f"matches {pat}"))
    return out


def self_test():
    """Isolated temp fixture (NEVER real staging): plant synthetic markers,
    prove fail-closed on every surface, clean up."""
    tmp = tempfile.mkdtemp(prefix="vsres-payload-guard-")
    failures = 0
    try:
        # Surface 1: a fake extraResources-style tree.
        extra = os.path.join(tmp, "extra")
        os.makedirs(os.path.join(extra, "Contents", "Resources"), exist_ok=True)
        marker = os.path.join(extra, "Contents", "Resources", "secrets.json")
        with open(marker, "w") as f:
            f.write('{"synthetic": "marker — not a credential"}')
        findings = [f for f in _check("Contents/Resources/secrets.json",
                                       "secrets.json", in_bundle=True)]
        if not any(f[0] == "forbidden-name" for f in findings):
            print("SELF-TEST FAIL: extraResources marker not caught")
            failures += 1
        # Surface 2: a dev-path leak inside a payload-relative path.
        findings = _check("app/components/x/Users/y.js", "y.js", in_bundle=False)
        if not any(f[0] == "forbidden-path" for f in findings):
            print("SELF-TEST FAIL: embedded dev-path not caught")
            failures += 1
        # Surface 3: a source map.
        findings = _check("app/bundle.js.map", "bundle.js.map", in_bundle=False)
        if not any(f[0] == "forbidden-path" and ".map" in f[2] for f in findings):
            print("SELF-TEST FAIL: source map not caught")
            failures += 1
        if not failures:
            print("self-test: synthetic markers caught on all surfaces (guard works)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if any(a not in ("--inputs-only", "--output-only", "--self-test") for a in argv) or (
            "--inputs-only" in argv and "--output-only" in argv):
        print("usage: audit_release_payload.py [--inputs-only | --output-only] [--self-test]")
        return 1
    rc = self_test()
    if rc:
        return rc
    surfaces = []
    if "--output-only" not in argv:
        surfaces.extend([("extraResources", audit_extra_resources()),
                         ("files", audit_files_globs())])
    if "--inputs-only" not in argv:
        dist_findings, apps = audit_dist_output()
        if "--output-only" in argv and not apps:
            dist_findings.append(("missing-output", "dist", "no built .app found"))
        surfaces.append((f"dist output ({len(apps)} .app)", dist_findings))
    total = 0
    for surface, findings in surfaces:
        for kind, rel, why in findings:
            print(f"FORBIDDEN {kind} [{surface}]: {rel} ({why})")
        total += len(findings)
    if total:
        print(f"{total} forbidden entries — build must NOT ship")
        return 1
    print("payload audit clean (" + " + ".join(surface for surface, _ in surfaces) + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
