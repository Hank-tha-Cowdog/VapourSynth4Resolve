#!/usr/bin/env python3
"""Stage an already verified local ffmpeg ENCODER build, without running it.

Sibling of stage_ffprobe.py for the encoder payload (beta-batch render queue):
same pinned source and signature policy, but an ENCODER feature contract —
the probe build's feature disables (--disable-ffmpeg/-encoders/-muxers/
-avfilter) must be ABSENT and the GPL/nonfree/version3/network/autodetect
restrictions must remain. The trusted builder must verify FFmpeg's release
signature before creating the manifest. This helper checks that manifest's
pinned inputs and statically checks the executable. It does not grant
licensing, compatibility or release clearance. No compiler, candidate
executable, subprocess or network operation is invoked.
"""

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import sys
import tempfile

VERSION = "9.0.2"
SOURCE_URL = "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz"
SIGNER = "FCF986EA15E6E293A5644F10B4322F04D67658D8"
TARGET = "arm64-apple-macos13.0"
MAX_MIN_OS = (13, 0, 0)
MAX_BINARY_BYTES = 128 * 1024 * 1024
MAX_MATERIAL_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
# ENCODER contract: the LGPL restrictions stay; the probe build's feature
# disables are forbidden (an encoder payload must actually encode).
REQUIRED_FLAGS = {
    "--disable-gpl", "--disable-nonfree", "--disable-version3",
    "--disable-autodetect", "--disable-network",
    "--disable-ffprobe", "--disable-ffplay",
}
FORBIDDEN_FLAGS = {
    "--disable-ffmpeg", "--disable-encoders", "--disable-muxers",
    "--disable-avfilter", "--enable-gpl", "--enable-nonfree",
    "--enable-version3", "--enable-network", "--enable-autodetect",
}
MATERIAL_ROLES = {"license", "source", "build-config", "signature-verification"}
LOAD_DYLIBS = {0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023}


class StageError(ValueError):
    """Input, provenance or staging contract was not satisfied."""


def require(predicate, reason):
    if not predicate:
        raise StageError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(value):
    require(isinstance(value, str) and len(value) == 64 and
            all(c in "0123456789abcdef" for c in value), "invalid SHA-256")
    return value


def relative(value):
    require(isinstance(value, str) and value and len(value) <= 512 and
            "\\" not in value and "\x00" not in value,
            "invalid relative input path")
    p = PurePosixPath(value)
    require(not p.is_absolute() and all(x not in ("", ".", "..") for x in value.split("/")),
            "input path must remain inside source root")
    return p


def directory(value):
    p = Path(value).absolute()
    require(not p.is_symlink() and p.is_dir(), "root must be an existing real directory")
    return p.resolve(strict=True)


def read_local(root, name, limit):
    """Read one ordinary single-link file beneath root, rejecting path links."""
    rel = relative(name)
    current = root
    for component in rel.parts:
        current = current / component
        require(not current.is_symlink(), "symlink input rejected")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(current, flags)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                "input must be a regular single-link file")
        require(before.st_size <= limit, "input exceeds size limit")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_nlink")
        require(len(data) <= limit and all(getattr(before, f) == getattr(after, f) for f in fields),
                "input changed while reading")
        return data, stat.S_IMODE(before.st_mode)
    finally:
        os.close(fd)


def packed_version(value):
    return (value >> 16, (value >> 8) & 255, value & 255)


def command_string(command, offset):
    require(0 <= offset < len(command), "invalid Mach-O string offset")
    end = command.find(b"\0", offset)
    require(end >= 0, "unterminated Mach-O string")
    try:
        return command[offset:end].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StageError("invalid Mach-O string") from exc


def inspect_macho(data):
    """Inspect a thin arm64 executable's deployment and load commands only."""
    require(len(data) >= 32 and data[:4] == b"\xcf\xfa\xed\xfe",
            "expected a thin little-endian 64-bit Mach-O")
    _, cpu, subtype, filetype, count, size, _, _ = struct.unpack_from("<8I", data)
    require(cpu == 0x0100000C and subtype == 0 and filetype == 2,
            "expected baseline arm64 executable")
    require(0 < count <= 4096 and size <= 1024 * 1024 and 32 + size <= len(data),
            "invalid Mach-O load-command region")
    offset, end, minima, dependencies = 32, 32 + size, [], []
    for _ in range(count):
        require(offset + 8 <= end, "truncated Mach-O command")
        kind, length = struct.unpack_from("<2I", data, offset)
        require(length >= 8 and length % 8 == 0 and offset + length <= end,
                "invalid Mach-O command size")
        command = data[offset:offset + length]
        if kind == 0x32:  # LC_BUILD_VERSION
            require(length >= 24, "truncated build-version command")
            platform, minimum = struct.unpack_from("<2I", command, 8)
            require(platform == 1, "Mach-O platform must be macOS")
            minima.append(packed_version(minimum))
        elif kind == 0x24:  # LC_VERSION_MIN_MACOSX
            require(length >= 16, "truncated minimum-version command")
            minima.append(packed_version(struct.unpack_from("<I", command, 8)[0]))
        elif kind in LOAD_DYLIBS:
            require(length >= 24, "truncated dylib command")
            name = command_string(command, struct.unpack_from("<I", command, 8)[0])
            require((name.startswith("/usr/lib/") or name.startswith("/System/Library/")) and
                    ".." not in PurePosixPath(name).parts,
                    "non-Apple-system dylib rejected")
            dependencies.append(name)
        elif kind == 0xE:  # LC_LOAD_DYLINKER
            require(length >= 12 and command_string(command, struct.unpack_from("<I", command, 8)[0]) ==
                    "/usr/lib/dyld", "unexpected dynamic linker")
        elif kind in (0x8000001C, 0x27):  # LC_RPATH / LC_DYLD_ENVIRONMENT
            raise StageError("runtime search paths and dyld environment commands are rejected")
        offset += length
    require(offset == end and len(minima) == 1, "missing or ambiguous deployment target")
    require((10, 0, 0) <= minima[0] <= MAX_MIN_OS, "minimum macOS exceeds approved helper target")
    return {"architecture": "arm64", "minimum_macos": ".".join(map(str, minima[0])),
            "dependencies": sorted(set(dependencies))}


