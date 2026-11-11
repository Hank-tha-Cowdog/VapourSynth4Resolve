"""Focused successor-adapter contracts. Every filesystem/native port is fake.

No original 45-case model import/replay, tempfile, CDLL, native rename, or host API.
Run only under the separately bound offline verification command.
"""
from pathlib import Path
import dataclasses  # Trusted stdlib dependency preloaded before target guards.
import errno
import json
import sys
import stat
import time
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/macos_ofx_transaction.py'
M = types.ModuleType('vsres_macos_transaction_under_test')
M.__file__ = str(SOURCE)
sys.modules[M.__name__] = M
# Read the exact selected source, without sys.path insertion or cached bytecode.
SOURCE_BODY = SOURCE.read_bytes()


class ForbiddenOS(types.ModuleType):
    def __getattr__(self, name):
        raise AssertionError('OS access during target import: ' + name)


with patch.dict(sys.modules, {'ctypes': None, 'fcntl': None, 'os': ForbiddenOS('os')}):
    exec(compile(SOURCE_BODY, str(SOURCE), 'exec'), M.__dict__)
# Bind the real standard-library os namespace for later fake-port method patches;
# all live backend acquisition still goes through the explicitly replaced class.
import os as _standard_os
M.os = _standard_os


def pin(inode, label='candidate'):
    files = (('Contents/Info.plist', 0o644, 5, 'a' * 64),
             ('Contents/MacOS/VapourSynth.ofx', 0o755, 7, 'b' * 64))
    rows = (('', 'dir', label), ('Contents', 'dir'), ('Contents/MacOS', 'dir'))
    return M.BundlePin(7, inode, rows, files)


def host_platform(**changes):
    value = {'schema': M.HOST_PLATFORM_SCHEMA, 'operation': 'test_operation',
             'window': 'window-1', 'observation_id': 'host-observation-1',
             'operating_system': 'macOS', 'product_version': '26.0',
             'architecture': 'arm64', 'evidence_sha256': 'c' * 64}
    value.update(changes)
    return value


class FakeCalls:
    def __init__(self, before):
        self.entries = {'destination': before, 'stage': pin(200), 'original': None,
                        'failed': None, 'backup': None if before is None else
                        M.BundlePin(7, 300, before.rows, before.files)}
        self.paths, self.fds, self.closed = {}, {}, []
        self.cleanup_errors = []
        self.rows, self.bytes, self.renames = [], b'', []
        self.existing_journal = False
        self.fail_kind = self.on_intent = self.native_fault = None
        self.on_record = None
        self.fail_sync = False
        self.close_fault = None
        self.path_drift = False
        self.stale_errno = 0

    def open_parent(self, path):
        role = ('destination' if path.endswith('/Plugins') else
                'failed' if path.endswith('/failed-candidate') else
                'custody' if path.endswith('.vsres-test_operation') else path.rsplit('/', 1)[1])
        fd = 100 + len(self.paths)
        self.paths[path] = fd
        self.fds[fd] = role
        return fd

    def identity(self, fd):
        return (7, fd + 1000, 0o40700, 501, 20)

    def path_identity(self, path):
        value = self.identity(self.paths[path])
        return (8,) + value[1:] if self.path_drift else value

    def scan(self, fd, check):
        check()
        return self.entries[self.fds[fd]]

    def create_journal(self, parent):
        if self.existing_journal:
            raise FileExistsError(errno.EEXIST, 'existing consumed journal')
        self.existing_journal = True
        return 900

    def journal_identity(self, fd, parent):
        return (7, 900)

    def append_durable(self, fd, body, expected):
        row = json.loads(body)
        self.bytes += body
        if row['kind'] == self.fail_kind:
            raise OSError(errno.EIO, 'synthetic lost journal ACK')
        if self.bytes != expected:
            raise RuntimeError('synthetic readback mismatch')
        self.rows.append(row)
        if self.on_record:
            self.on_record(row['kind'])
        if row['kind'] == 'MOVE_INTENT' and self.on_intent:
            self.on_intent()

    def sync_parent(self, fd):
        if self.fail_sync:
            raise OSError(errno.EIO, 'synthetic directory sync failure')

    def rename_excl(self, src, dst):
        source, target = self.fds[src], self.fds[dst]
        self.renames.append((source, target))
        fault = self.native_fault
        if fault == 'EXCEPTION_AFTER_MOVE':
            self.entries[target], self.entries[source] = self.entries[source], None
            raise OSError(errno.EIO, 'lost return')
        if fault == 'OCCUPANT_AT_NATIVE_CALL':
            self.entries[target] = pin(777, 'foreign')
            return -1, errno.EEXIST
        if isinstance(fault, tuple):
            return fault
        if self.entries[target] is not None:
            return -1, errno.EEXIST
        self.entries[target], self.entries[source] = self.entries[source], None
        return 0, self.stale_errno

    def close(self, fd):
        self.closed.append(fd)
        if fd == self.close_fault:
            raise OSError(errno.EINTR, 'ambiguous close, never retry')


class ScanFilesystem:
    """Synthetic FD namespace for exercising the actual scanner implementation."""
    def __init__(self):
        self.nodes = {'': None, 'Contents': None, 'Contents/MacOS': None,
                      'Contents/Info.plist': b'plist',
                      'Contents/MacOS/VapourSynth.ofx': b'image'}
        self.descriptors, self.offsets, self.closed = {}, {}, []
        self.next_fd = 10
        self.link = self.hardlink = self.changed = False
        self.rebound = self.grew = self.large_directory = False
        self.root_stats = self.iterator_closes = 0
        self.open_flags = []

    def node_stat(self, path):
        index = sorted(self.nodes).index(path) + 100
        directory = self.nodes[path] is None
        mode = 0o40755 if directory else (0o100644 if path.endswith('plist') else 0o100755)
        if self.link and path.endswith('plist'):
            mode = 0o120777
        return types.SimpleNamespace(st_dev=7, st_ino=index, st_mode=mode,
            st_uid=501, st_gid=20, st_flags=0, st_mtime_ns=1, st_birthtime=1.0,
            st_ctime_ns=2 if self.changed and any(self.offsets.values()) else 1,
            st_size=0 if directory else len(self.nodes[path]), st_nlink=2 if self.hardlink else 1)

    def stat(self, name, *, dir_fd, follow_symlinks):
        path = '' if dir_fd == 1 else self.descriptors[dir_fd]
        path = '' if name == M.LEAF else (path + '/' if path else '') + name
        value = self.node_stat(path)
        if name == M.LEAF and dir_fd == 1:
            self.root_stats += 1
            if self.rebound and self.root_stats > 1:
                value.st_ino = 99999
        return value

    def open(self, name, flags, *, dir_fd):
        path = '' if dir_fd == 1 else self.descriptors[dir_fd]
        path = '' if name == M.LEAF else (path + '/' if path else '') + name
        self.next_fd += 1
        self.descriptors[self.next_fd] = path
        self.offsets[self.next_fd] = 0
        self.open_flags.append(flags)
        return self.next_fd

    def fstat(self, fd):
        return self.node_stat(self.descriptors[fd])

    def listdir(self, fd):
        base = self.descriptors[fd]
        prefix = base + '/' if base else ''
        return [p[len(prefix):] for p in self.nodes if p.startswith(prefix) and
                p != base and '/' not in p[len(prefix):]]

    def scandir(self, fd):
        names = (str(i) for i in range(65)) if self.large_directory else iter(self.listdir(fd))
        fs = self
        class Iterator:
            def __iter__(self):
                return self
            def __next__(self):
                return types.SimpleNamespace(name=next(names))
            def close(self):
                fs.iterator_closes += 1
        return Iterator()

    def read(self, fd, size):
        body = self.nodes[self.descriptors[fd]]
        offset = self.offsets[fd]
        self.offsets[fd] += size
        return (body + b'grew') if self.grew and offset == 0 else body[offset:offset + size]

    def close(self, fd):
        self.closed.append(fd)

    def port(self):
        names = ('O_RDONLY', 'O_DIRECTORY', 'O_CLOEXEC', 'O_NOFOLLOW', 'O_NONBLOCK')
        return types.SimpleNamespace(**{name: getattr(M.os, name) for name in names},
            stat=self.stat, open=self.open, fstat=self.fstat, scandir=self.scandir,
            read=self.read, close=self.close)


