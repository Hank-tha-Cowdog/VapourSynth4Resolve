"""Passive AST selection + fake os/core only; no helper/runtime/media executes."""
import ast
import builtins
import io
import json
import os
from pathlib import Path
import stat
import types
import unittest

SOURCE = Path(os.environ.get("VSRES_PNG_PYTHON_SOURCE", Path(__file__).with_name("render_preview_frame.py"))).read_text()
TREE = ast.parse(SOURCE)
BASELINE = os.environ.get("VSRES_PNG_BASELINE") == "1"
OUT = "/fixture/frame.png"
NUMBERED = "/fixture/frame0.png"


class Captured(Exception):
    pass


class Fixture:
    def __init__(self, **options):
        self.options = options
        self.files, self.fds, self.effects, self.responses = {}, {}, [], []
        self.serial, self.attempts = 0, 0
        self.clip = types.SimpleNamespace(width=8192, height=4320, num_frames=100, fps_num=30000, fps_den=1001)
        fixture = self

        class Clip:
            def __getitem__(self, selected):
                fixture.effects.append(("slice", selected.start, selected.stop))
                return self

        def bicubic(clip, **kwargs):
            self.effects.append(("bicubic", dict(kwargs)))
            if options.get("matrix_error") and not kwargs.get("matrix_in_s"):
                raise RuntimeError("no path between colorspaces")
            return Clip()

        def write(single, template):
            self.effects.append(("fpng", template))
            def get_frame(index):
                self.attempts += 1
                self.effects.append(("frame", index))
                self.seed(template % 0, size=options.get("size", 8), **options.get("written_fields", {}))
                if options.get("target_replacement"):
                    self.seed(OUT, size=123)
                if options.get("target_mutation"):
                    self.files[OUT].st_size += 1
                    self.files[OUT].st_mtime_ns += 1
                if options.get("lazy_matrix_error") and self.attempts == 1:
                    raise RuntimeError("no path between colorspaces")
                if options.get("frame_error"):
                    raise RuntimeError("synthetic fpng write failure")
            return types.SimpleNamespace(get_frame=get_frame)

        self.core = types.SimpleNamespace(resize=types.SimpleNamespace(Bicubic=bicubic), fpng=types.SimpleNamespace(Write=write))
        self.vs = types.SimpleNamespace(core=self.core, RGB24="RGB24")
        path = types.SimpleNamespace(splitext=os.path.splitext,
            exists=lambda file: file in self.files, lexists=lambda file: file in self.files)
        self.environ = {}
        self.os = types.SimpleNamespace(path=path, environ=self.environ, geteuid=lambda: 42,
            O_RDONLY=os.O_RDONLY, O_NOFOLLOW=os.O_NOFOLLOW, O_NONBLOCK=os.O_NONBLOCK,
            open=self.open, fstat=lambda fd: self.fds[fd], lstat=self.lstat,
            close=self.close, replace=self.replace, unlink=self.unlink)
        self.sys = types.SimpleNamespace(stdin=io.StringIO(""))
        def imported(name, *args, **kwargs):
            if name == "vapoursynth": return self.vs
            if name == "json": return json
            if name == "sys": return self.sys
            raise AssertionError("Unadmitted import: " + name)
        ports = dict(vars(builtins), __import__=imported, print=lambda text, **kwargs: self.responses.append(json.loads(text)))
        self.namespace = {"__builtins__": ports, "os": self.os, "stat": stat,
            "DEFAULT_MAX_PNG_BYTES": 128 * 1024 * 1024, "_PNG_UNSET": object(), "core": self.core, "vs": self.vs,
            "clip": self.clip, "frame": 5, "args": types.SimpleNamespace(out=OUT),
            "max_png_bytes": options.get("maximum", 128 * 1024 * 1024), "display_matrix_assumed": None,
            "_resolve_runtime_paths": lambda: None,
            "_clip_for_request": lambda *args: (self.effects.append(("clip",)), self.clip)[1],
            "_scope_metrics": lambda *args: {"domain": "signal-referred", "depth": 16},
            "emit": self.emit}
        names = {"PreviewPNGTooLarge", "_png_budget", "_unlink_numbered_png", "_png_stat_identity", "_write_preview_png", "serve"}
        selected = ast.Module(body=[node for node in TREE.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names], type_ignores=[])
        exec(compile(selected, "passive-preview-functions", "exec"), self.namespace)

    def seed(self, file, size=8, **extra):
        self.serial += 1
        value = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=42, st_nlink=1,
            st_size=size, st_dev=1, st_ino=self.serial, st_mtime_ns=1, st_ctime_ns=1)
        for key, val in extra.items(): setattr(value, key, val)
        self.files[file] = value
        return value

    def open(self, file, flags):
        self.effects.append(("open", file, flags))
        value = self.lstat(file)
        if stat.S_ISLNK(value.st_mode) and flags & os.O_NOFOLLOW: raise OSError("ELOOP")
        fd = len(self.fds) + 1
        self.fds[fd] = value
        return fd

    def lstat(self, file):
        if file not in self.files:
            raise FileNotFoundError(file)
        return self.files[file]

    def close(self, fd):
        del self.fds[fd]

    def unlink(self, file):
        self.effects.append(("unlink", file))
        del self.files[file]

    def replace(self, source, dest):
        self.effects.append(("replace", source, dest))
        if self.options.get("replace_error"):
            if self.options.get("replacement"):
                self.seed(source, size=123)
            raise OSError("synthetic replace failure")
        self.files[dest] = self.files.pop(source)

    def emit(self, payload):
        self.responses.append(payload)
        raise Captured()

    def one_shot_write(self):
        main = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        block = next(node for node in main.body if isinstance(node, ast.Try) and
            ("_write_preview_png" in ast.unparse(node) or "core.fpng.Write" in ast.unparse(node)))
        try:
            exec(compile(ast.Module(body=[block], type_ignores=[]), "actual-main-write-block", "exec"), self.namespace)
        except Captured:
            pass

    def server(self, **extra):
        request = {"id": 7, "out": OUT, "frame": 5, "scopes": True, **extra}
        self.sys.stdin = io.StringIO(json.dumps(request) + "\n")
        self.namespace["serve"]()
        return self.responses[-1]