def checked_inputs(source_root, manifest_path):
    root = directory(source_root)
    manifest = Path(manifest_path).absolute()
    try:
        rel = manifest.relative_to(root).as_posix()
    except ValueError as exc:
        raise StageError("manifest must be beneath source root") from exc
    raw, _ = read_local(root, rel, 128 * 1024)
    try:
        m = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise StageError("manifest is not valid UTF-8 JSON") from exc
    require(isinstance(m, dict) and m.get("schema_version") == 1 and m.get("version") == VERSION,
            "unexpected manifest schema or version")
    src, build, binary = m.get("source"), m.get("build"), m.get("binary")
    require(all(isinstance(v, dict) for v in (src, build, binary)), "missing manifest section")
    require(src.get("url") == SOURCE_URL and src.get("signer_fingerprint") == SIGNER,
            "source URL or release signer mismatch")
    archive_sha, signature_sha = sha(src.get("archive_sha256")), sha(src.get("signature_sha256"))
    configure = build.get("configure")
    require(build.get("target") == TARGET and all(build.get(k) is False for k in ("gpl", "nonfree", "version3")),
            "unexpected target or license configuration")
    require(isinstance(configure, list) and len(configure) <= 256 and
            all(isinstance(v, str) and len(v) <= 4096 for v in configure) and
            REQUIRED_FLAGS.issubset(configure) and
            not any(v.startswith(("--enable-gpl", "--enable-nonfree", "--enable-version3",
                                  "--enable-network", "--enable-autodetect")) for v in configure) and
            not any(v in FORBIDDEN_FLAGS for v in configure),
            "configure provenance lacks the encoder contract "
            "(feature disables are forbidden; restrictions required)")
    binary_rel = relative(binary.get("path")).as_posix()
    require(binary.get("mode") == "0755", "manifest binary mode must be 0755")
    payload, mode = read_local(root, binary_rel, MAX_BINARY_BYTES)
    require(mode == 0o755 and digest(payload) == sha(binary.get("sha256")),
            "binary hash or executable mode mismatch")
    inspected = inspect_macho(payload)
    materials = m.get("materials")
    require(isinstance(materials, list) and 4 <= len(materials) <= 64,
            "missing bounded provenance/license materials")
    selected, paths, roles, hashes, total = [], {binary_rel, rel}, set(), set(), len(payload) + len(raw)
    for item in materials:
        require(isinstance(item, dict) and item.get("role") in MATERIAL_ROLES, "invalid material role")
        name = relative(item.get("path")).as_posix()
        require(name not in paths, "duplicate material path")
        paths.add(name)
        content, _ = read_local(root, name, MAX_MATERIAL_BYTES)
        checksum = sha(item.get("sha256"))
        require(digest(content) == checksum, "material hash mismatch")
        total += len(content)
        require(total <= MAX_TOTAL_BYTES, "staging input byte cap exceeded")
        roles.add(item["role"])
        hashes.add(checksum)
        selected.append((name, content))
    require(roles == MATERIAL_ROLES and archive_sha in hashes and signature_sha in hashes,
            "source archive, signature or required materials missing")
    return raw, payload, selected, inspected


def publish_new_directory(source, destination):
    """macOS's exclusive rename atomically refuses every existing destination."""
    require(sys.platform == "darwin", "exclusive staging publication requires macOS")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(destination), 0x00000004) != 0:  # RENAME_EXCL
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(destination))


def write_new(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def stage_payload(source_root, manifest_path, destination):
    raw, payload, materials, inspected = checked_inputs(source_root, manifest_path)
    destination = Path(destination).absolute()
    require(destination.name not in ("", ".", "..") and not destination.is_symlink(),
            "invalid destination")
    parent = directory(destination.parent)
    destination = parent / destination.name
    require(not destination.exists(), "destination already exists; no overwrite")
    staging = Path(tempfile.mkdtemp(prefix=".ffmpeg-encoder-stage-", dir=parent))
    try:
        write_new(staging / "runtime/ffmpeg/ffmpeg", payload, 0o755)
        legal = staging / "licenses/ffmpeg-encoder"
        write_new(legal / "manifest.json", raw, 0o644)
        for name, content in materials:
            write_new(legal / "materials" / name, content, 0o644)
        os.chmod(staging, 0o755)
        publish_new_directory(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {"version": VERSION, "sha256": digest(payload), "destination": str(destination),
            "inspection": inspected, "release_or_license_clearance": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "build-ffmpeg-encoder/payload")
    args = parser.parse_args()
    expected = Path(__file__).resolve().parents[1] / "build-ffmpeg-encoder/payload"
    try:
        require(args.output.absolute() == expected, "CLI output is restricted to build-ffmpeg-encoder/payload")
        print(json.dumps(stage_payload(args.source_root, args.manifest, args.output), indent=2))
    except (StageError, OSError) as exc:
        parser.exit(1, "ffmpeg encoder staging refused: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
