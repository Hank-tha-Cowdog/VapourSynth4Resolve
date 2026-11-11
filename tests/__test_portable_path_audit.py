"""Synthetic path-audit controls. No native tool or payload is executed.

Selected original controls alone may run Bash audit-only with one inert fake
otool on private files; fixed tests import the passive adjacent Python helper.
"""
import importlib.util
import os
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

SOURCE = Path(os.environ['VSRES_AUDIT_SOURCE'])
LEGACY = SOURCE.suffix == '.sh'
if not LEGACY:
    spec = importlib.util.spec_from_file_location('private_portable_path_audit', SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def command(kind, text, endian='<', wide=True):
    minimum = 12 if kind in (0x8000001c, 0xe, 0xf, 0x27) else 24
    text = text.encode() + b'\0'
    alignment = 8 if wide else 4
    size = ((minimum + len(text) + alignment - 1) // alignment) * alignment
    return struct.pack(endian + 'III', kind, size, minimum) + b'\0' * (minimum - 12) + text + b'\0' * (size - minimum - len(text))


def thin(commands=(), endian='<', wide=True):
    fields = [0xfeedfacf if wide else 0xfeedface, 0x0100000c if wide else 12, 0, 2,
              len(commands), sum(map(len, commands)), 0]
    return struct.pack(endian + ('IiiIIIII' if wide else 'IiiIIII'), *fields, *([0] if wide else [])) + b''.join(commands)


def fat(body, wide=False, endian='>'):
    start = 64
    row = struct.pack(endian + ('iiQQII' if wide else 'iiIII'), 0x0100000c, 0, start, len(body), 4, *([0] if wide else []))
    header = struct.pack(endian + 'II', 0xcafebabf if wide else 0xcafebabe, 1) + row
    return header + b'\0' * (start - len(header)) + body


class PortableAuditTests(unittest.TestCase):
    fixtures = written = 0

    def setUp(self):
        parent = Path(os.environ['TMPDIR'])
        info = parent.lstat()
        self.assertEqual(parent.resolve(), parent)
        self.assertTrue(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid())
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
        PortableAuditTests.fixtures += 1
        self.assertLessEqual(PortableAuditTests.fixtures, 64)
        self.temp = tempfile.TemporaryDirectory(prefix='path-audit-inert-', dir=parent)
        self.base = Path(self.temp.name)
        self.base_identity = (self.base.stat().st_dev, self.base.stat().st_ino, self.base.stat().st_uid)
        self.root = self.base / 'Fixture Space.bundle' / 'Contents'
        self.root.mkdir(mode=0o700, parents=True)

    def tearDown(self):
        info = self.base.lstat()
        self.assertEqual((info.st_dev, info.st_ino, info.st_uid), self.base_identity)
        self.temp.cleanup()

    def put(self, name, data):
        PortableAuditTests.written += len(data)
        self.assertLessEqual(PortableAuditTests.written, 2 * 1024**2)
        path = self.root / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(data)
        path.chmod(0o600)
        return path

    def result(self, payload='\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)', status=0):
        if LEGACY:
            fakebin = self.base / 'fakebin'
            fakebin.mkdir(mode=0o700)
            fake = fakebin / 'otool'
            fake.write_text('#!/bin/sh\nprintf "fixture:\\n%s\\n" "$FAKE_OTOOL_PAYLOAD"\nexit "$FAKE_OTOOL_STATUS"\n')
            fake.chmod(0o700)
            env = {'PATH': str(fakebin) + ':/usr/bin:/bin', 'HOME': str(self.base),
                   'TMPDIR': str(self.base), 'LANG': 'C', 'LC_ALL': 'C',
                   'FAKE_OTOOL_PAYLOAD': payload, 'FAKE_OTOOL_STATUS': str(status)}
            child = subprocess.run(['/bin/bash', str(SOURCE), '--audit-only', str(self.root)],
                                   env=env, cwd=self.base, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=3, check=False)
            self.assertLessEqual(len(child.stdout) + len(child.stderr), 65536)
            return {'failed': child.returncode != 0, 'legacy': True}
        try:
            report = module.Auditor(self.root).run()
            return {'failed': bool(report['violations']), **report}
        except (module.AuditError, OSError, UnicodeError, struct.error) as error:
            return {'failed': True, 'error': str(error)}

    def failed(self, report, role=None):
        self.assertTrue(report['failed'], report)
        if role and not report.get('legacy'):
            self.assertTrue(any(row['role'] == role for row in report['violations']), report)

    def test_arbitrary_executable_external_load(self):
        self.put('Resources/vapoursynth/vspipe', thin([command(0xc, '/Users/synthetic/vendor/libvsscript.dylib')]))
        self.failed(self.result(payload='\t/Users/synthetic/vendor/libvsscript.dylib (compatibility version 1.0.0)'), 'load_dependency')

    def test_missing_loader_dependency(self):
        strong = self.put('support/libboost_filesystem.dylib', thin([command(0xc, '@loader_path/libboost_atomic.dylib')]))
        self.failed(self.result(payload='\t@loader_path/libboost_atomic.dylib (compatibility version 1.0.0)'), 'load_dependency')
        strong.unlink()
        weak = self.put('support/weakmain', thin([command(0x80000018, '@loader_path/optional.dylib')]))
        optional = self.result()
        self.assertFalse(optional['failed'], optional)
        self.assertEqual(optional['paths'][0]['classification'], 'loader_relative_unresolved')
        weak.unlink()
        escaped = self.put('support/weakescape', thin([command(0x80000018, '@loader_path/../../outside.dylib')]))
        self.failed(self.result(), 'load_dependency')
        escaped.unlink()
        prefix = self.put('rootweak', thin([command(0x80000018, '@loader_path/missing/../../outside.dylib')]))
        self.failed(self.result(), 'load_dependency')
        prefix.unlink()
        (self.root / 'support/toRoot').symlink_to('..')
        self.put('support/weakalias', thin([command(0x80000018, '@loader_path/toRoot/missing/../../outside.dylib')]))
        self.failed(self.result(), 'load_dependency')

    def test_failed_inspection_is_not_success(self):
        self.put('Libraries/truncated.dylib', b'\xcf\xfa\xed\xfe')
        self.failed(self.result(payload='', status=2))

    def test_spaced_pth_external_path(self):
        self.put('Libraries/clean.dylib', thin())
        target = self.put('Frameworks/Space Name/foreign injector.pth', b'/Users/synthetic/site-packages\n')
        self.failed(self.result(), 'pth_external_path')
        for body in [b'/private/tmp/external/site-packages\n', b'../../../../outside\n', b'ghost/../../../../outside\n']:
            target.unlink()
            target = self.put('Frameworks/Space Name/foreign injector.pth', body)
            self.failed(self.result(), 'pth_external_path')
        target.unlink()
        self.put('Frameworks/Space Name/foreign injector.pth', b'.' + b'/' * 4096 + b'\n')
        with mock.patch.object(module.Auditor, 'resolve', side_effect=AssertionError('oversized line must not reach resolver')) as resolver:
            oversized = self.result()
            self.failed(oversized)
            self.assertIn('.pth path byte budget', oversized['error'])
            resolver.assert_not_called()

    def test_system_load_and_spaced_image_pass(self):
        self.put('MacOS/Executable With Spaces', thin([command(0xc, '/usr/lib/libSystem.B.dylib')]))
        report = self.result()
        self.assertFalse(report['failed'], report)
        self.assertEqual(report['native_images'], 1)

    def test_existing_loader_target_and_internal_alias_pass(self):
        self.put('Libraries/lib script.dylib', thin([command(0xd, '@loader_path/id-only-name.dylib')]))
        self.put('MacOS/main', thin([command(0xc, '@loader_path/../Libraries/lib script.dylib')]))
        (self.root / 'Libraries/alias.dylib').symlink_to('lib script.dylib')
        report = self.result()
        self.assertFalse(report['failed'], report)
        self.assertEqual(report['native_images'], 2)
        self.assertTrue(any(row['role'] == 'identity_metadata' for row in report['paths']))

    def test_external_rpath_is_search_policy_not_load(self):
        self.put('main', thin([command(0x8000001c, '/opt/homebrew/lib')]))
        report = self.result()
        self.failed(report, 'rpath_search_policy')
        self.assertTrue(all(row['role'] != 'load_dependency' for row in report['violations']))

    def test_external_identity_is_metadata_not_load(self):
        self.put('libid.dylib', thin([command(0xd, '/Users/synthetic/build/libid.dylib')]))
        report = self.result()
        self.failed(report, 'identity_metadata')
        self.assertTrue(all(row['role'] != 'load_dependency' for row in report['violations']))

    def test_other_non_system_absolute_load_fails(self):
        self.put('main', thin([command(0xc, '/private/tmp/libevil.dylib')]))
        self.failed(self.result(), 'load_dependency')

    def test_contextual_paths_remain_visibly_unqualified(self):
        self.put('main', thin([command(0xc, '@rpath/liboptional.dylib'), command(0xc, '@executable_path/libcontext.dylib')]))
        report = self.result()
        self.assertFalse(report['failed'], report)
        self.assertFalse(report['runtime_closure_qualified'])
        self.assertEqual({row['classification'] for row in report['paths']}, {'rpath_context_unqualified', 'executable_context_unqualified'})

    def test_enumeration_error_fails(self):
        self.put('main', thin())
        with mock.patch.object(module, '_scandir', side_effect=PermissionError('inert denied enumeration')):
            self.failed(self.result())

    def test_pth_read_error_fails(self):
        self.put('main', thin())
        self.put('Frameworks/relative.pth', b'relative\n')
        original = module._open
        def opening(path, flags):
            if str(path).endswith('relative.pth'):
                raise PermissionError('inert denied pth read')
            return original(path, flags)
        with mock.patch.object(module, '_open', side_effect=opening):
            self.failed(self.result())

    def test_short_descriptor_read_fails(self):
        self.put('main', thin())
        with mock.patch.object(module, '_pread', return_value=b''):
            self.failed(self.result())

    def test_loader_escape_never_opens_external_target(self):
        self.put('main', thin([command(0xc, '@loader_path/../../outside.dylib')]))
        outside = self.base / 'outside.dylib'
        outside.write_bytes(b'inert sentinel')
        before = outside.read_bytes()
        original, opened = module._open, []
        def opening(path, flags):
            opened.append(Path(path))
            self.assertIn(self.root, Path(path).parents)
            return original(path, flags)
        with mock.patch.object(module, '_open', side_effect=opening):
            self.failed(self.result(), 'load_dependency')
        self.assertNotIn(outside, opened)
        self.assertEqual(outside.read_bytes(), before)

    def test_external_namespace_link_fails_without_target_read(self):
        self.put('main', thin())
        link = self.root / 'external'
        link.symlink_to('/unopened/synthetic/path')
        self.failed(self.result())
        link.unlink()
        self.put('Frameworks/payload.txt', b'/Users/synthetic/site-packages\n')
        alias = self.root / 'Frameworks/inject.pth'
        alias.symlink_to('payload.txt')
        self.failed(self.result(), 'pth_external_path')
        alias.unlink()
        hook = self.root / 'Frameworks/sitecustomize.py'
        hook.symlink_to('payload.txt')
        self.failed(self.result(), 'python_customization_hook')
        hook.unlink()
        self.put('Resources/hooks/sitecustomize.py', b'# inert customization fixture\n')
        (self.root / 'Frameworks/aliasdir').symlink_to('../Resources/hooks')
        self.failed(self.result(), 'python_customization_hook')

    def test_thin_endians_and_fat_formats_covered(self):
        for index, (endian, wide) in enumerate([('<', True), ('>', True), ('<', False), ('>', False)]):
            self.put('image' + str(index), thin([command(0xc, '/usr/lib/libSystem.B.dylib', endian, wide)], endian, wide))
        self.put('fat32', fat(thin()))
        self.put('fat64', fat(thin(), wide=True))
        self.put('fat32little', fat(thin(), endian='<'))
        self.put('fat64little', fat(thin(), wide=True, endian='<'))
        report = self.result()
        self.assertFalse(report['failed'], report)
        self.assertEqual(report['native_images'], 8)

    def test_malformed_load_command_is_not_empty_pass(self):
        self.put('bad', thin([struct.pack('<II', 0xc, 0)]))
        self.failed(self.result())

    def test_empty_or_non_macho_tree_is_not_empty_pass(self):
        self.put('ordinary.txt', b'ordinary inert text')
        self.failed(self.result())

    def test_explicit_budget_failure_is_visible(self):
        self.put('main', thin())
        with self.assertRaisesRegex(module.AuditError, 'metadata read budget'):
            module.Auditor(self.root, max_read_bytes=1).run()
        with self.assertRaises(module.AuditError):
            module.Auditor(self.root, seconds=None)
        (self.root / 'expanding').symlink_to('expanding/' + 'x/' * 256)
        audit = module.Auditor(self.root)
        audit.scan()
        with self.assertRaisesRegex(module.AuditError, 'namespace resolution token budget'):
            audit.resolve('expanding')

    def test_root_loader_rpath_is_internal_and_archive_uninspected(self):
        self.put('main', thin([command(0x8000001c, '@loader_path')]))
        self.put('inert.a', b'!<arch>\nnot an archive payload audit')
        (self.root / 'Resources/vs-python').mkdir(mode=0o700, parents=True)
        self.put('Frameworks/site-packages/current.pth', b'../../Resources/vs-python\n')
        self.put('Frameworks/site-packages/context.pth', b'import sys\nrelative-optional\n')
        report = self.result()
        self.assertFalse(report['failed'], report)
        self.assertFalse(report['archives_inspected'])
        self.assertEqual({row['classification'] for row in report['unqualified_text']},
                         {'executable_pth_unqualified', 'optional_internal_pth_target_absent'})
        self.assertEqual(report['paths'][0]['role'], 'rpath_search_policy')


    def test_orphan_support_filesystem_still_requires_atomic(self):
        if LEGACY:
            self.skipTest('fixed passive parser control; no mutating repair invocation')
        # There is deliberately no inbound edge to Filesystem. Every staged
        # Mach-O is audited, so its own required sibling may not be absent.
        self.put('support/libboost_filesystem.dylib', thin([
            command(0xd, '@rpath/libboost_filesystem.dylib'),
            command(0xc, '@loader_path/libboost_atomic.dylib'),
            command(0xc, '/usr/lib/libc++.1.dylib')]))
        report = self.result()
        self.failed(report, 'load_dependency')
        self.assertTrue(any(row.get('path') == '@loader_path/libboost_atomic.dylib'
                            for row in report['violations']), report)

    def test_support_atomic_dependency_chain_is_not_one_level_only(self):
        if LEGACY:
            self.skipTest('fixed passive parser control; no mutating repair invocation')
        self.put('support/libboost_filesystem.dylib', thin([
            command(0xc, '@loader_path/libboost_atomic.dylib')]))
        self.put('support/libboost_atomic.dylib', thin([
            command(0xc, '@loader_path/libboost_thread.dylib')]))
        missing = self.result()
        self.failed(missing, 'load_dependency')
        self.assertTrue(any(row.get('image') == 'support/libboost_atomic.dylib'
                            and row.get('path') == '@loader_path/libboost_thread.dylib'
                            for row in missing['violations']), missing)
        self.put('support/libboost_thread.dylib', thin([
            command(0xc, '/usr/lib/libSystem.B.dylib')]))
        complete = self.result()
        self.assertFalse(complete['failed'], complete)
        self.assertEqual(complete['native_images'], 3)
        self.assertFalse(complete['runtime_closure_qualified'])


if __name__ == '__main__':
    unittest.main()