class AdapterContracts(unittest.TestCase):
    def setup_adapter(self, before=True, opened=True):
        original = pin(100, 'original') if before else None
        fake = FakeCalls(original)
        gates = {key: True for key in M.FACTS}
        gates.update(operation='test_operation', window='window-1',
                     cancel_forward=False, cancel_rollback=False,
                     host_platform=host_platform())
        binding = M.Binding('test_operation', 'window-1', time.monotonic() + 10,
                            fake.entries['stage'], original)
        adapter = M.DarwinAdapter(binding, lambda: dict(gates))
        if opened:
            with patch.object(M, '_DarwinCalls', return_value=fake):
                adapter.open()
            self.addCleanup(adapter.close)
        return adapter, fake, gates

    def test_module_import_is_passive(self):
        body = SOURCE.read_bytes()
        fresh = types.ModuleType('vsres_passive_import_check')
        fresh.__file__ = str(SOURCE)
        with patch.dict(sys.modules, {fresh.__name__: fresh, 'ctypes': None,
                                      'fcntl': None, 'os': ForbiddenOS('os')}):
            exec(compile(body, str(SOURCE), 'exec'), fresh.__dict__)
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
            self.setup_adapter(opened=False)

    def test_closed_host_gate_precedes_backend_construction(self):
        adapter, fake, gates = self.setup_adapter(opened=False)
        gates['host_and_jobs_closed'] = False
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
            with self.assertRaisesRegex(M.Refusal, 'host_and_jobs_closed'):
                adapter.open()
        self.assertFalse(fake.existing_journal)

    def test_successor_existing_bundle_roundtrip(self):
        adapter, fake, _ = self.setup_adapter()
        engine = M.FixedTransaction(adapter)
        self.assertEqual(engine.commit()['phase'], 'INSTALLED_PENDING_HOST_VERIFICATION')
        self.assertEqual(engine.rollback()['phase'], 'ROLLED_BACK_ORIGINAL')
        self.assertEqual(fake.renames, list(M.MOVES))
        self.assertEqual(len(adapter.attempted_pairs), 4)

    def test_successor_original_absence_inverse(self):
        adapter, fake, _ = self.setup_adapter(before=False)
        engine = M.FixedTransaction(adapter)
        engine.commit()
        self.assertEqual(engine.rollback()['phase'], 'ROLLED_BACK_ABSENCE')
        self.assertIsNone(fake.entries['destination'])

    def test_target_arrival_is_refused_by_native_boundary(self):
        adapter, fake, _ = self.setup_adapter()
        fake.native_fault = 'OCCUPANT_AT_NATIVE_CALL'
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'RENAME:EEXIST')
        self.assertFalse(result['uncertain'])
        self.assertEqual(fake.entries['original'], pin(777, 'foreign'))
        self.assertEqual(fake.entries['destination'], adapter.binding.before)

    def test_unknown_errno_and_malformed_return_park_without_inverse(self):
        for outcome in [(-1, errno.EIO), (-1, 0), (False, 0), (0, False), (2, 0)]:
            with self.subTest(outcome=outcome):
                adapter, fake, _ = self.setup_adapter()
                fake.native_fault = outcome
                engine = M.FixedTransaction(adapter)
                self.assertEqual(engine.commit()['phase'], 'PARKED_UNKNOWN')
                engine.rollback()
                self.assertEqual(len(fake.renames), 1)

    def test_success_ignores_stale_errno_but_retains_it(self):
        adapter, fake, _ = self.setup_adapter()
        fake.stale_errno = errno.EPERM
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['phase'], 'INSTALLED_PENDING_HOST_VERIFICATION')
        self.assertEqual(result['last_native']['errno'], errno.EPERM)
        self.assertIsNone(result['primary_failure'])

    def test_native_error_precedes_lost_outcome_journal_ack(self):
        adapter, fake, _ = self.setup_adapter()
        fake.native_fault, fake.fail_kind = (-1, errno.EACCES), 'NATIVE_RETURN'
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'RENAME:EACCES')
        self.assertIn('lost journal ACK', result['journal_failure'])
        self.assertTrue(result['uncertain'])

    def test_native_exception_after_effect_never_triggers_inverse(self):
        adapter, fake, _ = self.setup_adapter()
        fake.native_fault = 'EXCEPTION_AFTER_MOVE'
        engine = M.FixedTransaction(adapter)
        self.assertTrue(engine.commit()['uncertain'])
        engine.rollback()
        self.assertEqual(len(fake.renames), 1)

    def test_post_intent_cancellation_rechecks_before_native(self):
        adapter, fake, gates = self.setup_adapter()
        fake.on_intent = lambda: gates.update(cancel_forward=True)
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'CANCELLED')
        self.assertEqual(fake.renames, [])
        self.assertEqual(fake.rows[-1]['kind'], 'MOVE_NOT_ISSUED')

    def test_first_refusal_survives_failed_not_issued_retention(self):
        adapter, fake, gates = self.setup_adapter()
        fake.on_intent = lambda: gates.update(cancel_forward=True)
        fake.fail_kind = 'MOVE_NOT_ISSUED'
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'CANCELLED')
        self.assertTrue(result['uncertain'])

    def test_parent_drift_after_intent_refuses_acquisition(self):
        adapter, fake, _ = self.setup_adapter()
        fake.on_intent = lambda: setattr(fake, 'path_drift', True)
        result = M.FixedTransaction(adapter).commit()
        self.assertIn('PARENT_CUSTODY', result['primary_failure'])
        self.assertEqual(fake.renames, [])

    def test_new_engine_cannot_reset_operation_reservation(self):
        adapter, fake, _ = self.setup_adapter()
        first = M.FixedTransaction(adapter)
        first.commit()
        count = len(fake.renames)
        result = M.FixedTransaction(adapter).commit()
        self.assertIn('ALREADY_CONSUMED', result['primary_failure'])
        self.assertEqual(len(fake.renames), count)

    def test_existing_journal_refuses_process_restart(self):
        adapter, fake, _ = self.setup_adapter(opened=False)
        fake.existing_journal = True
        with patch.object(M, '_DarwinCalls', return_value=fake):
            with self.assertRaises(FileExistsError):
                adapter.open()
        self.assertEqual(fake.renames, [])
        self.assertEqual(len(fake.closed), 6)

    def test_lost_reservation_ack_is_consumed_and_never_moves(self):
        adapter, fake, _ = self.setup_adapter()
        fake.fail_kind = 'RESERVED'
        result = M.FixedTransaction(adapter).commit()
        self.assertTrue(result['directions_consumed']['forward'])
        self.assertTrue(result['uncertain'])
        self.assertEqual(fake.renames, [])

    def test_changed_candidate_after_verified_install_is_custody_loss(self):
        adapter, fake, _ = self.setup_adapter()
        engine = M.FixedTransaction(adapter)
        engine.commit()
        fake.entries['destination'] = None
        result = engine.rollback()
        self.assertEqual(result['rollback_failure'], 'VERIFIED_INSTALLED_CANDIDATE_CUSTODY_LOST')
        self.assertTrue(result['uncertain'])
        self.assertEqual(len(fake.renames), 2)

    def test_backup_body_mismatch_refuses_open_before_journal(self):
        adapter, fake, _ = self.setup_adapter(opened=False)
        fake.entries['backup'] = pin(300, 'different backup')
        with patch.object(M, '_DarwinCalls', return_value=fake):
            with self.assertRaisesRegex(M.Refusal, 'FAITHFUL_BACKUP_PIN'):
                adapter.open()
        self.assertFalse(fake.existing_journal)
        self.assertEqual(len(fake.closed), 6)

    def test_unknown_close_is_not_retried(self):
        adapter, fake, _ = self.setup_adapter()
        fake.close_fault = 101
        errors = adapter.close()
        adapter.close()
        self.assertEqual(fake.closed.count(101), 1)
        self.assertEqual(errors[0]['errno'], errno.EINTR)
        self.assertEqual(adapter.fds, {})

    def test_expired_original_deadline_refuses_before_native(self):
        adapter, fake, _ = self.setup_adapter()
        with patch.object(M.time, 'monotonic', return_value=adapter.binding.deadline + 1):
            result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'ORIGINAL_DEADLINE')
        self.assertFalse(result['directions_consumed']['forward'])
        self.assertEqual(fake.renames, [])

    def test_native_errno_capture_is_immediate_and_fixed_flags_only(self):
        calls = object.__new__(M._DarwinCalls)
        trace = []
        calls.c = types.SimpleNamespace(set_errno=lambda n: trace.append(('clear', n)),
                                        get_errno=lambda: trace.append(('errno',)) or errno.EEXIST)
        calls.rename = lambda *args: trace.append(('call', args)) or -1
        self.assertEqual(calls.rename_excl(10, 11), (-1, errno.EEXIST))
        self.assertEqual(trace, [('clear', 0), ('call', (10, M.LEAF.encode(), 11,
                                                       M.LEAF.encode(), 4)), ('errno',)])

    def test_real_journal_writer_handles_partial_writes_and_readback(self):
        calls = object.__new__(M._DarwinCalls)
        body, trace = bytearray(), []
        def write(fd, chunk):
            body.extend(chunk[:2])
            return min(2, len(chunk))
        fake_os = types.SimpleNamespace(write=write, fsync=lambda fd: trace.append('fsync'),
                                        fstat=lambda fd: types.SimpleNamespace(st_size=len(body)),
                                        pread=lambda fd, size, offset: bytes(body))
        calls.fcntl = types.SimpleNamespace(F_FULLFSYNC=51, fcntl=lambda fd, flag: trace.append(flag))
        with patch.object(M, 'os', fake_os):
            calls.append_durable(9, b'abcdef', b'abcdef')
        self.assertEqual(bytes(body), b'abcdef')
        self.assertEqual(trace, ['fsync', 51])

    def test_real_journal_writer_rejects_zero_write_or_wrong_readback(self):
        for written, readback in [(0, b'abc'), (3, b'bad')]:
            with self.subTest(written=written):
                calls = object.__new__(M._DarwinCalls)
                calls.fcntl = types.SimpleNamespace(F_FULLFSYNC=51, fcntl=lambda *args: None)
                fake_os = types.SimpleNamespace(write=lambda *args: written, fsync=lambda fd: None,
                    fstat=lambda fd: types.SimpleNamespace(st_size=3), pread=lambda *args: readback)
                with patch.object(M, 'os', fake_os):
                    with self.assertRaises(M.Refusal):
                        calls.append_durable(9, b'abc', b'abc')

    def test_loader_binds_only_fixed_symbols_and_exact_rename_abi(self):
        names = ('renameatx_np', 'acl_get_fd_np', 'acl_size', 'acl_copy_ext',
                 'acl_free', 'flistxattr', 'fgetxattr')
        lib = types.SimpleNamespace(**{name: types.SimpleNamespace() for name in names})
        observed = []
        fake_c = types.SimpleNamespace(CDLL=lambda path, **kw: observed.append((path, kw)) or lib,
            c_int='int', c_char_p='char*', c_uint='unsigned', c_void_p='void*',
            c_ssize_t='ssize', c_size_t='size', c_uint32='u32')
        fake_f = types.SimpleNamespace()
        with patch.dict(sys.modules, ctypes=fake_c, fcntl=fake_f):
            with patch.object(M.sys, 'platform', 'darwin'):
                calls = M._DarwinCalls()
        self.assertEqual(observed, [('/usr/lib/libSystem.B.dylib', {'use_errno': True})])
        self.assertEqual(calls.rename.argtypes, ['int', 'char*', 'int', 'char*', 'unsigned'])
        self.assertEqual(calls.rename.restype, 'int')
        self.assertEqual(calls.get_attr.argtypes, ['int', 'char*', 'void*', 'size', 'u32', 'int'])

    def test_real_scanner_hashes_fixed_body_and_uses_nofollow_fds(self):
        fs = ScanFilesystem()
        calls = object.__new__(M._DarwinCalls)
        calls.cleanup_errors = []
        calls.metadata = lambda fd: ('synthetic-acl', ())
        with patch.object(M, 'os', fs.port()):
            result = calls.scan(1, lambda: None)
        self.assertEqual([r[0] for r in result.files],
                         ['Contents/Info.plist', 'Contents/MacOS/VapourSynth.ofx'])
        self.assertEqual(result.files[0][3], M.hashlib.sha256(b'plist').hexdigest())
        self.assertTrue(all(flags & M.os.O_NOFOLLOW for flags in fs.open_flags))
        self.assertEqual(len(fs.closed), len(fs.descriptors))

    def test_real_scanner_refuses_links_hardlinks_and_midread_changes(self):
        for fault, reason in [('link', 'LINK_OR_SPECIAL_ENTRY'),
                              ('hardlink', 'HARDLINKED_FILE'),
                              ('changed', 'BUNDLE_CHANGED_DURING_SCAN')]:
            with self.subTest(fault=fault):
                fs = ScanFilesystem()
                setattr(fs, fault, True)
                calls = object.__new__(M._DarwinCalls)
                calls.cleanup_errors = []
                calls.metadata = lambda fd: ('synthetic-acl', ())
                with patch.object(M, 'os', fs.port()):
                    with self.assertRaisesRegex(M.Refusal, reason):
                        calls.scan(1, lambda: None)
                self.assertEqual(len(fs.closed), len(set(fs.closed)))
                self.assertEqual(len(fs.closed), len(fs.descriptors))

    def test_close_many_attempts_all_owned_fds_once_and_keeps_primary(self):
        calls = object.__new__(M._DarwinCalls)
        calls.cleanup_errors = []
        trace = []
        def close(fd):
            trace.append(fd)
            if fd == 2:
                raise OSError(errno.EINTR, 'synthetic close')
        calls.close = close
        with self.assertRaisesRegex(M.UnknownOutcome, 'original scan failure'):
            calls.close_many([1, 2], M.Refusal('original scan failure'))
        self.assertEqual(trace, [2, 1])
        self.assertEqual(calls.cleanup_errors[0]['errno'], errno.EINTR)

    def test_real_parent_walk_rejects_symlink_error_and_closes_prior_fd(self):
        calls = object.__new__(M._DarwinCalls)
        calls.cleanup_errors = []
        opened, closed = [], []
        flags = {name: getattr(M.os, name) for name in
                 ['O_RDONLY', 'O_DIRECTORY', 'O_CLOEXEC', 'O_NOFOLLOW']}
        def open_path(path, mode, **kwargs):
            opened.append((path, mode, kwargs))
            if path == 'OFX':
                raise OSError(errno.ELOOP, 'synthetic nofollow refusal')
            return 10 + len(opened)
        fake_os = types.SimpleNamespace(**flags, open=open_path, close=closed.append,
            fstat=lambda fd: types.SimpleNamespace(st_dev=7, st_ino=fd, st_mode=0o40755,
                                                  st_uid=501, st_gid=20), getuid=lambda: 501)
        with patch.object(M, 'os', fake_os):
            with self.assertRaises(OSError):
                calls.open_parent('/Library/OFX')
        self.assertEqual(closed, [11, 12])
        self.assertTrue(all(mode & flags['O_NOFOLLOW'] for _, mode, _ in opened))

    def test_extra_candidate_directory_refuses_before_backend(self):
        base = pin(200)
        extra = M.BundlePin(7, 200, base.rows + (('unexpected', 'dir'),), base.files)
        with self.assertRaisesRegex(M.Refusal, 'DIRECTORY_ALLOWLIST'):
            M.DarwinAdapter(M.Binding('test_operation', 'window', time.monotonic()+10,
                                     extra, None), lambda: {})

    def test_backup_change_during_intent_prevents_native_move(self):
        adapter, fake, _ = self.setup_adapter()
        fake.on_intent = lambda: fake.entries.update(backup=pin(300, 'replaced backup'))
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'FAITHFUL_BACKUP_PIN')
        self.assertEqual(fake.renames, [])
        self.assertEqual(fake.rows[-1]['kind'], 'MOVE_NOT_ISSUED')

    def test_forward_reservation_cannot_issue_inverse_or_truthy_direction(self):
        for source, target, direction in [('destination', 'failed', False),
                                           ('original', 'destination', False),
                                           ('destination', 'original', 1)]:
            with self.subTest(pair=(source, target, direction)):
                adapter, fake, _ = self.setup_adapter()
                adapter.reserve('forward', M.FixedTransaction(adapter))
                with self.assertRaisesRegex(M.Refusal, 'FIXED_DIRECTION_MOVE_ONLY'):
                    adapter.move(source, target, adapter.binding.before, direction)
                self.assertEqual(fake.renames, [])

    def test_real_scanner_refuses_root_rebinding_growth_and_large_directory(self):
        for fault, reason in [('rebound', 'BUNDLE_ENTRY_REBOUND_DURING_SCAN'),
                              ('grew', 'BUNDLE_GREW_DURING_READ'),
                              ('large_directory', 'DIRECTORY_ENTRY_BUDGET')]:
            with self.subTest(fault=fault):
                fs = ScanFilesystem()
                setattr(fs, fault, True)
                calls = object.__new__(M._DarwinCalls)
                calls.cleanup_errors = []
                calls.metadata = lambda fd: ('synthetic-acl', ())
                with patch.object(M, 'os', fs.port()):
                    with self.assertRaisesRegex(M.Refusal, reason):
                        calls.scan(1, lambda: None)
                self.assertEqual(len(fs.closed), len(fs.descriptors))
                self.assertGreater(fs.iterator_closes, 0)

    def test_successful_native_move_with_lost_ack_never_runs_inverse(self):
        adapter, fake, _ = self.setup_adapter()
        fake.fail_kind = 'NATIVE_RETURN'
        engine = M.FixedTransaction(adapter)
        result = engine.commit()
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['last_native']['return'], 0)
        self.assertIsNone(fake.entries['destination'])
        self.assertEqual(fake.entries['original'], adapter.binding.before)
        engine.rollback()
        self.assertEqual(fake.renames, [('destination', 'original')])

    def test_post_native_parent_sync_failure_parks_moved_original(self):
        adapter, fake, _ = self.setup_adapter()
        def sync(fd):
            if fd != adapter.fds['custody']:
                raise OSError(errno.EIO, 'synthetic post-move parent sync')
        fake.sync_parent = sync
        result = M.FixedTransaction(adapter).commit()
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['last_native']['return'], 0)
        self.assertEqual(fake.renames, [('destination', 'original')])

    def test_completed_pair_cannot_be_reissued_directly(self):
        adapter, fake, _ = self.setup_adapter()
        engine = M.FixedTransaction(adapter)
        engine.commit()
        with self.assertRaisesRegex(M.Refusal, 'NATIVE_ATTEMPT_ALREADY_CONSUMED'):
            adapter.move('stage', 'destination', adapter.binding.candidate, False)
        self.assertEqual(len(fake.renames), 2)

    def test_unknown_outcome_rejects_reservation_without_any_journal_write(self):
        adapter, fake, _ = self.setup_adapter()
        fake.native_fault = 'EXCEPTION_AFTER_MOVE'
        engine = M.FixedTransaction(adapter)
        engine.commit()
        original_bytes, original_rows = fake.bytes, list(fake.rows)
        result = engine.rollback()
        self.assertEqual(fake.bytes, original_bytes)
        self.assertEqual(fake.rows, original_rows)
        self.assertFalse(result['directions_consumed']['rollback'])
        self.assertTrue(result['uncertain'])

    def test_acquisition_refusal_plus_ambiguous_close_retains_both(self):
        adapter, fake, _ = self.setup_adapter(opened=False)
        fake.entries['stage'] = pin(999, 'wrong stage')
        fake.close_fault = 101
        with patch.object(M, '_DarwinCalls', return_value=fake):
            with self.assertRaises(M.UnknownOutcome) as caught:
                adapter.open()
        self.assertEqual(caught.exception.primary_failure, 'STAGE_PIN')
        self.assertEqual(caught.exception.cleanup_errors[0]['errno'], errno.EINTR)
        self.assertEqual(fake.closed.count(101), 1)
        self.assertEqual(len(fake.closed), 6)

    def test_slow_admission_refuses_before_backend_acquisition(self):
        adapter, fake, gates = self.setup_adapter(opened=False)
        now = [adapter.binding.deadline - 1]
        def admission():
            now[0] = adapter.binding.deadline + 1
            return dict(gates)
        adapter.admission = admission
        with patch.object(M.time, 'monotonic', side_effect=lambda: now[0]):
            with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
                with self.assertRaisesRegex(M.Refusal, 'ADMISSION_ACK_LATE'):
                    adapter.open()
        self.assertFalse(fake.existing_journal)

    def test_last_post_intent_scan_cancellation_prevents_native_call(self):
        adapter, fake, gates = self.setup_adapter()
        scan = fake.scan
        def scanned(fd, check):
            value = scan(fd, check)
            if any(row['kind']=='MOVE_INTENT' for row in fake.rows) and fake.fds[fd]=='original':
                gates['cancel_forward'] = True
            return value
        fake.scan = scanned
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'CANCELLED')
        self.assertEqual(fake.renames, [])

    def test_post_native_sync_overrun_stops_before_second_parent_sync(self):
        adapter, fake, _ = self.setup_adapter()
        now, synced = [adapter.binding.deadline - 1], []
        def sync(fd):
            synced.append(fd)
            if fd != adapter.fds['custody']:
                now[0] = adapter.binding.deadline + 1
        fake.sync_parent = sync
        with patch.object(M.time, 'monotonic', side_effect=lambda: now[0]):
            result = M.FixedTransaction(adapter).commit()
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['last_native']['return'], 0)
        self.assertEqual(sum(fd != adapter.fds['custody'] for fd in synced), 1)
        self.assertEqual(len(fake.renames), 1)

    def test_final_direction_ack_cancellation_is_not_reported_as_success(self):
        adapter, fake, gates = self.setup_adapter()
        fake.on_record = lambda kind: gates.update(cancel_forward=True) if kind=='FORWARD_DONE' else None
        result = M.FixedTransaction(adapter).commit()
        self.assertNotEqual(result['phase'], 'INSTALLED_PENDING_HOST_VERIFICATION')
        self.assertEqual(result['primary_failure'], 'CANCELLED')
        self.assertEqual(len(result['verified_moves']), 2)

    def metadata_port(self, acl_size=3, free_failure=False, list_failure=False):
        calls = object.__new__(M._DarwinCalls)
        calls.cleanup_errors = []
        state = {'errno': 0, 'allocations': [], 'freed': []}
        def allocate(size):
            state['allocations'].append(size)
            return types.SimpleNamespace(raw=b'\0' * size)
        calls.c = types.SimpleNamespace(set_errno=lambda n: state.update(errno=n),
            get_errno=lambda: state['errno'], create_string_buffer=allocate)
        calls.acl = lambda fd, kind: 99
        calls.acl_size = lambda pointer: acl_size
        def copy(buffer, pointer, length):
            buffer.raw = b'acl'
            return length
        calls.acl_copy = copy
        def free(pointer):
            state['freed'].append(pointer)
            if free_failure:
                state['errno'] = errno.EIO
                return -1
            return 0
        calls.acl_free = free
        def names(fd, buffer, size, options):
            if list_failure:
                state['errno'] = errno.EACCES
                return -1
            buffer.raw = b'com.apple.ResourceFork\0'
            return len(buffer.raw)
        calls.list_attrs = names
        def attr(fd, name, buffer, size, position, options):
            buffer.raw = b'fork'
            return 4
        calls.get_attr = attr
        return calls, state

    def test_actual_metadata_method_captures_binary_acl_and_resource_fork(self):
        calls, state = self.metadata_port()
        acl, attrs = calls.metadata(10)
        self.assertEqual(acl, M.hashlib.sha256(b'acl').hexdigest())
        self.assertEqual(attrs, ((b'com.apple.ResourceFork'.hex(), 4,
                                 M.hashlib.sha256(b'fork').hexdigest()),))
        self.assertEqual(state['freed'], [99])
        self.assertEqual(max(state['allocations']), M.MAX_METADATA)

    def test_acl_oversize_and_free_failure_keep_primary_and_cleanup(self):
        calls, state = self.metadata_port(acl_size=M.MAX_METADATA+1, free_failure=True)
        with self.assertRaises(M.UnknownOutcome) as caught:
            calls.metadata(10)
        self.assertEqual(caught.exception.primary_failure, 'ACL_UNAVAILABLE_OR_LARGE')
        self.assertEqual(caught.exception.cleanup_errors[0]['errno'], errno.EIO)
        self.assertEqual(state['allocations'], [])
        self.assertEqual(state['freed'], [99])

    def test_metadata_native_refusal_retains_errno_without_relabeling_policy(self):
        calls, _ = self.metadata_port(list_failure=True)
        with self.assertRaises(OSError) as caught:
            calls.metadata(10)
        self.assertEqual(caught.exception.errno, errno.EACCES)
        self.assertIn('flistxattr', str(caught.exception))


