"""Fake-bundle TOML tests; no runtime executable or owner config is accessed."""
import contextlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import stat
import tempfile
import tomllib
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "scripts/install_ofx_toml.py"
SPEC = importlib.util.spec_from_file_location("vsres_inert_toml_installer", SOURCE)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class TomlInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vsres-toml-inert-",
            dir=os.environ.get("VSRES_INSTALLER_TEST_ROOT"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.make_bundle("Fake.ofx.bundle")
        self.toml = self.root / "config" / "vapoursynth.toml"

    def make_bundle(self, name):
        bundle = self.root / name
        version = bundle / "Contents/Frameworks/Python.framework/Versions/3.14"
        (version / "bin").mkdir(parents=True)
        (bundle / "Contents/Libraries").mkdir()
        for path in [bundle / "Contents/Libraries/libvsscript.dylib",
                     version / "Python", version / "bin/python3.14"]:
            path.write_bytes(b"INERT FILE MARKER, NEVER LOADED OR EXECUTED\n")
        return bundle

    def registration(self, bundle=None):
        bundle = (bundle or self.bundle).resolve()
        version = bundle / "Contents/Frameworks/Python.framework/Versions/3.14"
        return str(bundle / "Contents/Libraries/libvsscript.dylib"), [
            str(version / "bin/python3.14"), str(version / "Python")]

    def existing(self, text):
        self.toml.parent.mkdir(parents=True, exist_ok=True)
        self.toml.write_text(text, encoding="utf-8")
        return self.toml.read_bytes()

    def invoke(self, *, bundle=None, dry=False):
        argv = ["install_ofx_toml.py", "--bundle", str(bundle or self.bundle),
                "--toml", str(self.toml)] + (["--dry-run"] if dry else [])
        with mock.patch.object(M.sys, "argv", argv), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            return M.main()

    def parse_output(self):
        try:
            return tomllib.loads(self.toml.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as error:
            self.fail(f"installer wrote malformed TOML: {error}")

    def test_dry_run_does_not_create_target_parent(self):
        self.assertFalse(self.toml.parent.exists())
        self.assertEqual(self.invoke(dry=True), 0)
        self.assertFalse(self.toml.parent.exists(), "dry-run must not create TOML directories")
        self.assertFalse(self.toml.exists())

    def test_escaped_paths_roundtrip_quotes_backslashes_controls_and_unicode(self):
        bundle = self.make_bundle('quote"-slash\\-tab\t-line\n-del\x7f-é-😀.ofx.bundle')
        self.assertEqual(self.invoke(bundle=bundle), 0)
        key, values = self.registration(bundle)
        self.assertEqual(self.parse_output(), {key: values})

    def test_root_insertion_preserves_same_key_in_unrelated_table(self):
        key, values = self.registration()
        quoted = json.dumps(key)
        self.existing(f'[other]\n{quoted} = ["nested", "keep"]\nflag = true\n')
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.parse_output(), {key: values, "other": {key: ["nested", "keep"], "flag": True}})

    def test_existing_canonical_root_registration_updates_idempotently(self):
        key, values = self.registration()
        self.existing(json.dumps(key) + ' = ["old-python", "old-library"]\nkeep = 7\nnan_marker = nan\n')
        self.assertEqual(self.invoke(), 0)
        first = self.toml.read_bytes()
        parsed = self.parse_output()
        self.assertEqual(parsed[key], values)
        self.assertEqual(parsed["keep"], 7)
        self.assertTrue(math.isnan(parsed["nan_marker"]))
        self.assertEqual(set(parsed), {key, "keep", "nan_marker"})
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.toml.read_bytes(), first)

    def test_multiline_own_registration_refuses_before_write(self):
        key, _ = self.registration()
        before = self.existing(json.dumps(key) + ' = [\n  "old-python",\n  "old-library",\n]\nkeep = true\n')
        identity = self.toml.stat()
        self.assertEqual(self.invoke(), 1)
        self.assertEqual(self.toml.read_bytes(), before)
        self.assertEqual(self.toml.stat().st_ino, identity.st_ino)
        self.assertEqual(list(self.toml.parent.glob(".toml.*")), [])

    def test_invalid_existing_toml_refuses_before_write(self):
        before = self.existing('broken = "unterminated\n')
        identity = self.toml.stat()
        self.assertEqual(self.invoke(), 1)
        self.assertEqual(self.toml.read_bytes(), before)
        self.assertEqual(self.toml.stat().st_ino, identity.st_ino)

    def test_assignment_and_table_lookalikes_inside_multiline_string_are_preserved(self):
        key, values = self.registration()
        quoted = json.dumps(key)
        original = ("notes = '''\n" + quoted + ' = ["string", "content"]\n'
            + "[not_a_real_table]\n'''\n" + quoted + ' = ["old", "old-library"]\n'
            + '[other]\n' + quoted + ' = ["nested", "value"]\n')
        before = tomllib.loads(original)
        self.existing(original)
        self.assertEqual(self.invoke(), 0)
        expected = dict(before)
        expected[key] = values
        self.assertEqual(self.parse_output(), expected)

    def test_multiline_array_contents_are_not_treated_as_table_headers(self):
        key, values = self.registration()
        original = 'items = [\n  ["nested-array"],\n  ["more"],\n]\n[other]\nflag = true\n'
        before = tomllib.loads(original)
        self.existing(original)
        self.assertEqual(self.invoke(), 0)
        expected = dict(before)
        expected[key] = values
        self.assertEqual(self.parse_output(), expected)

    def test_new_registration_is_top_level_and_private(self):
        key, values = self.registration()
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.parse_output(), {key: values})
        self.assertEqual(stat.S_IMODE(self.toml.stat().st_mode), 0o600)

    def test_existing_literal_quoted_root_key_is_replaced_without_duplicates(self):
        key, values = self.registration()
        self.existing("'" + key + "' = [\"old\", \"runtime\"]\nkeep = \"retained\"\n")
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.parse_output(), {key: values, "keep": "retained"})

    def test_basic_string_encoder_preserves_unicode_scalars_and_controls(self):
        for value in ['quote"', "back\\slash", "line\nbreak", "\t", "\x01", "\x7f", "é", "🚀"]:
            with self.subTest(value=repr(value)):
                encoded = M.toml_path_string(value)
                self.assertEqual(tomllib.loads(encoded + " = " + encoded), {value: value})

    def test_missing_standard_parser_refuses_without_filesystem_write(self):
        with mock.patch.object(M, "tomllib", None):
            self.assertEqual(self.invoke(), 1)
        self.assertFalse(self.toml.parent.exists())

    def test_incomplete_fake_bundle_refuses_before_target_creation(self):
        version = self.bundle / "Contents/Frameworks/Python.framework/Versions/3.14"
        (version / "bin/python3.14").unlink()
        self.assertEqual(self.invoke(), 1)
        self.assertFalse(self.toml.parent.exists())

    def test_failed_atomic_replace_keeps_previous_toml(self):
        before = self.existing('keep = "unchanged"\n')
        identity = self.toml.stat()
        with mock.patch.object(M.os, "replace", side_effect=OSError("synthetic replace refusal")):
            with self.assertRaisesRegex(OSError, "synthetic replace refusal"):
                self.invoke()
        self.assertEqual(self.toml.read_bytes(), before)
        self.assertEqual(self.toml.stat().st_ino, identity.st_ino)

    def test_help_does_not_require_parser_or_bundle_access(self):
        with mock.patch.object(M, "tomllib", None), \
             mock.patch.object(M, "resolve_existing", side_effect=AssertionError("No bundle access")), \
             mock.patch.object(M.sys, "argv", ["install_ofx_toml.py", "--help"]), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(M.main(), 0)


if __name__ == "__main__":
    unittest.main()
