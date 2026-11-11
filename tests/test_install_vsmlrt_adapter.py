"""Inert adapter publication tests; no download, 7z, or adapter import.

Installer source import is passive. Main-path tests replace every download/tool
port before invocation and use a tiny checksum-bound dummy archive and module.
"""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "scripts/install_vsmlrt_adapter.py"
SPEC = importlib.util.spec_from_file_location("vsres_inert_adapter_installer", SOURCE)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
OLD = b"INERT OLD ADAPTER, NEVER IMPORTED\n"
NEW = b"INERT NEW ADAPTER, NEVER IMPORTED\n"


class AdapterInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vsres-adapter-inert-",
            dir=os.environ.get("VSRES_INSTALLER_TEST_ROOT"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target_dir = self.root / "helpers"
        self.target_dir.mkdir(mode=0o700)
        self.source = self.root / "inert-source.py"
        self.source.write_bytes(NEW)
        self.source.chmod(0o644)
        self.target = self.target_dir / "vsmlrt.py"

    @contextlib.contextmanager
    def main_fixture(self):
        models = self.root / "models"
        models.mkdir()
        archive = models / "scripts.v15.16.7z"
        archive.write_bytes(b"INERT ARCHIVE, NEVER EXTRACTED\n")
        real_exists, real_mkdtemp = os.path.exists, tempfile.mkdtemp
        def exists(path):
            if str(path) in ("/opt/homebrew/bin/7z", "/opt/homebrew/bin/7za", "/usr/local/bin/7z"):
                return str(path) == "/opt/homebrew/bin/7z"
            self.assertTrue(Path(path).is_relative_to(self.root))
            return real_exists(path)
        def owned_stage(*, prefix):
            self.assertEqual(prefix, "vsmlrt-scripts-")
            return real_mkdtemp(prefix=prefix, dir=self.root)
        def fake_extract(argv, *, capture_output):
            self.assertTrue(capture_output)
            self.assertEqual(argv[:3], ["/opt/homebrew/bin/7z", "x", "-y"])
            staging = Path(argv[3][2:])
            self.assertTrue(staging.is_relative_to(self.root))
            self.assertEqual(Path(argv[4]), archive)
            (staging / "vsmlrt.py").write_bytes(NEW)
            return types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        with mock.patch.object(M, "MODELS_DIR", str(models)), \
             mock.patch.object(M, "TARGET_DIR", str(self.target_dir)), \
             mock.patch.object(M, "SHA", hashlib.sha256(archive.read_bytes()).hexdigest()), \
             mock.patch.object(M.os.path, "exists", side_effect=exists), \
             mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage), \
             mock.patch.object(M.subprocess, "run", side_effect=fake_extract) as tool, \
             mock.patch.object(M.urllib.request, "urlretrieve", side_effect=AssertionError("No download allowed")) as download, \
             contextlib.redirect_stdout(io.StringIO()):
            yield
            self.assertEqual(tool.call_count, 1)
            download.assert_not_called()

    def assertNoTemps(self):
        self.assertEqual(list(self.target_dir.glob(".vsmlrt-adapter-*")), [])

    def test_main_copy_failure_preserves_previous_adapter(self):
        self.target.write_bytes(OLD)
        before = self.target.stat()
        with self.main_fixture(), \
             mock.patch.object(M.shutil, "copyfile", side_effect=OSError("synthetic copy failure")), \
             mock.patch.object(M.shutil, "copyfileobj", side_effect=OSError("synthetic copy failure")):
            with self.assertRaisesRegex(OSError, "synthetic copy failure"):
                M.main()
        self.assertTrue(self.target.exists(), "copy failure must retain the prior adapter")
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertNoTemps()

    def test_main_dangling_destination_is_replaced_without_outside_write(self):
        outside = self.root / "outside-helper-dir"
        self.target.symlink_to(outside)
        with self.main_fixture():
            M.main()
        self.assertFalse(outside.exists(), "the main installer must not follow a dangling destination")
        self.assertFalse(self.target.is_symlink())
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertNoTemps()

    def test_existing_regular_adapter_is_replaced_after_complete_copy(self):
        self.target.write_bytes(OLD)
        before = self.target.stat()
        M.publish_adapter(str(self.source), str(self.target))
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertNotEqual(self.target.stat().st_ino, before.st_ino)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o644)
        self.assertNoTemps()

    def test_existing_destination_link_does_not_modify_its_referent(self):
        outside = self.root / "existing-outside-helper"
        outside.write_bytes(OLD)
        before = outside.stat()
        self.target.symlink_to(outside)
        M.publish_adapter(str(self.source), str(self.target))
        self.assertFalse(self.target.is_symlink())
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertEqual(outside.read_bytes(), OLD)
        self.assertEqual(outside.stat().st_ino, before.st_ino)
        self.assertNoTemps()

    def test_partial_copy_failure_leaves_old_adapter_intact(self):
        self.target.write_bytes(OLD)
        before = self.target.stat()
        def fail_after_bytes(incoming, outgoing):
            outgoing.write(incoming.read(4))
            raise OSError("synthetic partial copy")
        with mock.patch.object(M.shutil, "copyfileobj", side_effect=fail_after_bytes):
            with self.assertRaisesRegex(OSError, "synthetic partial copy"):
                M.publish_adapter(str(self.source), str(self.target))
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertNoTemps()

    def test_replacement_failure_preserves_old_adapter_and_primary_error(self):
        self.target.write_bytes(OLD)
        before = self.target.stat()
        with mock.patch.object(M.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "synthetic publication failure"):
                M.publish_adapter(str(self.source), str(self.target))
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertNoTemps()

    def test_directory_destination_is_not_removed_or_replaced(self):
        self.target.mkdir()
        before = self.target.stat()
        with self.assertRaises(OSError):
            M.publish_adapter(str(self.source), str(self.target))
        self.assertTrue(self.target.is_dir())
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertNoTemps()

    def test_symlink_source_is_refused_before_destination_creation(self):
        alias = self.root / "source-alias.py"
        alias.symlink_to(self.source)
        with self.assertRaises(OSError):
            M.publish_adapter(str(alias), str(self.target))
        self.assertFalse(self.target.exists())
        self.assertNoTemps()

    def test_new_adapter_publication_preserves_source_bytes_and_identity(self):
        before = self.source.stat()
        M.publish_adapter(str(self.source), str(self.target))
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertEqual(self.source.read_bytes(), NEW)
        self.assertEqual(self.source.stat().st_ino, before.st_ino)
        self.assertEqual(self.source.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertNoTemps()


if __name__ == "__main__":
    unittest.main()