class PNGTests(unittest.TestCase):
    def test_01_original_partial_one_shot_numbered_file_is_cleaned(self):
        h = Fixture(frame_error=True)
        h.one_shot_write()
        self.assertNotIn(NUMBERED, h.files)
        self.assertFalse(h.responses[-1]["ok"])

    def test_02_original_one_shot_missing_matrix_uses_same_labeled_retry(self):
        h = Fixture(matrix_error=True)
        h.one_shot_write()
        self.assertEqual(h.namespace["display_matrix_assumed"], "709")
        self.assertIn(OUT, h.files)
        self.assertNotIn(NUMBERED, h.files)

    def test_03_common_writer_keeps_full_geometry_and_exact_selected_frame(self):
        h = Fixture()
        h.one_shot_write()
        self.assertEqual((h.clip.width, h.clip.height), (8192, 4320))
        self.assertIn(("slice", 5, 6), h.effects)
        self.assertIn(("frame", 0), h.effects)
        self.assertEqual([e[1] for e in h.effects if e[0] == "bicubic"], [{"format": "RGB24"}])
        self.assertFalse(h.fds)

    def test_04_server_preserves_geometry_cadence_scopes_and_presentation(self):
        h = Fixture()
        result = h.server(time=.2)
        self.assertTrue(result["ok"])
        self.assertEqual((result["width"], result["height"]), (8192, 4320))
        self.assertEqual((result["fpsNum"], result["fpsDen"]), (30000, 1001))
        self.assertEqual(result["frame"], 5)
        self.assertEqual(result["scopes"]["depth"], 16)
        self.assertEqual(result["presentationTimeS"], 5005 / 30000)

    def test_05_server_partial_failure_cleans_numbered_scratch(self):
        h = Fixture(frame_error=True)
        self.assertFalse(h.server()["ok"])
        self.assertNotIn(NUMBERED, h.files)
        self.assertNotIn(OUT, h.files)

    def test_06_preexisting_numbered_foreign_leaf_is_not_touched(self):
        h = Fixture()
        original = h.seed(NUMBERED, size=123)
        h.one_shot_write()
        self.assertIs(h.files[NUMBERED], original)
        self.assertFalse(any(e[0] == "fpng" for e in h.effects))

    def test_07_final_alias_refusal_and_verified_regular_reuse_preserve_ownership(self):
        h = Fixture()
        original = h.seed(OUT, st_mode=stat.S_IFLNK | 0o777)
        h.one_shot_write()
        self.assertIs(h.files[OUT], original)
        self.assertFalse(any(e[0] == "fpng" for e in h.effects))
        for fields in [{"st_nlink": 2}, {"st_uid": 99}, {"st_mode": stat.S_IFIFO}]:
            unsafe = Fixture()
            original = unsafe.seed(OUT, **fields)
            self.assertFalse(unsafe.server()["ok"])
            self.assertIs(unsafe.files[OUT], original)
            self.assertFalse(unsafe.fds)
        reused = Fixture()
        original = reused.seed(OUT, size=77)
        self.assertTrue(reused.server()["ok"])
        self.assertIsNot(reused.files[OUT], original)
        self.assertFalse(reused.fds)
        for option, expected_size in [("target_replacement", 123), ("target_mutation", 78)]:
            raced = Fixture(**{option: True})
            raced.seed(OUT, size=77)
            self.assertFalse(raced.server()["ok"])
            self.assertEqual(raced.files[OUT].st_size, expected_size)
            self.assertFalse(raced.fds)

    def test_08_writer_size_budget_refuses_publication_and_cleans_numbered(self):
        h = Fixture(size=9)
        result = h.server(maxPngBytes=8)
        self.assertTrue(result["pngOutputLimit"])
        self.assertNotIn(OUT, h.files)
        self.assertNotIn(NUMBERED, h.files)
        self.assertFalse(h.fds)

    def test_09_unsafe_output_metadata_never_publishes(self):
        for extra in [{"st_mode": stat.S_IFIFO}, {"st_mode": stat.S_IFLNK}, {"st_uid": 99}, {"st_nlink": 2}, {"st_size": 0}]:
            h = Fixture(written_fields=extra)
            self.assertFalse(h.server()["ok"])
            self.assertNotIn(OUT, h.files)
            self.assertFalse(h.fds)

    def test_10_replace_failure_cleans_owned_inode_and_preserves_replacement(self):
        h = Fixture(replace_error=True)
        self.assertFalse(h.server()["ok"])
        self.assertNotIn(NUMBERED, h.files)
        replaced = Fixture(replace_error=True, replacement=True)
        self.assertFalse(replaced.server()["ok"])
        self.assertEqual(replaced.files[NUMBERED].st_size, 123)

    def test_11_positive_policy_environment_and_explicit_override_are_visible(self):
        h = Fixture()
        select = h.namespace["_png_budget"]
        self.assertEqual(select(), 128 * 1024 * 1024)
        h.environ["VSRES_PREVIEW_MAX_PNG_BYTES"] = "123"
        self.assertEqual(select(), 123)
        self.assertEqual(select(456), 456)
        for value in [None, True, False, 0, -1, 1.5, "12"]:
            with self.assertRaises(ValueError): select(value)
        for value in ["", "0", "1.5", "-1", " 12", "１"]:
            h.environ["VSRES_PREVIEW_MAX_PNG_BYTES"] = value
            with self.assertRaises(ValueError): select()
        null_request = Fixture()
        self.assertFalse(null_request.server(maxPngBytes=None)["ok"])
        self.assertFalse(any(e[0] in ("clip", "fpng") for e in null_request.effects))

    def test_12_lazy_matrix_retry_cleans_partial_before_labeled_success(self):
        h = Fixture(lazy_matrix_error=True)
        result = h.server()
        self.assertTrue(result["ok"])
        self.assertEqual(result["displayMatrixAssumed"], "709")
        unlink = next(i for i, e in enumerate(h.effects) if e[0] == "unlink")
        second_write = [i for i, e in enumerate(h.effects) if e[0] == "fpng"][1]
        self.assertLess(unlink, second_write)
        self.assertNotIn(NUMBERED, h.files)


if __name__ == "__main__":
    selected = [name for name in unittest.defaultTestLoader.getTestCaseNames(PNGTests)
                if not BASELINE or name.startswith(("test_01_", "test_02_"))]
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(PNGTests(name) for name in selected))
    raise SystemExit(0 if result.wasSuccessful() else 1)
