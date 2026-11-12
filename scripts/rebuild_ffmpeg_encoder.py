#!/usr/bin/env python3
"""Unqualified recipient rebuild recipe for the ffmpeg ENCODER helper;
never installs or launches it.

Sibling of rebuild_ffprobe.py: same pinned source, signature policy and
recording discipline; the only deltas are the make target (`ffmpeg`) and the
manifest's encoder feature contract. Execution compiles the pinned included
source and needs a separately admitted build allowance. Unit tests mock every
subprocess; those are not rebuild proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

MANIFEST_SHA256 = "9ba26e3b08835d50a16973302f3c7e6453bcc7c9d9882bfac7ce91118b9838e0"
KEY_SHA256 = "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5"
SIGNER = "FCF986EA15E6E293A5644F10B4322F04D67658D8"
SOURCE_ROOT = "ffmpeg-9.0.2"


class RecipeError(ValueError):
    pass


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise RecipeError(message)


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def run_step(label, argv, work, env, cwd=None, read_stdout=False):
    """Keep original logs/status, stop on failure; no retries or shell evaluation."""
    records = work / "records"
    record = {"command": list(map(str, argv)), "cwd": str(cwd or work)}
    with (records / (label + ".stdout")).open("xb") as out, \
            (records / (label + ".stderr")).open("xb") as err:
        try:
            completed = subprocess.run(record["command"], cwd=str(cwd or work),
                                       env=env, stdin=subprocess.DEVNULL,
                                       stdout=out, stderr=err, check=False)
            record["returncode"] = completed.returncode
        except OSError as exc:
            record["dispatch_error"] = str(exc)
            write_json(records / (label + ".json"), record)
            raise RecipeError(label + " could not start; retained original result") from exc
    write_json(records / (label + ".json"), record)
    require(completed.returncode == 0, label + " failed; retained original result")
    if not read_stdout:
        return ""
    captured = records / (label + ".stdout")
    require(captured.stat().st_size <= 64 * 1024, label + " response exceeds text bound")
    return captured.read_text(encoding="utf-8", errors="replace")


def copy_input(source, destination, expected_hash, maximum_bytes):
    require(source.is_file() and source.stat().st_size <= maximum_bytes,
            "missing or oversized input: " + source.name)
    with source.open("rb") as src, destination.open("xb") as dst:
        remaining = maximum_bytes
        while True:
            block = src.read(min(1024 * 1024, remaining + 1))
            if not block:
                break
            remaining -= len(block)
            require(remaining >= 0, "input grew beyond bound: " + source.name)
            dst.write(block)
    require(sha256(destination) == expected_hash, "input hash mismatch: " + source.name)


def extract_source(archive, destination):
    """The pinned archive has only regular files/directories; reject all links."""
    with tarfile.open(archive, "r:xz") as tf:
        members = tf.getmembers()
        require(len(members) <= 12000 and sum(m.size for m in members) <= 128 * 1024 * 1024,
                "source archive exceeds reviewed extraction bounds")
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and path.parts and path.parts[0] == SOURCE_ROOT
                    and all(p not in ("", ".", "..") for p in member.name.split("/"))
                    and member.name not in seen and (member.isfile() or member.isdir()),
                    "unsupported source archive member")
            seen.add(member.name)
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                path.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with tf.extractfile(member) as src, path.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                path.chmod(member.mode & 0o777)
    return {"members": len(members), "file_bytes": sum(m.size for m in members if m.isfile())}


def rebuild(materials, output, developer_dir, gpg):
    materials, output = Path(materials).resolve(strict=True), Path(output).absolute()
    developer_dir, gpg = Path(developer_dir), Path(gpg)
    require(developer_dir.is_absolute() and developer_dir.is_dir(), "select an existing absolute developer directory")
    require(gpg.is_absolute() and gpg.is_file() and os.access(gpg, os.X_OK), "select an existing absolute GnuPG executable")
    require(not any(c.isspace() for c in str(developer_dir)), "developer path contains unsupported whitespace")
    output.mkdir(mode=0o700)  # Exclusive: existing output and all original evidence remain untouched.
    for name in ("inputs", "records", "gnupg", "home", "tmp", "source", "build"):
        (output / name).mkdir(mode=0o700)
    write_json(output / "records/recipe.json", {"recipe_sha256": sha256(Path(__file__)),
               "state": "PREPARING_UNQUALIFIED_REBUILD", "materials": str(materials)})
    manifest_copy = output / "inputs/manifest.json"
    copy_input(materials / "manifest.json", manifest_copy, MANIFEST_SHA256, 128 * 1024)
    manifest = json.loads(manifest_copy.read_text(encoding="utf-8"))
    require(manifest["version"] == "9.0.2" and manifest["source"]["signer_fingerprint"] == SIGNER,
            "unexpected pinned source identity")
    copied = {}
    for name, expected, cap in (
        ("ffmpeg-9.0.2.tar.xz", manifest["source"]["archive_sha256"], 64 * 1024 * 1024),
        ("ffmpeg-9.0.2.tar.xz.asc", manifest["source"]["signature_sha256"], 64 * 1024),
        ("ffmpeg-devel.asc", KEY_SHA256, 256 * 1024),
    ):
        copied[name] = output / "inputs" / name
        copy_input(materials / "materials/source" / name, copied[name], expected, cap)
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "LC_ALL": "C",
           "HOME": str(output / "home"), "TMPDIR": str(output / "tmp"),
           "DEVELOPER_DIR": str(developer_dir)}
    gpg_base = [str(gpg), "--no-options", "--homedir", str(output / "gnupg"),
                "--batch", "--no-auto-key-retrieve"]
    run_step("key-import", gpg_base + ["--import", str(copied["ffmpeg-devel.asc"])], output, env)
    status = run_step("signature", gpg_base + ["--status-fd", "1", "--verify",
                      str(copied["ffmpeg-9.0.2.tar.xz.asc"]), str(copied["ffmpeg-9.0.2.tar.xz"])], output, env, read_stdout=True)
    require(any(line.startswith("[GNUPG:] VALIDSIG " + SIGNER + " ") for line in status.splitlines()),
            "expected signature fingerprint absent")
    cc = run_step("compiler-path", ["/usr/bin/xcrun", "--sdk", "macosx", "--find", "clang"], output, env, read_stdout=True).strip()
    sdk = run_step("sdk-path", ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], output, env, read_stdout=True).strip()
    require(Path(cc).is_absolute() and Path(sdk).is_absolute() and
            not any(c.isspace() for c in cc + sdk), "compiler/SDK paths unsupported")
    require(Path(cc).is_file() and os.access(cc, os.X_OK) and Path(sdk).is_dir(),
            "selected compiler or SDK unavailable")
    env.update(PATH=str(Path(cc).parent) + ":" + str(developer_dir / "usr/bin") + ":" + env["PATH"],
               SDKROOT=sdk, MACOSX_DEPLOYMENT_TARGET="13.0", PKG_CONFIG="/usr/bin/false")
    flags = "-arch arm64 -mmacosx-version-min=13.0 -isysroot " + sdk
    for key in ("CFLAGS", "CXXFLAGS", "OBJCFLAGS", "ASFLAGS", "LDFLAGS"):
        env[key] = flags
    write_json(output / "records/environment.json", env)
    run_step("compiler-version", [cc, "--version"], output, env)
    run_step("sdk-version", ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"], output, env)
    extraction = extract_source(copied["ffmpeg-9.0.2.tar.xz"], output / "source")
    write_json(output / "records/extraction.json", extraction)
    # The hash-pinned manifest is the one source of feature-selection arguments.
    configure = [("--cc=" + cc) if flag.startswith("--cc=") else
                 ("--host-cc=" + cc) if flag.startswith("--host-cc=") else flag
                 for flag in manifest["build"]["configure"]]
    build = output / "build"
    run_step("configure", [str(output / "source" / SOURCE_ROOT / "configure"), *configure], output, env, build)
    run_step("make", ["/usr/bin/make", "-j2", "ffmpeg"], output, env, build)
    helper = build / "ffmpeg"
    require(helper.is_file() and not helper.is_symlink(), "build did not produce an ordinary ffmpeg file")
    for label, command in (("file", ["/usr/bin/file", str(helper)]),
                           ("architecture", ["/usr/bin/lipo", "-info", str(helper)]),
                           ("libraries", ["/usr/bin/otool", "-L", str(helper)]),
                           ("load-commands", ["/usr/bin/otool", "-l", str(helper)])):
        run_step(label, command, output, env)
    result = {"state": "BUILD_COMPLETED_UNQUALIFIED", "helper_sha256": sha256(helper),
              "helper_executed": False, "release_or_license_clearance": False}
    write_json(output / "records/result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--materials", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--developer-dir", required=True, type=Path)
    parser.add_argument("--gpg", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(rebuild(args.materials, args.output, args.developer_dir, args.gpg), indent=2))
    except (RecipeError, OSError, ValueError, KeyError, tarfile.TarError) as exc:
        parser.exit(1, "Recipe stopped; retain output and original evidence: " + str(exc) + "\n")


if __name__ == "__main__":
    main()
