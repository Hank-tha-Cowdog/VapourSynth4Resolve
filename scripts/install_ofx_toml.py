#!/usr/bin/env python3
"""Register a portable OFX bundle's embedded VapourSynth runtime with VSScript.

VSScript R75 resolves CPython via ~/.config/vapoursynth/vapoursynth.toml,
keyed by the loaded libvsscript's absolute path (VapourSynth src
vsscript.cpp: getLibraryPath -> readEnvConfig). A portable bundle only works
when that TOML has an entry pointing ITS libvsscript at ITS embedded Python
framework. This script writes exactly that entry; it is idempotent and
refuses bundles whose embedded runtime is incomplete.

It does NOT copy the bundle to /Library/OFX (that stays an explicit,
reviewed step — see docs/packaging.md), does not run as root, and touches
the TOML file plus a private, persistent sibling lock file. Runtime registration requires Python 3.11 or newer for
standard-library TOML validation; --help works without it. Existing root
registrations must be complete single-line assignments. Unsupported multiline
registrations or invalid TOML refuse before writes; unrelated tables are retained.
Cooperating invocations serialize through that lock (five seconds by default;
--lock-timeout permits a longer finite wait).
Linked/nonregular targets are refused. A pre-publication snapshot check detects
earlier external changes, but cannot provide atomic compare-and-swap against an
uncooperating writer racing the final replacement. Existing POSIX mode/group
are preserved; extended attributes and ACLs are not covered by this helper.
Creating a new target requires hard-link support on its filesystem; a collision
never falls back to replacing the new external file.

Usage:
  install_ofx_toml.py [--bundle DIR] [--toml FILE] [--dry-run] [--lock-timeout SECONDS]

  --bundle  installed OFX bundle root (default:
             /Library/OFX/Plugins/VapourSynth.ofx.bundle)
  --toml     target TOML (default: $HOME/.config/vapoursynth/vapoursynth.toml)
  --dry-run  print the planned entry without writing
  --lock-timeout  positive finite seconds to wait for another writer (default: 5)
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

try:
    import tomllib  # Python 3.11+ standard library; no third-party dependency.
except ModuleNotFoundError:
    tomllib = None

BUNDLE_DEFAULT = "/Library/OFX/Plugins/VapourSynth.ofx.bundle"
LOCK_WAIT_SECONDS = 5.0
LOCK_POLL_SECONDS = 0.05


def die(msg: str) -> int:
    print(f"FAIL: {msg}", file=sys.stderr)
    return 1


def resolve_existing(path: Path) -> Path:
    resolved = Path(os.path.realpath(str(path)))
    if not resolved.exists():
        raise SystemExit(die(f"no such path: {path}"))
    return resolved


def toml_path_string(value: str) -> str:
    # TOML basic strings share these JSON escapes, but also forbid raw DEL.
    # Keep actual Unicode scalars: JSON surrogate-pair escapes are not TOML.
    value.encode("utf-8")
    return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")


def same_toml_data(left, right) -> bool:
    """Compare parsed values without equating bool/int or rejecting paired NaNs."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            same_toml_data(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(
            same_toml_data(a, b) for a, b in zip(left, right))
    if isinstance(left, float) and math.isnan(left) and math.isnan(right):
        return True
    return left == right


def plan_registration(existing: str, key: str, values: list[str]) -> str:
    """Replace only a complete root assignment, preserving unrelated semantics.

    tomllib supplies scope/grammar validation. Candidate removal is accepted only
    if the remaining parsed document equals the original minus this root key;
    nested keys and assignment-like multiline-string contents cannot qualify.
    """
    if tomllib is None:
        raise ValueError("Python 3.11 or newer is required for safe TOML registration")
    original = tomllib.loads(existing)
    remaining = dict(original)
    body = existing
    if key in remaining:
        del remaining[key]
        lines = existing.splitlines(keepends=True)
        for index, line in enumerate(lines):
            if "=" not in line:
                continue
            try:
                candidate = tomllib.loads(line)
            except tomllib.TOMLDecodeError:
                continue
            if set(candidate) != {key}:
                continue
            trial = "".join(lines[:index] + lines[index + 1:])
            try:
                unchanged = same_toml_data(tomllib.loads(trial), remaining)
            except tomllib.TOMLDecodeError:
                unchanged = False
            if unchanged:
                body = trial
                break
        else:
            raise ValueError("existing root registration is not a safely replaceable single-line assignment")
    entry = toml_path_string(key) + " = [" + ", ".join(toml_path_string(v) for v in values) + "]"
    planned = entry + "\n" + body
    expected = dict(original)
    expected[key] = list(values)
    if not same_toml_data(tomllib.loads(planned), expected):
        raise ValueError("planned TOML would change unrelated configuration")
    return planned if planned.endswith("\n") else planned + "\n"


