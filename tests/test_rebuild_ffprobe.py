"""Synthetic control-flow tests: every subprocess is mocked, no tool is run."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/rebuild_ffprobe.py"
spec = importlib.util.spec_from_file_location("recipe_under_test", SCRIPT)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class RecipientRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ffprobe-recipe-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.materials = self.root / "materials"
        self.source = self.materials / "materials/source"
        self.source.mkdir(parents=True)
        self.output = self.root / "result"
        self.developer = self.root / "Developer"
        self.developer.mkdir()
        self.compiler = self.developer / "toolchain/clang"
        self.compiler.parent.mkdir()
        self.compiler.write_text("INERT COMPILER PLACEHOLDER\n")
        self.compiler.chmod(0o755)
        self.sdk = self.developer / "SDK"
        self.sdk.mkdir()
        self.gpg = self.root / "gpg-placeholder"
        self.gpg.write_text("INERT GPG PLACEHOLDER\n")
        self.gpg.chmod(0o755)
        archive = self.source / "ffmpeg-9.0.2.tar.xz"
        with tarfile.open(archive, "w:xz") as tf:
            item = tarfile.TarInfo("ffmpeg-9.0.2/configure")
            payload = b"INERT CONFIGURE PLACEHOLDER\n"
            item.size, item.mode = len(payload), 0o755
            tf.addfile(item, io.BytesIO(payload))
        signature, key = b"INERT SIGNATURE\n", b"INERT PUBLIC KEY\n"
        (self.source / "ffmpeg-9.0.2.tar.xz.asc").write_bytes(signature)
        (self.source / "ffmpeg-devel.asc").write_bytes(key)
        self.configure = ["--arch=arm64", "--target-os=darwin", "--cc=/original/clang",
                          "--host-cc=/original/clang", "--pkg-config=/usr/bin/false",
                          "--disable-shared", "--enable-static", "--disable-gpl",
                          "--disable-nonfree", "--disable-version3", "--disable-network"]
        manifest = {"version": "9.0.2", "source": {"signer_fingerprint": recipe.SIGNER,
                    "archive_sha256": digest(archive.read_bytes()), "signature_sha256": digest(signature)},
                    "build": {"configure": self.configure}}
        manifest_bytes = json.dumps(manifest).encode()
        (self.materials / "manifest.json").write_bytes(manifest_bytes)
        for name, value in (("MANIFEST_SHA256", digest(manifest_bytes)), ("KEY_SHA256", digest(key))):
            patch = mock.patch.object(recipe, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.calls = []
        self.fail_label = None
        self.dispatch_error_label = None
        self.signature_status = "[GNUPG:] VALIDSIG " + recipe.SIGNER + " 2026-09-18 remaining-fields\n"
        self.compiler_response, self.sdk_response = str(self.compiler), str(self.sdk)
        self.make_symlink = False
        patch = mock.patch.object(recipe.subprocess, "run", side_effect=self.fake_run)
        self.mock_run = patch.start()
        self.addCleanup(patch.stop)

    def fake_run(self, argv, **kwargs):
        # Any unexpected command fails inside this mock; no executable is dispatched.
        label = Path(kwargs["stdout"].name).stem
        allowed = {"key-import", "signature", "compiler-path", "sdk-path", "compiler-version",
                   "sdk-version", "configure", "make", "file", "architecture", "libraries", "load-commands"}
        self.assertIn(label, allowed)
        self.calls.append((label, list(argv), dict(kwargs["env"])))
        if label == self.dispatch_error_label:
            raise OSError("synthetic dispatch refusal")
        response = {"signature": self.signature_status, "compiler-path": self.compiler_response + "\n",
                    "sdk-path": self.sdk_response + "\n"}.get(label, "synthetic " + label + "\n")
        kwargs["stdout"].write(response.encode())
        kwargs["stderr"].write(b"synthetic stderr\n")
        if label == "make" and self.fail_label != label:
            helper = Path(kwargs["cwd"]) / "ffprobe"
            if self.make_symlink:
                helper.symlink_to(self.gpg)
            else:
                helper.write_text("INERT HELPER PLACEHOLDER: MUST NEVER EXECUTE\n")
                helper.chmod(0o755)
        return subprocess.CompletedProcess(argv, 17 if self.fail_label == label else 0)

    def build(self):
        return recipe.rebuild(self.materials, self.output, self.developer, self.gpg)

    def labels(self):
        return [c[0] for c in self.calls]

    def test_synthetic_success_derives_arguments_and_keeps_outputs_unqualified(self):
        result = self.build()
        configure = next(c[1] for c in self.calls if c[0] == "configure")
        expected = ["--cc=" + str(self.compiler) if v.startswith("--cc=") else
                    "--host-cc=" + str(self.compiler) if v.startswith("--host-cc=") else v
                    for v in self.configure]
        self.assertEqual(configure[1:], expected)
        self.assertEqual(result["state"], "BUILD_COMPLETED_UNQUALIFIED")
        self.assertFalse(result["helper_executed"])
        self.assertFalse(result["release_or_license_clearance"])
        self.assertEqual(len(self.calls), 12)
        self.assertEqual(next(c[1] for c in self.calls if c[0] == "make"), ["/usr/bin/make", "-j2", "ffprobe"])
        self.assertTrue((self.output / "records/extraction.json").is_file())
        self.assertFalse(any(str(self.output / "build/ffprobe") == c[1][0] for c in self.calls))

    def test_changed_manifest_stops_before_any_subprocess(self):
        (self.materials / "manifest.json").write_text("{}")
        with self.assertRaisesRegex(recipe.RecipeError, "hash mismatch"):
            self.build()
        self.assertEqual(self.calls, [])

    def test_changed_archive_stops_before_signature_or_extraction(self):
        (self.source / "ffmpeg-9.0.2.tar.xz").write_bytes(b"changed")
        with self.assertRaisesRegex(recipe.RecipeError, "hash mismatch"):
            self.build()
        self.assertEqual(self.calls, [])
        self.assertEqual(list((self.output / "source").iterdir()), [])

    def test_changed_signature_stops_before_any_subprocess(self):
        (self.source / "ffmpeg-9.0.2.tar.xz.asc").write_bytes(b"changed")
        with self.assertRaisesRegex(recipe.RecipeError, "hash mismatch"):
            self.build()
        self.assertEqual(self.calls, [])

    def test_changed_key_stops_before_any_subprocess(self):
        (self.source / "ffmpeg-devel.asc").write_bytes(b"changed")
        with self.assertRaisesRegex(recipe.RecipeError, "hash mismatch"):
            self.build()
        self.assertEqual(self.calls, [])

    def test_failed_gpg_stops_before_signature_or_source(self):
        self.fail_label = "key-import"
        with self.assertRaisesRegex(recipe.RecipeError, "key-import failed"):
            self.build()
        self.assertEqual(self.labels(), ["key-import"])
        self.assertEqual(json.loads((self.output / "records/key-import.json").read_text())["returncode"], 17)

    def test_failed_signature_verification_stops_even_with_validsig_text(self):
        self.fail_label = "signature"
        with self.assertRaisesRegex(recipe.RecipeError, "signature failed"):
            self.build()
        self.assertEqual(self.labels(), ["key-import", "signature"])
        self.assertEqual(json.loads((self.output / "records/signature.json").read_text())["returncode"], 17)

    def test_dispatch_error_is_retained_without_make_or_retry(self):
        self.dispatch_error_label = "configure"
        with self.assertRaisesRegex(recipe.RecipeError, "could not start"):
            self.build()
        self.assertNotIn("make", self.labels())
        self.assertEqual(self.labels().count("configure"), 1)
        retained = json.loads((self.output / "records/configure.json").read_text())
        self.assertIn("synthetic dispatch refusal", retained["dispatch_error"])
        self.assertNotIn("returncode", retained)

    def test_missing_signature_status_stops_before_tool_discovery(self):
        self.signature_status = "[GNUPG:] GOODSIG some-other-key\n"
        with self.assertRaisesRegex(recipe.RecipeError, "fingerprint absent"):
            self.build()
        self.assertEqual(self.labels(), ["key-import", "signature"])

    def test_fingerprint_prefix_collision_is_rejected(self):
        self.signature_status = "[GNUPG:] VALIDSIG " + recipe.SIGNER + "BAD 2026-09-18\n"
        with self.assertRaisesRegex(recipe.RecipeError, "fingerprint absent"):
            self.build()
        self.assertEqual(self.labels(), ["key-import", "signature"])

    def test_missing_compiler_stops_before_configure(self):
        self.compiler_response = str(self.root / "absent-compiler")
        with self.assertRaisesRegex(recipe.RecipeError, "unavailable"):
            self.build()
        self.assertNotIn("configure", self.labels())
        self.assertEqual(list((self.output / "source").iterdir()), [])

    def test_missing_sdk_stops_before_configure(self):
        self.sdk_response = str(self.root / "absent-sdk")
        with self.assertRaisesRegex(recipe.RecipeError, "unavailable"):
            self.build()
        self.assertNotIn("configure", self.labels())

    def test_whitespace_sdk_stops_before_configure(self):
        spaced = self.developer / "SDK with space"
        spaced.mkdir()
        self.sdk_response = str(spaced)
        with self.assertRaisesRegex(recipe.RecipeError, "unsupported"):
            self.build()
        self.assertNotIn("configure", self.labels())

    def test_configure_failure_keeps_status_and_never_calls_make(self):
        self.fail_label = "configure"
        with self.assertRaisesRegex(recipe.RecipeError, "configure failed"):
            self.build()
        self.assertNotIn("make", self.labels())
        self.assertEqual(json.loads((self.output / "records/configure.json").read_text())["returncode"], 17)
        self.assertFalse((self.output / "records/result.json").exists())

    def test_make_failure_keeps_status_and_never_inspects_output(self):
        self.fail_label = "make"
        with self.assertRaisesRegex(recipe.RecipeError, "make failed"):
            self.build()
        self.assertNotIn("file", self.labels())
        self.assertEqual(json.loads((self.output / "records/make.json").read_text())["returncode"], 17)

    def test_symlink_helper_is_rejected_without_running_it(self):
        self.make_symlink = True
        with self.assertRaisesRegex(recipe.RecipeError, "ordinary ffprobe"):
            self.build()
        self.assertNotIn("file", self.labels())

    def test_existing_output_is_never_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_bytes(b"original")
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(sentinel.read_bytes(), b"original")
        self.assertEqual(self.calls, [])

    def test_environment_is_explicit_and_helper_is_never_invoked(self):
        with mock.patch.dict(os.environ, {"RECIPE_TEST_PRIVATE_SENTINEL": "must-not-leak", "PYTHONPATH": "/unrelated"}):
            self.build()
        for _, argv, env in self.calls:
            self.assertNotIn("RECIPE_TEST_PRIVATE_SENTINEL", env)
            self.assertNotIn("PYTHONPATH", env)
            self.assertEqual(env["HOME"], str(self.output / "home"))
            self.assertFalse(Path(argv[0]).name == "ffprobe")
        build_env = next(c[2] for c in self.calls if c[0] == "configure")
        for key in ("CFLAGS", "CXXFLAGS", "OBJCFLAGS", "ASFLAGS", "LDFLAGS"):
            self.assertEqual(build_env[key], "-arch arm64 -mmacosx-version-min=13.0 -isysroot " + str(self.sdk))
        self.assertEqual(build_env["DEVELOPER_DIR"], str(self.developer))

    def test_archive_traversal_is_rejected_before_any_extraction(self):
        archive = self.root / "hostile.tar.xz"
        with tarfile.open(archive, "w:xz") as tf:
            item = tarfile.TarInfo("ffmpeg-9.0.2/../../escape")
            item.size = 1
            tf.addfile(item, io.BytesIO(b"x"))
        destination = self.root / "extraction"
        destination.mkdir()
        with self.assertRaisesRegex(recipe.RecipeError, "unsupported source"):
            recipe.extract_source(archive, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_archive_symlink_is_rejected_before_any_extraction(self):
        archive = self.root / "link.tar.xz"
        with tarfile.open(archive, "w:xz") as tf:
            item = tarfile.TarInfo("ffmpeg-9.0.2/link")
            item.type, item.linkname = tarfile.SYMTYPE, "/outside"
            tf.addfile(item)
        destination = self.root / "extraction"
        destination.mkdir()
        with self.assertRaisesRegex(recipe.RecipeError, "unsupported source"):
            recipe.extract_source(archive, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