class HostPlatformAdmissionContracts(unittest.TestCase):
    def unopened(self):
        return AdapterContracts.setup_adapter(self, opened=False)

    def refused_before_backend(self, observation, reason='HOST_PLATFORM'):
        adapter, fake, gates = self.unopened()
        gates['host_platform'] = observation
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')) as backend:
            with self.assertRaisesRegex(M.Refusal, reason):
                adapter.open()
        backend.assert_not_called()
        self.assertEqual(fake.paths, {})
        self.assertEqual(fake.rows, [])
        self.assertEqual(fake.renames, [])
        self.assertFalse(fake.existing_journal)
        self.assertIsNone(adapter.ops)
        return adapter, fake, gates

    def test_os26_and_later_product_versions_are_accepted_and_normalized(self):
        for raw, expected in [('26', (26, 0, 0)), ('26.0', (26, 0, 0)),
                              ('26.0.0', (26, 0, 0)), ('26.1.2', (26, 1, 2)),
                              ('27.0', (27, 0, 0)), ('100.1.2', (100, 1, 2))]:
            with self.subTest(raw=raw):
                observed = M.validate_host_platform(host_platform(product_version=raw),
                                                    'test_operation', 'window-1')
                self.assertEqual(observed.version, expected)
                self.assertEqual(observed.product_version, raw)
                self.assertEqual(observed.architecture, 'arm64')

    def test_old_product_versions_refuse_before_backend_or_filesystem(self):
        for raw in ('9.99', '10.15.7', '13.0', '25.9.999'):
            with self.subTest(raw=raw):
                self.refused_before_backend(host_platform(product_version=raw),
                                            'HOST_PLATFORM_MACOS26_REQUIRED')

    def test_unknown_os_and_wrong_architecture_refuse_before_backend(self):
        for changes in ({'operating_system': 'Darwin'}, {'operating_system': 'Linux'},
                        {'operating_system': ''}, {'architecture': 'x86_64'},
                        {'architecture': 'aarch64'}, {'architecture': 'ARM64'},
                        {'architecture': ''}):
            with self.subTest(changes=changes):
                self.refused_before_backend(host_platform(**changes))

    def test_product_version_malformed_or_ambiguous_forms_are_not_coerced(self):
        for raw in (None, True, 26, 26.0, (), '', '26.', '26..0', '026.0',
                    '26.00', '26.0beta', ' 26.0', '26.0\n', '26.0.0.1',
                    '26.0+build', '٢٦.٠', '26' * 20, '2147483648'):
            with self.subTest(raw=raw):
                self.refused_before_backend(host_platform(product_version=raw))

    def test_true_metadata_boolean_without_observation_cannot_pass(self):
        adapter, fake, gates = self.unopened()
        del gates['host_platform']
        self.assertTrue(gates['platform_metadata_verified'])
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
            with self.assertRaisesRegex(M.Refusal, 'HOST_PLATFORM_SCHEMA'):
                adapter.open()
        self.assertEqual(fake.paths, {})
        self.assertFalse(fake.existing_journal)
        for absent in (None, True, False, (), 'macOS26 arm64'):
            with self.subTest(absent=absent):
                self.refused_before_backend(absent, 'HOST_PLATFORM_SCHEMA')

    def test_exact_observation_schema_and_evidence_binding_are_required(self):
        class Forbidden(dict):
            def get(self, *args):
                raise AssertionError('custom mapping must not run')
        cases = [Forbidden(host_platform())]
        missing = host_platform()
        del missing['evidence_sha256']
        cases.extend((missing, host_platform(extra=True), host_platform(schema='future'),
                      host_platform(evidence_sha256='g' * 64),
                      host_platform(evidence_sha256='c' * 63),
                      host_platform(evidence_sha256=None),
                      host_platform(observation_id=''), host_platform(observation_id='has space'),
                      host_platform(observation_id='bad\nidentifier')))
        for case in cases:
            with self.subTest(case=type(case).__name__):
                self.refused_before_backend(case)

    def test_observation_for_other_operation_or_window_is_not_replayed(self):
        for changes in ({'operation': 'old_operation'}, {'window': 'old-window'}):
            with self.subTest(changes=changes):
                self.refused_before_backend(host_platform(**changes),
                                            'HOST_PLATFORM_OPERATION_WINDOW')

    def test_admitted_observation_is_frozen_and_recorded_in_binding(self):
        adapter, fake, gates = AdapterContracts.setup_adapter(self)
        observed = adapter.host_platform
        self.assertEqual(observed.version, (26, 0, 0))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            observed.architecture = 'x86_64'
        binding_row = fake.rows[0]
        self.assertEqual(binding_row['kind'], 'BINDING')
        self.assertEqual(binding_row['detail']['host_platform']['version'], [26, 0, 0])
        self.assertEqual(binding_row['detail']['host_platform']['evidence_sha256'], 'c' * 64)
        gates['host_platform']['product_version'] = '26.1'
        self.assertEqual(observed.product_version, '26.0')

    def test_valid_but_changed_observation_stops_before_reservation_write(self):
        for changes in ({'product_version': '26.1'}, {'product_version': '26.0.0'},
                        {'observation_id': 'host-observation-2'},
                        {'evidence_sha256': 'd' * 64}):
            with self.subTest(changes=changes):
                adapter, fake, gates = AdapterContracts.setup_adapter(self)
                prior_bytes = fake.bytes
                gates['host_platform'].update(changes)
                result = M.FixedTransaction(adapter).commit()
                self.assertEqual(result['primary_failure'], 'HOST_PLATFORM_DRIFT')
                self.assertFalse(result['uncertain'])
                self.assertFalse(result['directions_consumed']['forward'])
                self.assertEqual(fake.bytes, prior_bytes)
                self.assertEqual(fake.renames, [])

    def test_post_intent_platform_drift_prevents_native_rename(self):
        adapter, fake, gates = AdapterContracts.setup_adapter(self)
        fake.on_intent = lambda: gates['host_platform'].update(product_version='26.1')
        result = M.FixedTransaction(adapter).commit()
        self.assertEqual(result['primary_failure'], 'HOST_PLATFORM_DRIFT')
        self.assertEqual(fake.renames, [])
        self.assertEqual(fake.rows[-1]['kind'], 'MOVE_NOT_ISSUED')

    def test_post_native_platform_loss_preserves_effect_and_blocks_inverse(self):
        adapter, fake, gates = AdapterContracts.setup_adapter(self)
        rename = fake.rename_excl
        def changed_after_native(source, target):
            result = rename(source, target)
            gates['host_platform']['architecture'] = 'x86_64'
            return result
        fake.rename_excl = changed_after_native
        engine = M.FixedTransaction(adapter)
        result = engine.commit()
        self.assertEqual(result['phase'], 'PARKED_UNKNOWN')
        self.assertEqual(result['primary_failure'], 'HOST_PLATFORM_ARCHITECTURE')
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['last_native']['return'], 0)
        self.assertEqual(fake.renames, [('destination', 'original')])
        engine.rollback()
        self.assertEqual(fake.renames, [('destination', 'original')])

    def test_existing_platform_metadata_preservation_gate_still_required(self):
        adapter, fake, gates = self.unopened()
        gates['platform_metadata_verified'] = False
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
            with self.assertRaisesRegex(M.Refusal, 'platform_metadata_verified'):
                adapter.open()
        self.assertEqual(fake.paths, {})
        self.assertFalse(fake.existing_journal)

    def test_platform_refusal_consumes_adapter_open_attempt_without_retry(self):
        adapter, fake, gates = self.refused_before_backend(
            host_platform(product_version='25.0'), 'HOST_PLATFORM_MACOS26_REQUIRED')
        gates['host_platform'] = host_platform()
        with patch.object(M, '_DarwinCalls', side_effect=AssertionError('native load')):
            with self.assertRaisesRegex(M.Refusal, 'OPEN_ALREADY_CONSUMED'):
                adapter.open()
        self.assertEqual(fake.paths, {})
        self.assertEqual(fake.renames, [])