def _identity(st):
    # Reading may update atime; it must not invalidate an otherwise stable read.
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_uid,
            st.st_gid, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def _read_snapshot(target: Path):
    try:
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as error:
        if target.is_symlink():
            raise ValueError("TOML target is a symlink; choose its intended ordinary file explicitly") from error
        raise
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError("TOML target must be an ordinary single-link file")
        if before.st_uid != os.geteuid():
            raise ValueError("TOML target must be owned by the current user")
        if before.st_mode & 0o7000:
            raise ValueError("TOML target has unsupported special permission bits")
        data = stream.read()
        if _identity(os.fstat(stream.fileno())) != _identity(before):
            raise ValueError("TOML changed while it was being read; retry after the other writer finishes")
    return data, before


@contextmanager
def _registration_lock(target: Path, timeout: float):
    lock = target.with_name("." + target.name + ".vsres.lock")
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    created = False
    try:
        fd = os.open(lock, flags | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        try:
            fd = os.open(lock, flags)
        except OSError as error:
            raise ValueError("cannot open the private registration lock safely") from error
    try:
        if created:
            os.fchmod(fd, 0o600)
        identity = os.fstat(fd)
        if (not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1
                or identity.st_uid != os.geteuid()
                or stat.S_IMODE(identity.st_mode) != 0o600):
            raise ValueError("registration lock must be a private ordinary single-link file owned by the current user")

        def unchanged():
            try:
                return _identity(lock.lstat()) == _identity(identity)
            except OSError:
                return False

        deadline = time.monotonic() + timeout
        if not math.isfinite(deadline):
            raise ValueError("lock timeout exceeds the clock's finite range")
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("another registration writer holds the lock; retry after it finishes")
                time.sleep(min(LOCK_POLL_SECONDS, remaining))
        if not unchanged():
            raise ValueError("registration lock changed; refusing publication")
        yield unchanged
    finally:
        # Never unlink a stable lock: waiters must keep referring to one inode.
        os.close(fd)


def update_registration(target: Path, key: str, values: list[str], *, dry_run=False,
                        lock_timeout=LOCK_WAIT_SECONDS) -> str:
    if type(lock_timeout) not in (int, float):
        raise ValueError("lock timeout must be a positive finite number of seconds")
    try:
        lock_timeout = float(lock_timeout)
    except (OverflowError, ValueError) as error:
        raise ValueError("lock timeout must be a positive finite number of seconds") from error
    if not math.isfinite(lock_timeout) or lock_timeout <= 0:
        raise ValueError("lock timeout must be a positive finite number of seconds")
    initial = _read_snapshot(target)
    planned = plan_registration(initial[0].decode("utf-8") if initial else "", key, values)
    if dry_run:
        return planned
    target.parent.mkdir(parents=True, exist_ok=True)
    with _registration_lock(target, lock_timeout) as lock_unchanged:
        snapshot = _read_snapshot(target)
        planned = plan_registration(snapshot[0].decode("utf-8") if snapshot else "", key, values)
        fd, temporary = tempfile.mkstemp(dir=str(target.parent), prefix=".toml.", text=True)
        owned = os.fstat(fd)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as out:
                if snapshot:
                    previous = snapshot[1]
                    if owned.st_gid != previous.st_gid:
                        os.fchown(out.fileno(), -1, previous.st_gid)
                    os.fchmod(out.fileno(), stat.S_IMODE(previous.st_mode))
                out.write(planned)
            staged = os.lstat(temporary)
            if (not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1
                    or (staged.st_dev, staged.st_ino) != (owned.st_dev, owned.st_ino)):
                raise ValueError("owned TOML temporary changed before publication")
            current = _read_snapshot(target)
            same = (current is None and snapshot is None) or (
                current is not None and snapshot is not None
                and current[0] == snapshot[0] and _identity(current[1]) == _identity(snapshot[1]))
            if not same or not lock_unchanged():
                raise ValueError("TOML or registration lock changed before publication; refusing to overwrite it")
            if snapshot is None:
                try:
                    os.link(temporary, target, follow_symlinks=False)
                except FileExistsError as error:
                    raise ValueError("TOML was created by another writer; refusing to overwrite it") from error
            else:
                # Cooperative writers hold the stable lock. This final replace
                # is not atomic CAS against an uncooperating external editor.
                os.replace(temporary, target)
        finally:
            try:
                now = os.lstat(temporary)
                if stat.S_ISREG(now.st_mode) and (now.st_dev, now.st_ino) == (owned.st_dev, owned.st_ino):
                    os.unlink(temporary)
            except FileNotFoundError:
                pass
            except OSError as error:
                print(f"WARN: cannot clean owned TOML temporary: {error}", file=sys.stderr)
    return planned


def main() -> int:
    default_bundle = BUNDLE_DEFAULT
    default_toml = str(Path.home() / ".config/vapoursynth/vapoursynth.toml")
    # Simple explicit parse (keeps the tool dependency-free):
    argv = sys.argv[1:]
    bundle = default_bundle
    toml = default_toml
    dry_run = False
    lock_timeout = LOCK_WAIT_SECONDS
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--bundle", "--toml", "--lock-timeout") and i + 1 < len(argv):
            if a == "--bundle":
                bundle = argv[i + 1]
            elif a == "--toml":
                toml = argv[i + 1]
            else:
                try:
                    lock_timeout = float(argv[i + 1])
                except ValueError:
                    return die("--lock-timeout must be a positive finite number of seconds")
            i += 2
        elif a == "--dry-run":
            dry_run = True
            i += 1
        elif a in ("--help", "-h"):
            print(__doc__)
            return 0
        else:
            return die(f"unknown argument: {a}")

    bundle_dir = resolve_existing(Path(bundle))
    toml_path = Path(toml).expanduser()

    vsscript = bundle_dir / "Contents/Libraries/libvsscript.dylib"
    if not vsscript.is_file():
        return die(f"missing {vsscript} — not a portable bundle?")
    framework = bundle_dir / "Contents/Frameworks/Python.framework"
    versions_dir = framework / "Versions"
    # Real version directories only — prefer numeric names ("3.14") and skip
    # symlink aliases ("Current"); cmake copy_directory may materialize both.
    import re
    def version_key(p: Path):
        m = re.match(r"^(\d+)\.(\d+)$", p.name)
        return (1, int(m.group(1)), int(m.group(2))) if m else (0, 0, 0)
    versions = sorted((p for p in versions_dir.glob("*")
                        if p.is_dir() and not p.is_symlink()
                        and (p / "Python").is_file()),
                       key=version_key) if versions_dir.is_dir() else []
    if not versions:
        return die(f"no embedded Python framework under {framework}")
    version = versions[-1].name
    py_lib = versions[-1] / "Python"
    py_exe = versions[-1] / "bin" / f"python{version}"
    if not py_exe.is_file():
        bins = sorted((versions[-1] / "bin").glob("python3.[0-9]*"))
        bins = [b for b in bins if "config" not in b.name]
        if not bins:
            return die(f"no python executable under {versions[-1] / 'bin'} — bundle incomplete")
        py_exe = bins[-1]

    key = str(vsscript)
    print(f"bundle : {bundle_dir}")
    print(f"python : {py_exe}")
    print(f"library: {py_lib}")

    try:
        planned = update_registration(toml_path, key, [str(py_exe), str(py_lib)],
                                      dry_run=dry_run, lock_timeout=lock_timeout)
    except (ValueError, UnicodeError) as error:
        return die(f"cannot update TOML safely: {error}")

    if dry_run:
        print(f"[dry-run] would write {toml_path}:")
        print(planned, end="")
        return 0

    print(f"wrote {toml_path} (root registration updated)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
