#!/usr/bin/env python3
"""One-shot: fetch the vs-mlrt v15.16 adapter scripts (official release asset),
verify the published sha256, extract, and install the vsmlrt package into the
chain evaluation environment so RIFE becomes actually runnable.

Integrity: the digest below is the one PUBLISHED on the official GitHub
release (github.com/AmusementClub/vs-mlrt v15.16, asset scripts.v15.16.7z);
the download is verified against it before extraction. Nothing from the
archive is executed; only .py files are placed on the import path. The
replacement is prepared completely before atomically replacing the adapter leaf;
a failed copy preserves the prior module and destination links are not followed.
"""
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

URL = "https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/scripts.v15.16.7z"
SHA = "d07dae0a00cb8dbf4f00358f640f630ff5d933de44d27050e7acce4f31cc3560"
MODELS_DIR = os.path.expanduser(
    "~/Library/Application Support/VapourSynth-OFX/models/vsmlrt-models-v15.16")
# The chain evaluation environment's helper path (same place havsfunc lives).
TARGET_DIR = os.path.expanduser("~/Library/Application Support/VapourSynth-OFX/vs-python")


def die(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def publish_adapter(source, target):
    """Atomically replace this named adapter after a complete regular-file copy.

    This is explicit replacement, not no-overwrite publication or an inode CAS.
    Replacing the leaf does not follow a dangling/existing destination symlink.
    """
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(source_fd, "rb") as incoming:
        source_stat = os.fstat(incoming.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("adapter source is not a regular file")
        fd, temporary = tempfile.mkstemp(prefix=".vsmlrt-adapter-", dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, "wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
                os.fchmod(outgoing.fileno(), stat.S_IMODE(source_stat.st_mode))
                outgoing.flush()
                os.fsync(outgoing.fileno())
            os.replace(temporary, target)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass  # Successful replace consumed the temporary name.
            except OSError as error:
                print(f"WARNING: retained adapter temporary file {temporary}: {error}",
                      file=sys.stderr)


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    archive = os.path.join(MODELS_DIR, "scripts.v15.16.7z")
    if not os.path.exists(archive):
        print(f"downloading {URL} …")
        try:
            urllib.request.urlretrieve(URL, archive)
        except Exception as e:
            die(f"download failed: {e}")
    h = hashlib.sha256()
    with open(archive, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    print(f"sha256: {digest}")
    if digest != SHA:
        os.unlink(archive)
        die(f"checksum mismatch (expected {SHA}); archive discarded")
    print("checksum verified against the upstream-published digest")

    # Extract with 7z (detected locally; never a downloaded installer).
    seven = None
    for p in ("/opt/homebrew/bin/7z", "/opt/homebrew/bin/7za", "/usr/local/bin/7z"):
        if os.path.exists(p):
            seven = p
            break
    if not seven:
        die("no 7z extractor found (brew install p7zip)")
    staging = tempfile.mkdtemp(prefix="vsmlrt-scripts-")
    rc = subprocess.run([seven, "x", "-y", f"-o{staging}", archive],
                        capture_output=True)
    if rc.returncode != 0:
        shutil.rmtree(staging, ignore_errors=True)
        die(f"7z extraction failed: {rc.stderr.decode()[:200]}")

    # Locate the vsmlrt module inside the extraction (upstream ships a single
    # vsmlrt.py module in scripts.v15.16.7z — not a package).
    vsmlrt = None
    for root, _dirs, files in os.walk(staging):
        if "vsmlrt.py" in files:
            vsmlrt = os.path.join(root, "vsmlrt.py")
            break
    if not vsmlrt:
        shutil.rmtree(staging, ignore_errors=True)
        die("archive contains no vsmlrt module")

    dest = os.path.join(TARGET_DIR, "vsmlrt.py")
    publish_adapter(vsmlrt, dest)
    shutil.rmtree(staging, ignore_errors=True)
    print(f"installed vsmlrt adapter module -> {dest}")
    print("ADAPTER INSTALLED: RIFE invocation path now present. "
          "Verify with scripts/probe_rife.py.")


if __name__ == "__main__":
    main()