class RetainedJournalNamespace:
    """A shared fake directory entry, independent of any backend instance/FD.

    This drives the actual create_journal method's exclusive-open contract. It
    does not model kernel durability, global destination locks or crash replay.
    """
    def __init__(self, retained=None):
        self.parents = {71: ('custody', 700), 82: ('custody', 700)}
        self.entries = {} if retained is None else {
            (self.parents[71], M.JOURNAL): dict(retained)}
        self.opened, self.closed = [], []

    def open(self, name, flags, mode, *, dir_fd):
        expected = M.os.O_RDWR | M.os.O_CREAT | M.os.O_EXCL | M.os.O_CLOEXEC | M.os.O_NOFOLLOW
        if name != M.JOURNAL or flags != expected or mode != 0o600:
            raise AssertionError('exclusive fixed journal flags/name/mode required')
        key = (self.parents[dir_fd], name)
        self.opened.append((key, flags, mode))
        if key in self.entries:
            raise FileExistsError(errno.EEXIST, 'retained directory entry')
        self.entries[key] = {'body': b'', 'uid': 501, 'inode': 900}
        return 900

    def port(self):
        names = ('O_RDWR', 'O_CREAT', 'O_EXCL', 'O_CLOEXEC', 'O_NOFOLLOW')
        return types.SimpleNamespace(**{name: getattr(M.os, name) for name in names},
                                     open=self.open, close=self.closed.append)


