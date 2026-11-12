"""Synthetic staging boundaries for the ffmpeg ENCODER kit. No FFmpeg binary,
compiler or network is run. Mirrors tests/test_stage_ffprobe.py with the
encoder feature contract (probe-build disables are forbidden)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "stage_ffmpeg_encoder", Path(__file__).resolve().parents[1] / "scripts/stage_ffmpeg_encoder.py")
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


def encoder_configure():
    # A realistic encoder configure: the probe disables absent, restrictions present.
    return sorted(stage.REQUIRED_FLAGS | {"--arch=arm64", "--target-os=darwin",
                                          "--disable-shared", "--enable-static"})


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ffmpeg-encoder-stage-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        (self.base / "out").mkdir()
        self.binary = self.source / "bin/ffmpeg"
        self.binary.parent.mkdir()
        self.binary.write_bytes(macho())
        self.binary.chmod(0o755)
        # Deliberately fake provenance fixtures, never release evidence.
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
                      "version3": False, "configure": encoder_configure()},
            "binary": {"path": "bin/ffmpeg", "sha256": stage.digest(self.binary.read_bytes()),
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

    def test_reject_missing_required_restriction(self):
        for flag in sorted(stage.REQUIRED_FLAGS):
            with self.subTest(flag=flag):
                self.manifest["build"]["configure"] = encoder_configure()
                self.manifest["build"]["configure"].remove(flag)
                with self.assertRaises(stage.StageError):
                    self.inspect()

    def test_reject_probe_build_feature_disables(self):
        # The encoder kit must NOT carry the probe build's disables.
        for flag in ("--disable-ffmpeg", "--disable-encoders", "--disable-muxers", "--disable-avfilter"):
            with self.subTest(flag=flag):
                self.manifest["build"]["configure"] = encoder_configure() + [flag]
                with self.assertRaises(stage.StageError):
                    self.inspect()

    def test_reject_enable_and_relaxation_flags(self):
        for flag in ("--enable-gpl", "--enable-nonfree", "--enable-version3",
                     "--enable-network", "--enable-autodetect"):
            with self.subTest(flag=flag):
                self.manifest["build"]["configure"] = encoder_configure() + [flag]
                with self.assertRaises(stage.StageError):
                    self.inspect()

    def test_reject_material_and_macho_problems(self):
        original = copy.deepcopy(self.manifest)
        # missing role coverage
        self.manifest["materials"] = [m for m in self.materials if m["role"] != "signature-verification"]
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest = copy.deepcopy(original)
        # hash mismatch
        self.manifest["materials"][0]["sha256"] = "0" * 64
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest = copy.deepcopy(original)
        # non-system dylib dependency
        self.binary.write_bytes(macho(dependency="/opt/homebrew/lib/libx.dylib"))
        self.manifest["binary"]["sha256"] = stage.digest(self.binary.read_bytes())
        with self.assertRaises(stage.StageError):
            self.inspect()
        self.manifest = copy.deepcopy(original)
        self.binary.write_bytes(macho())
        self.manifest["binary"]["sha256"] = stage.digest(self.binary.read_bytes())
        # rpath rejection
        self.binary.write_bytes(macho(extra=(load_command(0x8000001C, struct.pack("<3I", 24, 0, 0) + b"@loader_path\0"),)))
        self.manifest["binary"]["sha256"] = stage.digest(self.binary.read_bytes())
        with self.assertRaises(stage.StageError):
            self.inspect()

    def test_stage_payload_end_to_end(self):
        self.save()
        destination = self.base / "out/payload"
        result = stage.stage_payload(self.source, self.path, destination)
        self.assertEqual(result["sha256"], stage.digest(self.binary.read_bytes()))
        staged = destination / "runtime/ffmpeg/ffmpeg"
        self.assertTrue(staged.is_file())
        self.assertEqual(staged.stat().st_mode & 0o777, 0o755)
        self.assertTrue((destination / "licenses/ffmpeg-encoder/manifest.json").is_file())
        self.assertTrue((destination / "licenses/ffmpeg-encoder/materials/COPYING.LGPLv2.1").is_file())
        self.assertFalse(result["release_or_license_clearance"])
        # second publication refuses (StageError for an existing destination;
        # OSError only for the rename race)
        with self.assertRaises((stage.StageError, OSError)):
            stage.stage_payload(self.source, self.path, destination)


if __name__ == "__main__":
    unittest.main()
