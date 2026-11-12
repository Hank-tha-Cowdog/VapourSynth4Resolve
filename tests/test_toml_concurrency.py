"""Owned inert filesystem/threads only; no runtime, bundle code or owner config runs."""
import contextlib
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
import tomllib
import types
import unittest

SOURCE = Path(os.environ.get("VSRES_TOML_SOURCE",
    str(Path(__file__).resolve().parents[1] / "scripts/install_ofx_toml.py")))
BASELINE = os.environ.get("VSRES_TOML_BASELINE") == "1"
if not os.environ.get("VSRES_TOML_TEST_ROOT"):
    # The fixtures require an explicit private 0700 fixture root. A fresh CI
    # checkout has none; release validation sets VSRES_TOML_TEST_ROOT (and
    # VSRES_TOML_SOURCE when auditing a staged helper) and exercises them.
    print("SKIP: VSRES_TOML_TEST_ROOT is not set — provide a private fixture root "
          "(release validation).")
    raise SystemExit(0)
BASELINE_METHODS = {
    "test_concurrent_helpers_re_read_after_lock_and_keep_both_registrations",
    "test_external_edit_before_publication_is_preserved",
    "test_absent_target_publication_never_replaces_external_creator",
    "test_linked_targets_refuse_without_changing_links_or_referents",
    "test_existing_mode_and_unrelated_crlf_bytes_are_preserved",
}


class Port:
    def __init__(self, original, **overrides):
        self.original, self.overrides = original, overrides

    def __getattr__(self, name):
        if name in self.overrides:
            return self.overrides[name]
        return getattr(self.original, name)


