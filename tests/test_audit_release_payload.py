"""Payload name/index checks using inert, exclusively owned temporary trees."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(os.environ.get("VSRES_PAYLOAD_TEST_SCRIPT", Path(__file__).resolve().parents[1] / "scripts/audit_release_payload.py"))
spec = importlib.util.spec_from_file_location("payload_guard_under_test", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class PayloadGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vsres-payload-inert-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "companion-app"
        self.app.mkdir()
        self.package = {"build": {"files": [], "extraResources": []}}
        self.pkg_patch = mock.patch.object(guard, "_pkg", return_value=self.package)
        self.app_patch = mock.patch.object(guard, "APP", str(self.app))
        self.pkg_patch.start(); self.app_patch.start()
        self.addCleanup(self.pkg_patch.stop); self.addCleanup(self.app_patch.stop)

    def write(self, relative, data=b"INERT TEST BYTES\n"):
        target = self.app / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def resource(self, patterns):
        self.package["build"]["extraResources"] = [{"from": "payload", "to": "runtime", "filter": patterns}]
        (self.app / "payload").mkdir(exist_ok=True)

    def built(self):
        app = self.app / "dist/Fixture.app"
        app.mkdir(parents=True)
        return app

    def asar(self, tree):
        body = json.dumps(tree).encode()
        payload = ((4 + len(body) + 3) // 4) * 4
        return struct.pack("<4I", 4, payload + 4, payload, len(body)) + body + b"\0" * (payload - 4 - len(body))

    def test_output_bytecode_is_rejected(self):
        self.built()
        self.write("dist/Fixture.app/Contents/runtime/module.pyc")
        findings, apps = guard.audit_dist_output()
        self.assertEqual(len(apps), 1)
        self.assertTrue(any("module.pyc" in f[1] for f in findings))

    def test_output_empty_cache_directory_is_rejected(self):
        app = self.built()
        (app / "Contents/__pycache__").mkdir(parents=True)
        self.assertTrue(any("__pycache__" in f[1] for f in guard.audit_dist_output()[0]))

    def test_output_cache_contents_are_not_pruned(self):
        self.built()
        self.write("dist/Fixture.app/Contents/__pycache__/credentials.json")
        self.assertTrue(any("credentials.json" in f[1] for f in guard.audit_dist_output()[0]))

    def test_resource_cache_is_rejected_when_exclusion_is_absent(self):
        self.resource(["**/*"])
        self.write("payload/nested/__pycache__/mod.pyc")
        self.assertTrue(guard.audit_extra_resources())

    def test_current_cache_exclusions_apply_to_directories_and_loose_bytecode(self):
        self.resource(["**/*", "!**/__pycache__", "!**/*.pyc"])
        self.write("payload/__pycache__/credentials.json")
        self.write("payload/nested/__pycache__/credentials.json")
        self.write("payload/loose.pyc")
        self.write("payload/nested/loose.pyc")
        self.write("payload/source.py")
        self.assertEqual(guard.audit_extra_resources(), [])

    def test_explicit_resource_selection_does_not_scan_unshipped_sibling_names(self):
        self.resource(["LICENSE"])
        self.write("payload/LICENSE")
        self.write("payload/secrets.json")
        self.assertEqual(guard.audit_extra_resources(), [])

    def test_root_level_resource_credential_is_not_lost_by_double_star(self):
        self.resource(["**/*"])
        self.write("payload/credentials.json")
        self.assertTrue(guard.audit_extra_resources())

    def test_source_map_exclusion_is_slash_aware(self):
        self.write("build/sub/index.map")
        self.write("build/index.js")
        self.package["build"]["files"] = ["build/**/*", "!**/*.map"]
        self.assertEqual(guard.audit_files_globs(), [])

    def test_first_single_file_glob_does_not_use_an_unbound_name(self):
        self.write("package.json", b"{}")
        self.package["build"]["files"] = ["package.json"]
        self.assertEqual(guard.audit_files_globs(), [])

    def test_single_file_credential_input_is_rejected(self):
        self.write("credentials.json", b"SYNTHETIC")
        self.package["build"]["files"] = ["credentials.json"]
        self.assertTrue(guard.audit_files_globs())

    def test_stdlib_certificate_exception_does_not_allow_credentials(self):
        self.assertTrue(guard._check("Python/lib/python3.14/test/credentials.json", "credentials.json", True))
        self.assertEqual(guard._check("Python/lib/python3.14/test/keycert.pem", "keycert.pem", True), [])

    def test_stdlib_certificate_exception_does_not_hide_cache_paths(self):
        self.assertTrue(guard._check("Python/lib/python3.14/test/__pycache__/m.pyc", "m.pyc", True))

    def test_certificate_locations_do_not_exempt_credential_specific_names(self):
        for prefix in ["Python/lib/python3.14/test/", "Python/lib/python3.14/test/nested/", "pip/_vendor/certifi/"]:
            for name in ["secrets.pem", "secrets.key", "id_rsa.pem"]:
                self.assertTrue(guard._check(prefix + name, name, True), (prefix, name))

    def test_unsupported_patterns_refuse_even_empty_resource_roots(self):
        for patterns in [["**/*", "!{a,b}"], ["**/*", "!foo", "bar"]]:
            self.resource(patterns)
            with self.assertRaises(ValueError):
                guard.audit_extra_resources()

    def test_unsupported_patterns_refuse_even_empty_app_input_roots(self):
        (self.app / "build").mkdir()
        self.package["build"]["files"] = ["build/**/*", "!{a,b}"]
        with self.assertRaises(ValueError):
            guard.audit_files_globs()

    def test_certifi_exception_only_allows_its_public_ca_name(self):
        self.assertTrue(guard._check("pip/_vendor/certifi/.env", ".env", True))
        self.assertEqual(guard._check("pip/_vendor/certifi/cacert.pem", "cacert.pem", True), [])

    def test_asar_filename_metadata_is_audited_without_executing_bodies(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar", self.asar({"files": {
            "secrets.json": {"size": 0, "offset": "0"},
            "__pycache__": {"files": {}},
        }}))
        findings, _ = guard.audit_dist_output()
        self.assertTrue(any("app.asar/secrets.json" == f[1] for f in findings))
        self.assertTrue(any("app.asar/__pycache__" == f[1] for f in findings))

    def test_clean_asar_and_required_output_pass(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar", self.asar({"files": {"main.js": {"size": 0, "offset": "0"}}}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(["--output-only"]), 0)

    def test_malformed_asar_fails_closed(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar", b"INVALID ARCHIVE")
        self.assertTrue(any(f[0] == "invalid-asar" for f in guard.audit_dist_output()[0]))

    def test_oversized_asar_header_is_rejected_before_body_read(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar", struct.pack("<4I", 4, 32 * 1024 * 1024, 12, 8))
        self.assertTrue(any(f[0] == "invalid-asar" for f in guard.audit_dist_output()[0]))

    def test_asar_root_and_nested_metadata_must_be_objects(self):
        app = self.built()
        for tree in [{}, [], {"files": []}, {"files": {"folder": {"files": []}}}]:
            self.write("dist/Fixture.app/Contents/Resources/app.asar", self.asar(tree))
            self.assertTrue(any(f[0] == "invalid-asar" for f in guard.audit_dist_output()[0]))

    def test_asar_pickle_lengths_and_padding_must_be_consistent(self):
        self.built()
        good = self.asar({"files": {}})
        fields = list(struct.unpack("<4I", good[:16]))
        for index in [0, 1, 2, 3]:
            changed = fields.copy(); changed[index] += 1
            self.write("dist/Fixture.app/Contents/Resources/app.asar", struct.pack("<4I", *changed) + good[16:])
            self.assertTrue(any(f[0] == "invalid-asar" for f in guard.audit_dist_output()[0]))

    def test_asar_truncation_fails_closed(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar", self.asar({"files": {}})[:-1])
        self.assertTrue(any(f[0] == "invalid-asar" for f in guard.audit_dist_output()[0]))

    def test_output_mode_refuses_missing_built_app(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(["--output-only"]), 1)

    def test_input_mode_does_not_claim_to_check_existing_output(self):
        self.built()
        self.write("dist/Fixture.app/Contents/secrets.json")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(guard.main(["--inputs-only"]), 0)
        self.assertNotIn("dist output", output.getvalue())

    def test_output_fast_uri_benchmark_unpacked_directory_is_rejected(self):
        self.built()
        self.write("dist/Fixture.app/Contents/Resources/app.asar.unpacked/node_modules/fast-uri/benchmark/package.json", b"{}")
        findings, _ = guard.audit_dist_output()
        self.assertTrue(any("node_modules/fast-uri/benchmark" in f[1] for f in findings))

    def test_asar_root_and_nested_fast_uri_benchmarks_are_rejected(self):
        self.built()
        for prefix in (("node_modules", "fast-uri"),
                       ("node_modules", "parent", "node_modules", "fast-uri")):
            leaf = {"files": {"benchmark": {"files": {}}}}
            for name in reversed(prefix):
                leaf = {"files": {name: leaf}}
            self.write("dist/Fixture.app/Contents/Resources/app.asar", self.asar(leaf))
            findings, _ = guard.audit_dist_output()
            wanted = "app.asar/" + "/".join(prefix) + "/benchmark"
            self.assertTrue(any(f[1] == wanted for f in findings), (wanted, findings))

    def test_benchmark_rule_preserves_other_packages_and_neighbor_names(self):
        for relative in ("node_modules/other/benchmark/run.mjs",
                         "node_modules/fast-uri-extra/benchmark/run.mjs",
                         "node_modules/fast-uri/benchmarking/keep.js",
                         "node_modules/fast-uri/index.js",
                         "node_modules/fast-uri/lib/utils.js",
                         "node_modules/fast-uri/LICENSE",
                         "fast-uri/benchmark/not-a-node-module.js"):
            self.assertEqual(guard._check(relative, relative.rsplit("/", 1)[-1], True), [], relative)

    def test_fast_uri_benchmark_exclusions_are_supported_on_inputs(self):
        self.package["build"]["files"] = ["node_modules/**/*",
            "!**/node_modules/fast-uri/benchmark", "!**/node_modules/fast-uri/benchmark/**/*"]
        self.write("node_modules/fast-uri/benchmark/package.json", b"{}")
        self.write("node_modules/fast-uri/benchmark/secrets.json", b"INERT")
        self.write("node_modules/fast-uri/index.js")
        self.write("node_modules/fast-uri/LICENSE")
        self.assertEqual(guard.audit_files_globs(), [])
        patterns = self.package["build"]["files"]
        self.assertFalse(guard._selected("node_modules/fast-uri/benchmark", patterns))
        self.assertFalse(guard._selected("node_modules/fast-uri/benchmark/run.mjs", patterns))
        self.assertTrue(guard._selected("node_modules/fast-uri/index.js", patterns))


if __name__ == "__main__":
    unittest.main()
