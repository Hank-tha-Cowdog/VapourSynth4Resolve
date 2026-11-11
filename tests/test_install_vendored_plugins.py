"""Inert-byte installer tests; never load plugins or run install_name_tool.

The native probe/tool entry points are replaced before main() is entered. Every
real filesystem effect is confined to an owned temporary fixture. No real user
plugin directory is queried or changed.
"""
import contextlib
import errno
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "scripts/install_vendored_plugins.py"
SPEC = importlib.util.spec_from_file_location("vsres_inert_plugin_installer", SOURCE)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)  # Passive constants/functions only; main is not called.


class PluginInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vsres-installer-inert-",
            dir=os.environ.get("VSRES_INSTALLER_TEST_ROOT"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plugins = self.root / "plugins"
        self.plugins.mkdir(mode=0o700)
        self.source = self.root / "inert.dylib"
        self.source.write_bytes(b"INERT TEST BYTES, NEVER LOADED\n")
        self.source.chmod(0o755)
        self.target = self.plugins / "inert.dylib"

    def assertNoTemps(self):
        self.assertEqual(list(self.plugins.glob(".vsres-plugin-*")), [])

    def test_baseline_failure_refuses_before_staging_or_native_tool(self):
        vendor = self.root / "empty-vendor"
        vendor.mkdir()
        real_mkdtemp = tempfile.mkdtemp
        def owned_stage(*, prefix):
            return real_mkdtemp(prefix=prefix, dir=self.root)
        with mock.patch.object(M, "load_namespaces", return_value=None) as probe, \
             mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage) as stage, \
             mock.patch.object(M.subprocess, "run") as tool, \
             mock.patch.object(M, "VENDOR_LIB", str(vendor)), \
             mock.patch.object(M, "USER_PLUGINS", str(self.plugins)), \
             mock.patch.object(M.sys, "argv", ["install_vendored_plugins.py"]), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(M.main(), 1)
        probe.assert_called_once_with(str(self.plugins), set())
        stage.assert_not_called()
        tool.assert_not_called()
        self.assertEqual(list(self.plugins.iterdir()), [])

    def test_successful_empty_baseline_can_install_with_native_ports_mocked(self):
        vendor = self.root / "vendor"
        vendor.mkdir()
        (vendor / "inert.dylib").write_bytes(self.source.read_bytes())
        real_mkdtemp = tempfile.mkdtemp
        calls = []
        def owned_stage(*, prefix):
            self.assertEqual(prefix, "vsres-plugin-stage-")
            return real_mkdtemp(prefix=prefix, dir=self.root)
        def inert_tool(argv, *, capture_output):
            calls.append(argv)
            self.assertTrue(capture_output)
            self.assertEqual(argv[:4], ["install_name_tool", "-change", M.BAD_RPATH, M.FIX_RPATH])
            self.assertTrue(Path(argv[4]).is_relative_to(self.root))
            return types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        with mock.patch.object(M, "load_namespaces", side_effect=[[], ["inert"]]), \
             mock.patch.object(M, "VENDOR_LIB", str(vendor)), \
             mock.patch.object(M, "USER_PLUGINS", str(self.plugins)), \
             mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage), \
             mock.patch.object(M.subprocess, "run", side_effect=inert_tool), \
             mock.patch.object(M.sys, "argv", ["install_vendored_plugins.py"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(), 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.target.read_bytes(), self.source.read_bytes())
        self.assertNoTemps()

    def test_publication_copies_bytes_and_mode_without_modifying_source(self):
        before = self.source.stat()
        self.assertTrue(M.publish_plugin(str(self.source), str(self.target)))
        self.assertEqual(self.target.read_bytes(), self.source.read_bytes())
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o755)
        self.assertEqual(self.target.stat().st_nlink, 1)
        self.assertEqual(self.source.stat().st_ino, before.st_ino)
        self.assertEqual(self.source.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertNoTemps()

    def test_existing_regular_target_keeps_inode_and_bytes(self):
        self.target.write_bytes(b"EXISTING USER PLUGIN\n")
        before = self.target.stat()
        self.assertFalse(M.publish_plugin(str(self.source), str(self.target)))
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertEqual(self.target.read_bytes(), b"EXISTING USER PLUGIN\n")
        self.assertNoTemps()

    def test_dangling_target_link_is_preserved_and_never_followed(self):
        outside = self.root / "not-in-plugin-dir"
        self.target.symlink_to(outside)
        before = self.target.lstat()
        vendor = self.root / "vendor"
        vendor.mkdir()
        (vendor / "inert.dylib").write_bytes(self.source.read_bytes())
        real_mkdtemp = tempfile.mkdtemp
        def owned_stage(*, prefix):
            return real_mkdtemp(prefix=prefix, dir=self.root)
        with mock.patch.object(M, "load_namespaces", side_effect=[[], ["inert"]]), \
             mock.patch.object(M, "VENDOR_LIB", str(vendor)), \
             mock.patch.object(M, "USER_PLUGINS", str(self.plugins)), \
             mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage), \
             mock.patch.object(M.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)), \
             mock.patch.object(M.sys, "argv", ["install_vendored_plugins.py"]), \
             contextlib.redirect_stdout(io.StringIO()):
            M.main()
        self.assertFalse(outside.exists(), "the real main path must not follow a dangling target")
        self.assertFalse(M.publish_plugin(str(self.source), str(self.target)))
        self.assertTrue(self.target.is_symlink())
        self.assertEqual(self.target.lstat().st_ino, before.st_ino)
        self.assertEqual(os.readlink(self.target), str(outside))
        self.assertFalse(outside.exists())
        self.assertNoTemps()

    def test_existing_directory_target_is_preserved(self):
        self.target.mkdir()
        before = self.target.stat()
        self.assertFalse(M.publish_plugin(str(self.source), str(self.target)))
        self.assertEqual(self.target.stat().st_ino, before.st_ino)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertNoTemps()

    def test_racing_final_creator_wins_without_overwrite_or_fallback(self):
        real_link = os.link
        winner = []
        def link_after_race(source, target, **kwargs):
            self.assertEqual(kwargs, {"follow_symlinks": False})
            Path(target).write_bytes(b"RACE WINNER\n")
            winner.append(Path(target).stat().st_ino)
            return real_link(source, target, **kwargs)
        with mock.patch.object(M.os, "link", side_effect=link_after_race):
            self.assertFalse(M.publish_plugin(str(self.source), str(self.target)))
        self.assertEqual(self.target.stat().st_ino, winner[0])
        self.assertEqual(self.target.read_bytes(), b"RACE WINNER\n")
        self.assertNoTemps()

    def test_copy_failure_never_publishes_or_loses_primary_error(self):
        with mock.patch.object(M.shutil, "copyfileobj", side_effect=OSError("synthetic copy failure")):
            with self.assertRaisesRegex(OSError, "synthetic copy failure"):
                M.publish_plugin(str(self.source), str(self.target))
        self.assertFalse(self.target.exists())
        self.assertNoTemps()

    def test_link_failure_refuses_without_copy_or_rename_fallback(self):
        with mock.patch.object(M.os, "link", side_effect=OSError(errno.EXDEV, "synthetic unsupported link")):
            with self.assertRaises(OSError) as caught:
                M.publish_plugin(str(self.source), str(self.target))
        self.assertEqual(caught.exception.errno, errno.EXDEV)
        self.assertFalse(self.target.exists())
        self.assertNoTemps()

    def test_symlink_source_is_refused_before_target_creation(self):
        alias = self.root / "source-alias.dylib"
        alias.symlink_to(self.source)
        with self.assertRaises(OSError):
            M.publish_plugin(str(alias), str(self.target))
        self.assertFalse(self.target.exists())
        self.assertNoTemps()

    def test_sequential_namespace_selection_updates_after_actual_or_planned_install(self):
        for dry in (False, True):
            with self.subTest(dry_run=dry):
                case = self.root / ("planned" if dry else "actual")
                case.mkdir()
                vendor, plugins = case / "vendor", case / "plugins"
                vendor.mkdir()
                plugins.mkdir()
                for name in ("a.dylib", "b.dylib"):
                    (vendor / name).write_bytes(b"INERT SHARED-NAMESPACE FIXTURE\n")
                real_mkdtemp = tempfile.mkdtemp
                observed = []
                def owned_stage(*, prefix):
                    return real_mkdtemp(prefix=prefix, dir=case)
                def fake_probe(directory, base):
                    if directory == str(plugins):
                        return []
                    names = list(Path(directory).glob("*.dylib"))
                    self.assertEqual(len(names), 1)
                    observed.append((names[0].name, set(base)))
                    return sorted({"shared"} - set(base))
                argv = ["install_vendored_plugins.py"] + (["--dry-run"] if dry else [])
                with mock.patch.object(M, "load_namespaces", side_effect=fake_probe), \
                     mock.patch.object(M, "VENDOR_LIB", str(vendor)), \
                     mock.patch.object(M, "USER_PLUGINS", str(plugins)), \
                     mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage), \
                     mock.patch.object(M.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)), \
                     mock.patch.object(M.sys, "argv", argv), \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(M.main(), 0)
                self.assertEqual(observed, [("a.dylib", set()), ("b.dylib", {"shared"})])
                self.assertEqual((plugins / "a.dylib").exists(), not dry)
                self.assertFalse((plugins / "b.dylib").exists())
                self.assertEqual(list(plugins.glob(".vsres-plugin-*")), [])

    def test_racing_final_skip_does_not_claim_unpublished_namespace(self):
        vendor = self.root / "vendor"
        vendor.mkdir()
        for name in ("a.dylib", "b.dylib"):
            (vendor / name).write_bytes(b"INERT SHARED-NAMESPACE FIXTURE\n")
        real_mkdtemp, real_publish = tempfile.mkdtemp, M.publish_plugin
        observed = []
        def owned_stage(*, prefix):
            return real_mkdtemp(prefix=prefix, dir=self.root)
        def fake_probe(directory, base):
            if directory == str(self.plugins):
                return []
            names = list(Path(directory).glob("*.dylib"))
            self.assertEqual(len(names), 1)
            observed.append((names[0].name, set(base)))
            return sorted({"shared"} - set(base))
        def racing_publish(source, target):
            if Path(target).name == "a.dylib":
                Path(target).write_bytes(b"RACE WINNER, NOT OUR PLUGIN\n")
                return False
            return real_publish(source, target)
        with mock.patch.object(M, "load_namespaces", side_effect=fake_probe), \
             mock.patch.object(M, "VENDOR_LIB", str(vendor)), \
             mock.patch.object(M, "USER_PLUGINS", str(self.plugins)), \
             mock.patch.object(M.tempfile, "mkdtemp", side_effect=owned_stage), \
             mock.patch.object(M.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)), \
             mock.patch.object(M, "publish_plugin", side_effect=racing_publish), \
             mock.patch.object(M.sys, "argv", ["install_vendored_plugins.py"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(), 0)
        self.assertEqual(observed, [("a.dylib", set()), ("b.dylib", set())])
        self.assertEqual((self.plugins / "a.dylib").read_bytes(), b"RACE WINNER, NOT OUR PLUGIN\n")
        self.assertEqual((self.plugins / "b.dylib").read_bytes(), b"INERT SHARED-NAMESPACE FIXTURE\n")
        self.assertNoTemps()


if __name__ == "__main__":
    unittest.main()