class TomlConcurrencyTests(unittest.TestCase):
    def setUp(self):
        # No fallback to the machine's ordinary temp tree: the runner must bind it.
        fixture_root = Path(os.environ["VSRES_TOML_TEST_ROOT"])
        self.assertTrue(fixture_root.is_dir() and not fixture_root.is_symlink())
        self.temp = tempfile.TemporaryDirectory(prefix="toml-case-", dir=fixture_root)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "config" / "vapoursynth.toml"
        self.bundle_a = self.bundle("A.ofx.bundle")
        self.bundle_b = self.bundle("B.ofx.bundle")

    def bundle(self, name):
        bundle = self.root / name
        version = bundle / "Contents/Frameworks/Python.framework/Versions/3.14"
        (version / "bin").mkdir(parents=True)
        (bundle / "Contents/Libraries").mkdir()
        for file in [bundle / "Contents/Libraries/libvsscript.dylib",
                     version / "Python", version / "bin/python3.14"]:
            file.write_bytes(b"INERT MARKER, NEVER EXECUTED OR LOADED\n")
        return bundle

    def module(self, suffix):
        spec = importlib.util.spec_from_file_location("inert_toml_" + suffix, SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.sys = types.SimpleNamespace(argv=[], stderr=io.StringIO())
        return module

    def invoke(self, module, *, bundle=None, target=None, extra=()):
        module.sys.argv = ["install_ofx_toml.py", "--bundle", str(bundle or self.bundle_a),
                           "--toml", str(target or self.target), *extra]
        return module.main()

    def existing(self, body=b'keep = "INITIAL"\n'):
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.target.write_bytes(body)
        return self.target.stat()

    def lock_path(self, target=None):
        target = target or self.target
        return target.with_name("." + target.name + ".vsres.lock")

    def hold_lock(self, target=None):
        lock = self.lock_path(target)
        lock.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        return lock, fd

    def test_concurrent_helpers_re_read_after_lock_and_keep_both_registrations(self):
        self.existing()
        a, b = self.module("a"), self.module("b")
        at_publish, b_planned, release = threading.Event(), threading.Event(), threading.Event()
        results, errors = {}, {}
        real_replace, real_link = a.os.replace, a.os.link

        def paused_publish(operation):
            def call(source, target, *args, **kwargs):
                if Path(target) == self.target:
                    at_publish.set()
                    if not release.wait(3):
                        raise AssertionError("test failed to release its owned first writer")
                return operation(source, target, *args, **kwargs)
            return call

        a.os = Port(a.os, replace=paused_publish(real_replace), link=paused_publish(real_link))
        real_plan = b.plan_registration

        def observed_plan(*args):
            result = real_plan(*args)
            b_planned.set()  # Both original callers now have a stale plan before A publishes.
            return result

        b.plan_registration = observed_plan

        def run(name, module, bundle):
            try:
                results[name] = self.invoke(module, bundle=bundle)
            except BaseException as error:
                errors[name] = error

        first = threading.Thread(target=run, args=("a", a, self.bundle_a), daemon=True)
        second = threading.Thread(target=run, args=("b", b, self.bundle_b), daemon=True)
        first.start()
        try:
            self.assertTrue(at_publish.wait(2), "first writer reaches its final publication")
            second.start()
            self.assertTrue(b_planned.wait(2), "second writer planned before first publication")
        finally:
            release.set()
            first.join(6)
            if second.ident is not None:
                second.join(6)
        self.assertFalse(first.is_alive() or second.is_alive(), "owned writer threads closed")
        self.assertEqual(errors, {})
        self.assertEqual(results, {"a": 0, "b": 0})
        parsed = tomllib.loads(self.target.read_text(encoding="utf-8"))
        self.assertEqual(parsed["keep"], "INITIAL")
        for bundle in [self.bundle_a, self.bundle_b]:
            key = str(bundle.resolve() / "Contents/Libraries/libvsscript.dylib")
            self.assertIn(key, parsed, "a successful concurrent registration must not disappear")

    def test_external_edit_before_publication_is_preserved(self):
        self.existing()
        module = self.module("external")
        real_mkstemp = module.tempfile.mkstemp
        external = b'keep = "EXTERNAL"\nextra = true\n'

        def changed(*args, **kwargs):
            self.target.write_bytes(external)
            return real_mkstemp(*args, **kwargs)

        module.tempfile = Port(module.tempfile, mkstemp=changed)
        result = self.invoke(module)
        self.assertEqual((result, self.target.read_bytes()), (1, external))
        self.assertEqual(list(self.target.parent.glob(".toml.*")), [])

    def test_absent_target_publication_never_replaces_external_creator(self):
        module = self.module("creator")
        real_replace, real_link = module.os.replace, module.os.link
        external = b'keep = "CREATED EXTERNALLY"\n'

        def raced(operation):
            def call(source, target, *args, **kwargs):
                if Path(target) == self.target:
                    self.assertFalse(self.target.exists())
                    self.target.write_bytes(external)
                return operation(source, target, *args, **kwargs)
            return call

        module.os = Port(module.os, replace=raced(real_replace), link=raced(real_link))
        result = self.invoke(module)
        self.assertEqual((result, self.target.read_bytes()), (1, external))
        self.assertEqual(list(self.target.parent.glob(".toml.*")), [])

    def test_linked_targets_refuse_without_changing_links_or_referents(self):
        self.target.parent.mkdir()
        for kind in ["symlink", "dangling", "hardlink"]:
            with self.subTest(kind=kind):
                module = self.module(kind)
                target = self.target.with_name(kind + ".toml")
                sentinel = self.root / (kind + "-outside-model.toml")
                if kind != "dangling":
                    sentinel.write_bytes(b'keep = "SENTINEL"\n')
                if kind == "hardlink":
                    os.link(sentinel, target)
                else:
                    target.symlink_to(sentinel)
                identity = target.lstat()
                self.assertEqual(self.invoke(module, target=target), 1)
                self.assertEqual(target.lstat().st_ino, identity.st_ino)
                self.assertEqual(target.is_symlink(), kind != "hardlink")
                if kind == "dangling":
                    self.assertFalse(sentinel.exists())
                else:
                    self.assertEqual(sentinel.read_bytes(), b'keep = "SENTINEL"\n')

    def test_existing_mode_and_unrelated_crlf_bytes_are_preserved(self):
        body = b'# retained bytes\r\nkeep = "EXACT"\r\n[other]\r\nflag = true\r\n'
        self.existing(body)
        self.target.chmod(0o640)
        group = self.target.stat().st_gid
        self.assertEqual(self.invoke(self.module("metadata")), 0)
        self.assertEqual((stat.S_IMODE(self.target.stat().st_mode),
                          self.target.read_bytes().endswith(body), self.target.stat().st_gid),
                         (0o640, True, group))

    def test_lock_links_and_nonprivate_modes_refuse_without_config_write(self):
        for kind in ["symlink", "dangling", "hardlink", "public"]:
            with self.subTest(kind=kind):
                target = self.target.with_name(kind + ".toml")
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(b"keep = true\n")
                lock = self.lock_path(target)
                sentinel = self.root / (kind + "-lock-sentinel")
                if kind != "dangling":
                    sentinel.write_bytes(b"LOCK SENTINEL\n")
                if kind == "hardlink":
                    os.link(sentinel, lock)
                elif kind == "public":
                    lock.write_bytes(b"OWNER LOCK BYTES\n")
                    lock.chmod(0o644)
                else:
                    lock.symlink_to(sentinel)
                identity = lock.lstat()
                self.assertEqual(self.invoke(self.module("lock-" + kind), target=target), 1)
                self.assertEqual(target.read_bytes(), b"keep = true\n")
                self.assertEqual(lock.lstat().st_ino, identity.st_ino)

    def test_busy_lock_is_bounded_and_api_cli_allow_finite_wait_selection(self):
        self.existing()
        module = self.module("busy")
        lock, fd = self.hold_lock()
        start = time.monotonic()
        with self.assertRaisesRegex(ValueError, "holds the lock"):
            module.update_registration(self.target, "new", ["python", "library"], lock_timeout=0.02)
        self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(self.target.read_bytes(), b'keep = "INITIAL"\n')
        identity = lock.stat()
        fcntl.flock(fd, fcntl.LOCK_UN)
        self.assertEqual(self.invoke(module, extra=("--lock-timeout", "20")), 0)
        self.assertEqual(lock.stat().st_ino, identity.st_ino)

    def test_invalid_wait_settings_refuse_before_target_directory_creation(self):
        module = self.module("invalid-wait")
        for value in [0, -1, True, float("nan"), float("inf"), 10 ** 1000, "10"]:
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "positive finite"):
                    module.update_registration(self.target, "new", ["python", "library"], lock_timeout=value)
                self.assertFalse(self.target.parent.exists())
        for value in ["0", "-1", "nan", "inf", "bad"]:
            self.assertEqual(self.invoke(module, extra=("--lock-timeout", value)), 1)
            self.assertFalse(self.target.parent.exists())

    def test_dry_run_does_not_acquire_or_change_an_existing_busy_lock(self):
        self.existing()
        lock, _ = self.hold_lock()
        before = self.target.read_bytes(), self.target.stat(), lock.stat()
        self.assertEqual(self.invoke(self.module("dry"), extra=("--dry-run",)), 0)
        self.assertEqual(self.target.read_bytes(), before[0])
        self.assertEqual(self.target.stat().st_ino, before[1].st_ino)
        self.assertEqual(lock.stat().st_ino, before[2].st_ino)
        self.assertEqual(list(self.target.parent.glob(".toml.*")), [])

    def test_replace_failure_cleans_only_owned_stage_and_preserves_old_config(self):
        self.existing()
        module = self.module("replace-error")

        def failed(*args, **kwargs):
            raise OSError("synthetic atomic replace refusal")

        module.os = Port(module.os, replace=failed)
        with self.assertRaisesRegex(OSError, "atomic replace refusal"):
            self.invoke(module)
        self.assertEqual(self.target.read_bytes(), b'keep = "INITIAL"\n')
        self.assertEqual(list(self.target.parent.glob(".toml.*")), [])
        self.assertTrue(self.lock_path().is_file())

    def test_replaced_stage_is_not_deleted_by_failure_cleanup(self):
        self.existing()
        module = self.module("stage-replaced")
        replacement = []

        def failed(source, target):
            other = self.root / "distinct-replacement"
            other.write_bytes(b"REPLACEMENT FILE, NOT OWNED TEMP\n")
            os.replace(other, source)  # Both inodes existed before replacement.
            replacement.append(Path(source))
            raise OSError("synthetic publication failure after stage replacement")

        module.os = Port(module.os, replace=failed)
        with self.assertRaisesRegex(OSError, "stage replacement"):
            self.invoke(module)
        self.assertEqual(len(replacement), 1)
        self.assertEqual(replacement[0].read_bytes(), b"REPLACEMENT FILE, NOT OWNED TEMP\n")
        self.assertEqual(self.target.read_bytes(), b'keep = "INITIAL"\n')

    def test_replaced_lock_is_detected_before_publication(self):
        self.existing()
        module = self.module("lock-replaced")
        real_mkstemp = module.tempfile.mkstemp
        lock = self.lock_path()

        def changed(*args, **kwargs):
            result = real_mkstemp(*args, **kwargs)
            lock.rename(lock.with_name(lock.name + ".original-owned"))
            lock.write_bytes(b"NEW LOCK ENTRY\n")
            lock.chmod(0o600)
            return result

        module.tempfile = Port(module.tempfile, mkstemp=changed)
        self.assertEqual(self.invoke(module), 1)
        self.assertEqual(self.target.read_bytes(), b'keep = "INITIAL"\n')
        self.assertEqual(lock.read_bytes(), b"NEW LOCK ENTRY\n")
        self.assertEqual(list(self.target.parent.glob(".toml.*")), [])


def load_tests(loader, tests, pattern):
    if BASELINE:
        return unittest.TestSuite(TomlConcurrencyTests(name) for name in sorted(BASELINE_METHODS))
    return tests


if __name__ == "__main__":
    unittest.main()