class RestartOwnershipContracts(unittest.TestCase):
    def setup_adapter(self, **kwargs):
        return AdapterContracts.setup_adapter(self, **kwargs)

    def fresh_from(self, previous, *, operation='test_operation', window='window-2',
                   before=...):
        # Copy a simulated retained namespace into a new backend/adapter. The
        # separate shared-namespace tests below exercise actual O_EXCL flags;
        # these lifecycle cases are not evidence of real persistent storage.
        original = previous.entries['destination'] if before is ... else before
        fake = FakeCalls(original)
        fake.entries = dict(previous.entries)
        fake.existing_journal = previous.existing_journal
        fake.bytes, fake.rows = previous.bytes, list(previous.rows)
        custody = '/Library/OFX/.vsres-' + operation
        def open_parent(path):
            role = ('destination' if path.endswith('/Plugins') else
                    'failed' if path.endswith('/failed-candidate') else
                    'custody' if path == custody else path.rsplit('/', 1)[1])
            fd = 100 + len(fake.paths)
            fake.paths[path], fake.fds[fd] = fd, role
            return fd
        fake.open_parent = open_parent
        gates = {key: True for key in M.FACTS}
        gates.update(operation=operation, window=window, cancel_forward=False,
                     cancel_rollback=False, host_platform=host_platform(
                         operation=operation, window=window,
                         observation_id='fresh-host-observation'))
        binding = M.Binding(operation, window, time.monotonic() + 10,
                            fake.entries['stage'], original)
        return M.DarwinAdapter(binding, lambda: dict(gates)), fake, gates

    def assert_retained_open_refusal(self, adapter, fake, exception, reason=None):
        prior_bytes, prior_rows, prior_entries = fake.bytes, list(fake.rows), dict(fake.entries)
        with patch.object(M, '_DarwinCalls', return_value=fake):
            if reason is None:
                with self.assertRaises(exception):
                    adapter.open()
            else:
                with self.assertRaisesRegex(exception, reason):
                    adapter.open()
        self.assertTrue(adapter.open_attempted)
        self.assertTrue(adapter.closed)
        self.assertEqual(fake.bytes, prior_bytes)
        self.assertEqual(fake.rows, prior_rows)
        self.assertEqual(fake.entries, prior_entries)
        self.assertEqual(fake.renames, [])
        self.assertEqual(len(fake.closed), 6)

    def test_foreign_adapter_engine_cannot_consume_forward_reservation(self):
        adapter, fake, _ = self.setup_adapter()
        other, _, _ = self.setup_adapter()
        for engine in (M.FixedTransaction(other), object.__new__(M.FixedTransaction)):
            with self.subTest(engine=type(engine).__name__):
                before = fake.bytes
                with self.assertRaisesRegex(M.Refusal, 'RESERVATION_OWNER'):
                    adapter.reserve('forward', engine)
                self.assertFalse(adapter.used['forward'])
                self.assertIsNone(adapter.owner)
                self.assertEqual(fake.bytes, before)
                self.assertEqual(fake.renames, [])

    def test_public_move_without_owner_token_refuses_before_effects(self):
        adapter, fake, _ = self.setup_adapter()
        owner = M.FixedTransaction(adapter)
        adapter.reserve('forward', owner)
        before_bytes, before_entries = fake.bytes, dict(fake.entries)
        with self.assertRaisesRegex(M.Refusal, 'NATIVE_OWNER'):
            adapter.move('destination', 'original', adapter.binding.before, False)
        self.assertEqual(fake.bytes, before_bytes)
        self.assertEqual(fake.entries, before_entries)
        self.assertEqual(fake.renames, [])
        self.assertEqual(adapter.attempted_pairs, set())

    def test_only_exact_reserved_engine_can_present_native_token(self):
        adapter, fake, _ = self.setup_adapter()
        other, _, _ = self.setup_adapter()
        owner = M.FixedTransaction(adapter)
        adapter.reserve('forward', owner)
        before = fake.bytes
        for engine in (M.FixedTransaction(adapter), M.FixedTransaction(other),
                       object.__new__(M.FixedTransaction), object()):
            with self.subTest(engine=type(engine).__name__):
                with self.assertRaisesRegex(M.Refusal, 'NATIVE_OWNER'):
                    adapter.move('destination', 'original', adapter.binding.before,
                                 False, engine=engine)
                self.assertIs(adapter.owner, owner)
                self.assertEqual(fake.bytes, before)
                self.assertEqual(fake.renames, [])
                self.assertEqual(adapter.attempted_pairs, set())

    def test_rebound_owner_engine_adapter_cannot_issue_native_move(self):
        adapter, fake, _ = self.setup_adapter()
        other, _, _ = self.setup_adapter()
        owner = M.FixedTransaction(adapter)
        adapter.reserve('forward', owner)
        owner.adapter = other
        before = fake.bytes
        with self.assertRaisesRegex(M.Refusal, 'NATIVE_OWNER'):
            adapter.move('destination', 'original', adapter.binding.before,
                         False, engine=owner)
        self.assertEqual(fake.bytes, before)
        self.assertEqual(fake.renames, [])

    def test_foreign_rollback_cannot_consume_original_owner_inverse(self):
        adapter, fake, _ = self.setup_adapter()
        owner = M.FixedTransaction(adapter)
        owner.commit()
        before_bytes, before_moves = fake.bytes, list(fake.renames)
        foreign = M.FixedTransaction(adapter)
        result = foreign.rollback()
        self.assertEqual(result['rollback_failure'], 'ROLLBACK_OWNER')
        self.assertFalse(adapter.used['rollback'])
        self.assertIs(adapter.owner, owner)
        self.assertEqual(fake.bytes, before_bytes)
        self.assertEqual(fake.renames, before_moves)
        self.assertEqual(owner.rollback()['phase'], 'ROLLED_BACK_ORIGINAL')
        self.assertEqual(fake.renames, list(M.MOVES))

    def test_exclusive_journal_entry_survives_backend_instance_restart(self):
        namespace = RetainedJournalNamespace()
        first = object.__new__(M._DarwinCalls)
        restarted = object.__new__(M._DarwinCalls)
        with patch.object(M, 'os', namespace.port()):
            fd = first.create_journal(71)
            first.close(fd)
            before = dict(namespace.entries)
            with self.assertRaises(FileExistsError):
                restarted.create_journal(82)
        self.assertEqual(namespace.entries, before)
        self.assertEqual(namespace.closed, [900])
        self.assertEqual(len(namespace.opened), 2)
        self.assertEqual(namespace.opened[0][0], namespace.opened[1][0])

    def test_empty_partial_or_foreign_journal_entry_is_never_reopened(self):
        for retained in ({'body': b'', 'uid': 501, 'inode': 900},
                         {'body': b'{partial', 'uid': 501, 'inode': 900},
                         {'body': b'foreign journal', 'uid': 999, 'inode': 901}):
            with self.subTest(retained=retained):
                namespace = RetainedJournalNamespace(retained)
                before = {key: dict(value) for key, value in namespace.entries.items()}
                calls = object.__new__(M._DarwinCalls)
                with patch.object(M, 'os', namespace.port()):
                    with self.assertRaises(FileExistsError):
                        calls.create_journal(82)
                self.assertEqual(namespace.entries, before)
                self.assertEqual(namespace.closed, [])

    def test_journal_identity_refuses_foreign_owner_links_and_named_rebind(self):
        for fault, reason in [('owner', 'JOURNAL_OWNER_TYPE_MODE'),
                              ('links', 'JOURNAL_OWNER_TYPE_MODE'),
                              ('mode', 'JOURNAL_OWNER_TYPE_MODE'),
                              ('rebind', 'JOURNAL_ENTRY_CUSTODY')]:
            with self.subTest(fault=fault):
                observed = types.SimpleNamespace(st_dev=7, st_ino=900,
                    st_mode=stat.S_IFREG | (0o644 if fault == 'mode' else 0o600),
                    st_nlink=2 if fault == 'links' else 1,
                    st_uid=999 if fault == 'owner' else 501)
                named = types.SimpleNamespace(st_dev=7,
                    st_ino=901 if fault == 'rebind' else 900)
                calls = object.__new__(M._DarwinCalls)
                fake_os = types.SimpleNamespace(fstat=lambda fd: observed,
                    stat=lambda *args, **kwargs: named, getuid=lambda: 501)
                with patch.object(M, 'os', fake_os):
                    with self.assertRaisesRegex(M.Refusal, reason):
                        calls.journal_identity(900, 71)

    def test_same_retained_custody_journal_refuses_fresh_operation_or_window(self):
        # fresh_from maps every variant to the SAME retained fake namespace;
        # this does not serialize unrelated new/empty custody directories.
        first, previous, _ = self.setup_adapter()
        first.close()
        for operation, window in [('test_operation', 'window-1'),
                                  ('test_operation', 'window-2'),
                                  ('new_operation', 'window-1'),
                                  ('new_operation', 'window-2')]:
            with self.subTest(operation=operation, window=window):
                adapter, fake, _ = self.fresh_from(previous, operation=operation, window=window)
                self.assert_retained_open_refusal(adapter, fake, FileExistsError)

    def test_lost_binding_ack_is_not_reset_by_a_fresh_adapter(self):
        first, previous, _ = self.setup_adapter(opened=False)
        previous.fail_kind = 'BINDING'
        with patch.object(M, '_DarwinCalls', return_value=previous):
            with self.assertRaises(M.UnknownOutcome):
                first.open()
        self.assertTrue(previous.existing_journal)
        self.assertGreater(len(previous.bytes), 0)
        self.assertEqual(previous.rows, [])
        adapter, fake, _ = self.fresh_from(previous)
        self.assert_retained_open_refusal(adapter, fake, FileExistsError)

    def test_lost_native_ack_preserves_state_on_fresh_adapter_refusal(self):
        first, previous, _ = self.setup_adapter()
        previous.fail_kind = 'NATIVE_RETURN'
        result = M.FixedTransaction(first).commit()
        self.assertTrue(result['uncertain'])
        self.assertEqual(result['last_native']['return'], 0)
        self.assertEqual(previous.renames, [('destination', 'original')])
        self.assertIsNone(previous.entries['destination'])
        original = first.binding.before
        for before, reason in ((original, 'BEFORE_PIN'), (None, 'OWNED_SLOTS_OCCUPIED')):
            with self.subTest(reason=reason):
                adapter, fake, _ = self.fresh_from(previous, before=before)
                self.assert_retained_open_refusal(adapter, fake, M.Refusal, reason)
                self.assertEqual(fake.entries['original'], original)

    def test_rebound_parent_refuses_fresh_adapter_before_journal_or_move(self):
        first, previous, _ = self.setup_adapter()
        first.close()
        adapter, fake, _ = self.fresh_from(previous)
        fake.path_drift = True
        self.assert_retained_open_refusal(adapter, fake, M.Refusal, 'PARENT_CUSTODY')


if __name__ == '__main__':
    unittest.main(verbosity=2, failfast=True)
