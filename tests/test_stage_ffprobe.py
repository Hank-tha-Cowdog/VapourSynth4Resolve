"""Synthetic staging boundaries. No FFmpeg binary, compiler or network is run."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest import mock

_SPEC = importlib.util.spec_from_file_location(
    "stage_ffprobe", Path(__file__).resolve().parents[1] / "scripts/stage_ffprobe.py")
stage = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(stage)


def load_command(kind, body):
    size = (8 + len(body) + 7) // 8 * 8
    return struct.pack("<2I", kind, size) + body + bytes(size - 8 - len(body))


def macho(minimum=0x000D0000, dependency="/usr/lib/libSystem.B.dylib", extra=()):
    commands = [load_command(0x32, struct.pack("<4I", 1, minimum, 0x001A0000, 0))]
    if dependency is not None:
        commands.append(load_command(0xC, struct.pack("<4I", 24, 0, 0, 0) + dependency.encode() + b"\0"))
    commands.extend(extra)
    return struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, len(commands),
                       sum(map(len, commands)), 0, 0) + b"".join(commands)


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ffprobe-staging-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        self.parent = self.base / "out"
        self.parent.mkdir()
        self.output = self.parent / "payload"
        self.binary = self.source / "bin/ffprobe"
        self.binary.parent.mkdir()
        self.binary.write_bytes(macho())
        self.binary.chmod(0o755)
        # These are deliberately fake provenance fixtures, never release evidence.
        examples = [("COPYING.LGPLv2.1", "license", b"synthetic license"),
                    ("ffmpeg-9.0.2.tar.xz", "source", b"synthetic source archive"),
                    ("configure.txt", "build-config", b"synthetic build config"),
                    ("verification.txt", "signature-verification", b"synthetic PGP receipt"),
                    ("ffmpeg-9.0.2.tar.xz.asc", "signature-verification", b"synthetic signature")]
        self.materials = []
        for name, role, content in examples:
            (self.source / name).write_bytes(content)
            self.materials.append({"path": name, "role": role,
                                   "sha256": hashlib.sha256(content).hexdigest()})
        self.manifest = {
            "schema_version": 1, "version": stage.VERSION,
            "source": {"url": stage.SOURCE_URL, "signer_fingerprint": stage.SIGNER,
                       "archive_sha256": self.materials[1]["sha256"],
                       "signature_sha256": self.materials[-1]["sha256"]},
            "build": {"target": stage.TARGET, "gpl": False, "nonfree": False,
                      "version3": False, "configure": sorted(stage.REQUIRED_FLAGS)},
            "binary": {"path": "bin/ffprobe", "sha256": stage.digest(self.binary.read_bytes()),
                       "mode": "0755"},
            "materials": self.materials,
        }
        self.path = self.source / "manifest.json"
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def inspect(self):
        self.save()
        return stage.checked_inputs(self.source, self.path)

    def replace_binary(self, content):
        self.binary.write_bytes(content)
        self.manifest["binary"]["sha256"] = stage.digest(content)
        self.save()

    def test_valid_static_inspection(self):
        _, _, selected, facts = self.inspect()
        self.assertEqual(len(selected), 5)
        self.assertEqual(facts, {"architecture": "arm64", "minimum_macos": "13.0.0",
                                 "dependencies": ["/usr/lib/libSystem.B.dylib"]})

    def test_reject_source_identity_license_and_config_changes(self):
        mutations = [("source", "url", "https://example.invalid/ffmpeg.tar.xz"),
                     ("source", "signer_fingerprint", "0" * 40),
                     ("build", "target", "arm64-apple-macos26.0"),
                     ("build", "gpl", True), ("build", "version3", None),
                     ("binary", "mode", "0777"), ("binary", "sha256", "0" * 64)]
        original = copy.deepcopy(self.manifest)
        for section, key, value in mutations:
            with self.subTest(section=section, key=key):
                self.manifest = copy.deepcopy(original)
                self.manifest[section][key] = value
                with self.assertRaises(stage.StageError):
                    self.inspect()
        self.manifest = original
        self.manifest["build"]["configure"].append("--enable-gpl")
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_missing_restriction(self):
        self.manifest["build"]["configure"].remove("--disable-autodetect")
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_non_executable_mode(self):
        self.binary.chmod(0o644)
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_escape_symlink_and_hardlink_inputs(self):
        self.manifest["binary"]["path"] = "../outside"
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest["binary"]["path"] = "bin/ffprobe"
        target = self.source / "real-binary"
        self.binary.rename(target)
        self.binary.symlink_to(target)
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.binary.unlink()
        os.link(target, self.binary)
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_material_parent_symlink(self):
        outside = self.base / "external"
        outside.mkdir()
        (outside / "notice").write_text("notice")
        (self.source / "linked").symlink_to(outside, target_is_directory=True)
        self.manifest["materials"][0]["path"] = "linked/notice"
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_missing_modified_and_duplicate_materials(self):
        original = copy.deepcopy(self.manifest)
        self.manifest["materials"] = self.manifest["materials"][1:]
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest = copy.deepcopy(original)
        self.manifest["materials"].append(copy.deepcopy(self.manifest["materials"][0]))
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest = original
        (self.source / "COPYING.LGPLv2.1").write_text("modified")
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_reject_macho_format_architecture_target_and_external_loads(self):
        cases = [b"not an executable", b"\xca\xfe\xba\xbe" + bytes(64),
                 macho(minimum=0x000E0000), macho(dependency="/opt/homebrew/lib/libz.dylib"),
                 macho(dependency="@rpath/libavcodec.dylib"),
                 macho(dependency="/usr/lib/../../tmp/evil.dylib")]
        wrong_arch = bytearray(macho())
        struct.pack_into("<I", wrong_arch, 4, 0x01000007)
        cases.append(bytes(wrong_arch))
        for index, data in enumerate(cases):
            with self.subTest(case=index):
                self.replace_binary(data)
                with self.assertRaises(stage.StageError):
                    self.inspect()

    def test_reject_rpath_and_dyld_environment(self):
        rpath = load_command(0x8000001C, struct.pack("<I", 12) + b"/tmp\0")
        environment = load_command(0x27, struct.pack("<I", 12) + b"DYLD_INSERT_LIBRARIES=/tmp/x\0")
        for command in (rpath, environment):
            self.replace_binary(macho(extra=(command,)))
            with self.assertRaises(stage.StageError):
                self.inspect()

    def test_reject_missing_or_ambiguous_minimum_and_truncation(self):
        command = load_command(0x32, struct.pack("<4I", 1, 0x000D0000, 0, 0))
        for data in (struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 0, 0, 0, 0),
                     macho(extra=(command,)), macho()[:-1]):
            with self.assertRaises(stage.StageError):
                stage.inspect_macho(data)

    @unittest.skipUnless(sys.platform == "darwin", "macOS exclusive rename required")
    def test_atomic_stage_exact_payload_and_no_overwrite(self):
        receipt = stage.stage_payload(self.source, self.path, self.output)
        self.assertFalse(receipt["release_or_license_clearance"])
        staged = self.output / "runtime/ffmpeg/ffprobe"
        self.assertEqual(staged.read_bytes(), self.binary.read_bytes())
        self.assertEqual(stat.S_IMODE(staged.stat().st_mode), 0o755)
        expected = {"runtime/ffmpeg/ffprobe", "licenses/ffmpeg/manifest.json"}
        expected.update("licenses/ffmpeg/materials/" + x["path"] for x in self.materials)
        self.assertEqual({p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()}, expected)
        with self.assertRaises(stage.StageError):
            stage.stage_payload(self.source, self.path, self.output)
        self.assertFalse(list(self.parent.glob(".ffprobe-stage-*")))

    @unittest.skipUnless(sys.platform == "darwin", "macOS exclusive rename required")
    def test_racing_empty_destination_is_preserved(self):
        publish = stage.publish_new_directory
        def race(source, destination):
            destination.mkdir()
            publish(source, destination)
        with mock.patch.object(stage, "publish_new_directory", side_effect=race):
            with self.assertRaises(OSError):
                stage.stage_payload(self.source, self.path, self.output)
        self.assertTrue(self.output.is_dir())
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertFalse(list(self.parent.glob(".ffprobe-stage-*")))

    def test_invalid_inputs_do_not_create_output(self):
        self.binary.chmod(0o644)
        with self.assertRaises(stage.StageError):
            stage.stage_payload(self.source, self.path, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.parent.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
