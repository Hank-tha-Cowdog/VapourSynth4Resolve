"""Fixed OFX replacement primitives, with no command-line installer.

Import is passive. Darwin library loading and filesystem access happen only in
DarwinAdapter.open(), which a separately reviewed installation caller must admit.
Bindings, host observations and gate booleans describe evidence; they do not
grant permission or authenticate the host observation producer.
Staging, faithful backup creation, host observation and crash recovery are outside
this module. An existing operation journal always refuses automatic reopening.
"""
import errno
import hashlib
import json
import math
import os
import re
import stat
import sys
import time
from dataclasses import dataclass

LEAF = 'VapourSynth.ofx.bundle'
DESTINATION = '/Library/OFX/Plugins'
RENAME_EXCL = 4
ROLES = ('destination', 'stage', 'original', 'failed', 'backup')
MOVES = (('destination', 'original'), ('stage', 'destination'),
         ('destination', 'failed'), ('original', 'destination'))
FACTS = ('host_and_jobs_closed', 'operator_window_bound', 'executor_admitted',
         'runtime_log_custody', 'project_recovery_bound', 'observer_ready',
         'source_custody_exclusive', 'platform_metadata_verified',
         'backup_verified', 'rename_excl_supported')
NO_MOVE = frozenset(getattr(errno, name) for name in (
    'EEXIST', 'ENOTSUP', 'EINVAL', 'EXDEV', 'EBADF', 'ENOTDIR', 'ENOENT',
    'EACCES', 'EPERM', 'EROFS', 'ELOOP', 'ENOTEMPTY', 'EISDIR', 'ENOSPC',
    'EDQUOT', 'ENAMETOOLONG'))
MAX_BODY = 16 * 1024 * 1024
MAX_METADATA = 1024 * 1024
MAX_ROWS = 64
MAX_JOURNAL = 128 * 1024
JOURNAL = 'transaction.jsonl'


class Refusal(Exception):
    pass


class UnknownOutcome(Exception):
    pass


def need(value, reason):
    if not value:
        raise Refusal(reason)


HOST_PLATFORM_SCHEMA = 'macos-product-platform-v1'
HOST_PLATFORM_FIELDS = frozenset(('schema', 'operation', 'window', 'observation_id',
                                 'operating_system', 'product_version',
                                 'architecture', 'evidence_sha256'))
MINIMUM_MACOS = (26, 0, 0)


@dataclass(frozen=True)
class HostPlatformPin:
    # Supplied observed values, not OS acquisition or provenance authentication.
    operation: str
    window: str
    observation_id: str
    operating_system: str
    product_version: str
    version: tuple
    architecture: str
    evidence_sha256: str


def validate_host_platform(value, operation, window):
    """Validate a caller-observed macOS product version; perform no OS query.

    The admitted caller must acquire and bind actual, fresh host observations.
    A supplied evidence digest is a reference, not proof of origin or authority.
    Darwin kernel release numbers must never be substituted for ProductVersion.
    """
    need(type(value) is dict and len(value) == len(HOST_PLATFORM_FIELDS) and
         all(type(key) is str for key in value) and
         set(value) == HOST_PLATFORM_FIELDS, 'HOST_PLATFORM_SCHEMA')
    # Snapshot exact immutable primitive values before consuming them. No custom
    # mapping, string/numeric coercion or caller-owned mutable value is retained.
    need(all(type(part) is str for part in value.values()), 'HOST_PLATFORM_TYPES')
    observed = dict(value)
    need(observed['schema'] == HOST_PLATFORM_SCHEMA, 'HOST_PLATFORM_SCHEMA')
    need(observed['operation'] == operation and observed['window'] == window,
         'HOST_PLATFORM_OPERATION_WINDOW')
    need(0 < len(observed['observation_id']) <= 64 and re.fullmatch(
         r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', observed['observation_id']),
         'HOST_PLATFORM_OBSERVATION_ID')
    need(len(observed['evidence_sha256']) == 64 and re.fullmatch(
         r'[0-9a-f]{64}', observed['evidence_sha256']), 'HOST_PLATFORM_EVIDENCE_SHA')
    need(observed['operating_system'] == 'macOS', 'HOST_PLATFORM_OS')
    need(observed['architecture'] == 'arm64', 'HOST_PLATFORM_ARCHITECTURE')
    raw = observed['product_version']
    need(0 < len(raw) <= 32 and re.fullmatch(
         r'(?:0|[1-9][0-9]{0,9})(?:\.(?:0|[1-9][0-9]{0,9})){0,2}', raw),
         'HOST_PLATFORM_PRODUCT_VERSION')
    parts = tuple(int(part) for part in raw.split('.'))
    need(all(part <= 2147483647 for part in parts), 'HOST_PLATFORM_PRODUCT_VERSION')
    version = parts + (0,) * (3 - len(parts))
    need(version >= MINIMUM_MACOS, 'HOST_PLATFORM_MACOS26_REQUIRED')
    return HostPlatformPin(observed['operation'], observed['window'],
                           observed['observation_id'], observed['operating_system'],
                           raw, version, observed['architecture'],
                           observed['evidence_sha256'])


def packed(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8')


@dataclass(frozen=True)
class BundlePin:
    device: int
    inode: int
    # Observed subset: bodies, modes, owners, flags, mtime_ns, float birthtime,
    # binary ACL and xattrs. Excludes atime/ctime and sub-float birth precision.
    # External faithful-backup evidence must cover preservation beyond this pin.
    # Rename can change ctime; reads can change atime. Parent FDs are not a CAS.
    rows: tuple
    files: tuple

    @property
    def content(self):
        return hashlib.sha256(packed(self.rows)).hexdigest()


@dataclass(frozen=True)
class Binding:
    operation: str
    window: str
    deadline: float                 # Original monotonic deadline, never renewed.
    candidate: BundlePin
    before: object                 # BundlePin or None for verified absence.

    def validate(self):
        need(type(self.operation) is str and
             re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', self.operation), 'OPERATION_ID')
        need(type(self.window) is str and 0 < len(self.window) <= 128, 'WINDOW_ID')
        need(type(self.deadline) in (int, float) and math.isfinite(self.deadline), 'DEADLINE')
        need(type(self.candidate) is BundlePin and
             (self.before is None or type(self.before) is BundlePin), 'PIN_TYPES')
        need(tuple(row[0] for row in self.candidate.files) ==
             ('Contents/Info.plist', 'Contents/MacOS/VapourSynth.ofx'), 'TWO_FILE_ALLOWLIST')
        need(tuple(sorted(row[0] for row in self.candidate.rows if row[1] == 'dir')) ==
             ('', 'Contents', 'Contents/MacOS'), 'CANDIDATE_DIRECTORY_ALLOWLIST')
        for path, mode, size, digest in self.candidate.files:
            need(mode == (0o644 if path.endswith('Info.plist') else 0o755) and
                 type(size) is int and 0 < size <= MAX_BODY and
                 type(digest) is str and re.fullmatch(r'[0-9a-f]{64}', digest), 'CANDIDATE_FILE_PIN')
        need(self.before is None or
             (self.before.device, self.before.inode) !=
             (self.candidate.device, self.candidate.inode), 'CANDIDATE_ALIASES_ORIGINAL')


class _DarwinCalls:
    """The only real backend. Tests replace this class, never load libSystem."""
    def __init__(self):
        need(sys.platform == 'darwin', 'DARWIN_ONLY')
        import ctypes
        import fcntl
        self.c = ctypes
        self.fcntl = fcntl
        self.cleanup_errors = []
        self.lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        self.rename = self.lib.renameatx_np
        self.rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                                ctypes.c_char_p, ctypes.c_uint]
        self.rename.restype = ctypes.c_int
        # SDK sys/acl.h: ACL_TYPE_EXTENDED=0x100; acl_t is an opaque pointer.
        self.acl = self.lib.acl_get_fd_np
        self.acl.argtypes = [ctypes.c_int, ctypes.c_int]
        self.acl.restype = ctypes.c_void_p
        self.acl_size = self.lib.acl_size
        self.acl_size.argtypes = [ctypes.c_void_p]
        self.acl_size.restype = ctypes.c_ssize_t
        self.acl_copy = self.lib.acl_copy_ext
        self.acl_copy.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ssize_t]
        self.acl_copy.restype = ctypes.c_ssize_t
        self.acl_free = self.lib.acl_free
        self.acl_free.argtypes = [ctypes.c_void_p]
        self.acl_free.restype = ctypes.c_int
        self.list_attrs = self.lib.flistxattr
        self.list_attrs.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        self.list_attrs.restype = ctypes.c_ssize_t
        self.get_attr = self.lib.fgetxattr
        self.get_attr.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p,
                                 ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
        self.get_attr.restype = ctypes.c_ssize_t

    def rename_excl(self, src, dst):
        self.c.set_errno(0)
        result = self.rename(src, LEAF.encode('ascii'), dst, LEAF.encode('ascii'), RENAME_EXCL)
        error = self.c.get_errno()   # Capture immediately, before any other call.
        return result, error

    def close(self, fd):
        os.close(fd)

    def close_many(self, owned, primary):
        errors = []
        for fd in reversed(owned):
            try:
                self.close(fd)
            except BaseException as error:
                errors.append({'fd': fd, 'errno': getattr(error, 'errno', None),
                               'type': type(error).__name__})
        if errors:
            self.cleanup_errors.extend(errors)
            raise UnknownOutcome('FD_CLOSE_UNKNOWN; primary=' + str(primary)) from primary

    def identity(self, fd):
        s = os.fstat(fd)
        need(stat.S_ISDIR(s.st_mode), 'PARENT_NOT_DIRECTORY')
        need(s.st_uid in (0, os.getuid()) and s.st_mode & 0o022 == 0, 'PARENT_OWNER_MODE')
        return s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid

    def open_parent(self, path):
        need(path.startswith('/') and all(x not in ('.', '..', '')
             for x in path.split('/')[1:]), 'CANONICAL_PARENT_PATH')
        owned = []
        try:
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
            owned.append(fd)
            self.identity(fd)
            for part in path.split('/')[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                os.O_NOFOLLOW, dir_fd=fd)
                owned.append(child)
                self.identity(child)
                old = owned.pop(0)  # Give up ownership BEFORE close; never retry.
                self.close_many([old], None)
                fd = child
            owned.remove(fd)
            return fd
        finally:
            self.close_many(owned, sys.exc_info()[1])

    def path_identity(self, path):
        fd = self.open_parent(path)
        try:
            return self.identity(fd)
        finally:
            self.close_many([fd], sys.exc_info()[1])

    def metadata(self, fd):
        acl = None
        try:
            self.c.set_errno(0)
            acl = self.acl(fd, 0x100)
            if not acl:
                raise OSError(self.c.get_errno(), 'acl_get_fd_np refused')
            self.c.set_errno(0)
            length = self.acl_size(acl)
            error = self.c.get_errno()
            if length < 0:
                raise OSError(error, 'acl_size refused')
            need(0 <= length <= MAX_METADATA, 'ACL_UNAVAILABLE_OR_LARGE')
            buffer = self.c.create_string_buffer(length)
            self.c.set_errno(0)
            copied = self.acl_copy(buffer, acl, length)
            error = self.c.get_errno()
            if copied < 0:
                raise OSError(error, 'acl_copy_ext refused')
            need(copied == length, 'ACL_COPY_UNAVAILABLE')
            acl_bytes = buffer.raw[:length]  # Binary ACL; no account-name resolution.
        finally:
            primary, errors = sys.exc_info()[1], []
            for pointer in (acl,):
                if pointer:
                    try:
                        self.c.set_errno(0)
                        result = self.acl_free(pointer)
                        error = self.c.get_errno()
                        if result != 0:
                            raise OSError(error, 'acl_free refused')
                    except BaseException as error:
                        errors.append({'kind': 'ACL_FREE', 'type': type(error).__name__,
                                       'errno': getattr(error, 'errno', None)})
            if errors:
                self.cleanup_errors.extend(errors)
                unknown = UnknownOutcome('ACL_FREE_UNKNOWN; primary=' + str(primary))
                unknown.primary_failure = str(primary)
                unknown.cleanup_errors = tuple(errors)
                raise unknown from primary
        # Fixed buffers refuse ERANGE/oversize instead of allocating an unbound
        # resource fork or extended attribute before checking the byte budget.
        buffer = self.c.create_string_buffer(MAX_METADATA)
        self.c.set_errno(0)
        length = self.list_attrs(fd, buffer, MAX_METADATA, 0)
        error = self.c.get_errno()
        if length < 0:
            raise OSError(error, 'flistxattr refused')
        need(0 <= length <= MAX_METADATA, 'XATTR_LIST_UNAVAILABLE_OR_LARGE')
        raw_names = buffer.raw[:length]
        need(not raw_names or raw_names.endswith(b'\0'), 'XATTR_LIST_SCHEMA')
        names = sorted(raw_names[:-1].split(b'\0')) if raw_names else []
        attrs, total = [], 0
        need(len(names) <= 64, 'XATTR_COUNT')
        for name in names:
            self.c.set_errno(0)
            length = self.get_attr(fd, name, buffer, MAX_METADATA, 0, 0)
            error = self.c.get_errno()
            if length < 0:
                raise OSError(error, 'fgetxattr refused')
            need(0 <= length <= MAX_METADATA, 'XATTR_UNAVAILABLE_OR_LARGE')
            value = buffer.raw[:length]
            total += length
            need(total <= MAX_METADATA, 'XATTR_BYTES')
            attrs.append((name.hex(), len(value), hashlib.sha256(value).hexdigest()))
        return hashlib.sha256(acl_bytes).hexdigest(), tuple(attrs)

    def scan(self, parent, check):
        try:
            initial = os.stat(LEAF, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return None
        need(stat.S_ISDIR(initial.st_mode), 'BUNDLE_NOT_DIRECTORY')
        fd = os.open(LEAF, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                     os.O_NOFOLLOW, dir_fd=parent)
        rows, files = [], []
        total = [0]

        def names(current):
            iterator = os.scandir(current)
            try:
                result = []
                for entry in iterator:
                    check()
                    need(len(result) < 64, 'DIRECTORY_ENTRY_BUDGET')
                    result.append(entry.name)
                return sorted(result)
            finally:
                primary = sys.exc_info()[1]
                try:
                    iterator.close()
                except BaseException as error:
                    self.cleanup_errors.append({'kind': 'SCANDIR_CLOSE',
                                                'type': type(error).__name__})
                    raise UnknownOutcome('SCANDIR_CLOSE_UNKNOWN; primary=' + str(primary)) from primary

        def walk(current, rel, depth):
            check()
            need(depth <= 8 and len(rows) < 64, 'BUNDLE_SHAPE_BUDGET')
            before = os.fstat(current)
            need(before.st_dev == initial.st_dev and
                 (stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode)), 'BUNDLE_DEVICE_OR_TYPE')
            acl, attrs = self.metadata(current)
            digest, size = None, before.st_size
            if stat.S_ISREG(before.st_mode):
                need(before.st_nlink == 1, 'HARDLINKED_FILE')
                total[0] += size
                need(total[0] <= MAX_BODY, 'BUNDLE_BYTE_BUDGET')
                h = hashlib.sha256()
                observed = 0
                while True:
                    check()
                    block = os.read(current, 65536)
                    if not block:
                        break
                    observed += len(block)
                    need(observed <= size, 'BUNDLE_GREW_DURING_READ')
                    h.update(block)
                need(observed == size, 'BUNDLE_SHORT_READ')
                digest = h.hexdigest()
                files.append((rel, stat.S_IMODE(before.st_mode), size, digest))
            row = (rel, 'dir' if stat.S_ISDIR(before.st_mode) else 'file',
                   stat.S_IMODE(before.st_mode), before.st_uid, before.st_gid,
                   before.st_flags, before.st_mtime_ns, before.st_birthtime,
                   size if digest else None, digest, acl, attrs)
            rows.append(row)
            if stat.S_ISDIR(before.st_mode):
                before_names = names(current)
                for name in before_names:
                    check()
                    s = os.stat(name, dir_fd=current, follow_symlinks=False)
                    need(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode), 'LINK_OR_SPECIAL_ENTRY')
                    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
                    if stat.S_ISDIR(s.st_mode):
                        flags |= os.O_DIRECTORY
                    child = os.open(name, flags, dir_fd=current)
                    try:
                        actual = os.fstat(child)
                        need((actual.st_dev, actual.st_ino, actual.st_mode) ==
                             (s.st_dev, s.st_ino, s.st_mode), 'ENTRY_OPEN_RACE')
                        walk(child, rel + '/' + name if rel else name, depth + 1)
                    finally:
                        self.close_many([child], sys.exc_info()[1])
                need(before_names == names(current), 'DIRECTORY_CHANGED_DURING_SCAN')
            after = os.fstat(current)
            need((before.st_dev, before.st_ino, before.st_mode, before.st_size,
                  before.st_mtime_ns, before.st_ctime_ns) ==
                 (after.st_dev, after.st_ino, after.st_mode, after.st_size,
                  after.st_mtime_ns, after.st_ctime_ns), 'BUNDLE_CHANGED_DURING_SCAN')

        try:
            opened = os.fstat(fd)
            need((opened.st_dev, opened.st_ino) == (initial.st_dev, initial.st_ino), 'BUNDLE_OPEN_RACE')
            walk(fd, '', 0)
            try:
                current = os.stat(LEAF, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError as error:
                raise Refusal('BUNDLE_ENTRY_LOST_DURING_SCAN') from error
            need((current.st_dev, current.st_ino, current.st_mode) ==
                 (opened.st_dev, opened.st_ino, opened.st_mode), 'BUNDLE_ENTRY_REBOUND_DURING_SCAN')
            return BundlePin(opened.st_dev, opened.st_ino, tuple(sorted(rows)), tuple(sorted(files)))
        finally:
            self.close_many([fd], sys.exc_info()[1])

    def create_journal(self, parent):
        fd = os.open(JOURNAL, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                     os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        return fd

    def journal_identity(self, fd, parent):
        s, p = os.fstat(fd), os.stat(JOURNAL, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and
             s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600,
             'JOURNAL_OWNER_TYPE_MODE')
        need((s.st_dev, s.st_ino) == (p.st_dev, p.st_ino), 'JOURNAL_ENTRY_CUSTODY')
        return s.st_dev, s.st_ino

    def append_durable(self, fd, body, expected):
        offset = 0
        while offset < len(body):
            written = os.write(fd, body[offset:])
            need(written > 0, 'JOURNAL_SHORT_WRITE')
            offset += written
        os.fsync(fd)
        full = getattr(self.fcntl, 'F_FULLFSYNC', None)
        need(type(full) is int, 'FULLFSYNC_UNAVAILABLE')
        self.fcntl.fcntl(fd, full)
        need(os.fstat(fd).st_size == len(expected) and
             os.pread(fd, len(expected) + 1, 0) == expected, 'JOURNAL_READBACK')

    def sync_parent(self, fd):
        os.fsync(fd)  # Unsupported directory sync refuses/parks; no fallback.


class DarwinAdapter:
    def __init__(self, binding, admission):
        need(type(binding) is Binding and callable(admission), 'FIXED_BINDING_REQUIRED')
        binding.validate()
        self.binding, self.admission = binding, admission
        custody = '/Library/OFX/.vsres-' + binding.operation
        self.paths = {'destination': DESTINATION, 'stage': custody + '/stage',
                      'original': custody + '/original', 'failed': custody + '/failed-candidate',
                      'backup': custody + '/backup', 'custody': custody}
        self.ops, self.fds, self.anchors = None, {}, {}
        self.journal_fd, self.journal_identity = None, None
        self.journal_body, self.rows = b'', 0
        self.used = {'forward': False, 'rollback': False}
        self.owner = None
        self.uncertain = False
        self.journal_failure = None
        self.native_failure = {'forward': None, 'rollback': None}
        self.last_native = None
        self.close_errors = []
        self.attempted_pairs = set()
        self.open_attempted = self.closed = False
        self.host_platform = None

    def gates(self, rollback=False):
        need(not self.closed and not self.uncertain, 'CLOSED_OR_UNKNOWN')
        self._fresh_admission(rollback)

    def _fresh_admission(self, rollback):
        # Also usable while a known native success awaits post-effect checks.
        # It must not clear/reject the pending native uncertainty itself.
        need(time.monotonic() < self.binding.deadline, 'ORIGINAL_DEADLINE')
        value = self.admission()
        need(type(value) is dict and value.get('operation') == self.binding.operation and
             value.get('window') == self.binding.window, 'ADMISSION_IDENTITY')
        for key in FACTS:
            need(value.get(key) is True, 'GATE:' + key)
        need(value.get('cancel_rollback' if rollback else 'cancel_forward') is False, 'CANCELLED')
        platform = validate_host_platform(value.get('host_platform'),
                                          self.binding.operation, self.binding.window)
        if self.host_platform is None:
            self.host_platform = platform
        else:
            need(platform == self.host_platform, 'HOST_PLATFORM_DRIFT')
        need(time.monotonic() < self.binding.deadline, 'ADMISSION_ACK_LATE')

    def open(self):
        need(not self.open_attempted, 'OPEN_ALREADY_CONSUMED')
        self.open_attempted = True
        self.gates()
        self.ops = _DarwinCalls()  # Sole lazy live-library acquisition point.
        try:
            for role, path in self.paths.items():
                fd = self.ops.open_parent(path)
                self.fds[role] = fd
                self.anchors[role] = self.ops.identity(fd)
            need(len({x[0] for x in self.anchors.values()}) == 1, 'CROSS_DEVICE_CUSTODY')
            need(len({x[:2] for x in self.anchors.values()}) == len(self.anchors), 'ALIASED_PARENT')
            self.check_custody()
            need(self.entry('stage') == self.binding.candidate, 'STAGE_PIN')
            need(self.entry('destination') == self.binding.before, 'BEFORE_PIN')
            need(self.entry('original') is None and self.entry('failed') is None, 'OWNED_SLOTS_OCCUPIED')
            self.check_backup()
            self.journal_fd = self.ops.create_journal(self.fds['custody'])
            self.journal_identity = self.ops.journal_identity(self.journal_fd, self.fds['custody'])
            self.record('BINDING', {'binding': self.binding.__dict__,
                                    'host_platform': self.host_platform.__dict__,
                                    'anchors': self.anchors}, binding=True)
            return self
        except BaseException as primary:
            cleanup = self.close()
            if cleanup:
                error = UnknownOutcome('OPEN_CLEANUP_UNKNOWN; primary=' + str(primary))
                error.primary_failure = str(primary)
                error.cleanup_errors = cleanup
                raise error from primary
            raise

    def check_custody(self):
        need(not self.ops.cleanup_errors, 'PRIOR_BACKEND_CLEANUP_UNKNOWN')
        for role, frozen in self.anchors.items():
            need(self.ops.identity(self.fds[role]) == frozen and
                 self.ops.path_identity(self.paths[role]) == frozen, 'PARENT_CUSTODY:' + role)

    def entry(self, role):
        need(role in ROLES and role in self.fds, 'FIXED_ROLE_REQUIRED')
        return self.ops.scan(self.fds[role], lambda: need(
            time.monotonic() < self.binding.deadline, 'SCAN_DEADLINE'))

    def check_backup(self):
        backup = self.entry('backup')
        before = self.binding.before
        need((before is None and backup is None) or
             (before is not None and type(backup) is BundlePin and
              backup.content == before.content and
              (backup.device, backup.inode) != (before.device, before.inode)), 'FAITHFUL_BACKUP_PIN')

    def record(self, kind, detail, binding=False):
        try:
            need(time.monotonic() < self.binding.deadline, 'JOURNAL_DEADLINE')
            need(self.journal_fd is not None and self.rows < MAX_ROWS, 'JOURNAL_ROW_BUDGET')
            # dataclasses are rendered only in the initial bound snapshot.
            def simple(value):
                if type(value) is BundlePin:
                    return {'device': value.device, 'inode': value.inode,
                            'content': value.content, 'rows': value.rows, 'files': value.files}
                if type(value) is dict:
                    return {k: simple(v) for k, v in value.items()}
                return value
            body = packed({'sequence': self.rows, 'operation': self.binding.operation,
                           'kind': kind, 'detail': simple(detail)}) + b'\n'
            expected = self.journal_body + body
            need(len(expected) <= MAX_JOURNAL, 'JOURNAL_BYTE_BUDGET')
            need(self.ops.journal_identity(self.journal_fd, self.fds['custody']) ==
                 self.journal_identity, 'JOURNAL_IDENTITY_DRIFT')
            self.ops.append_durable(self.journal_fd, body, expected)
            self.ops.sync_parent(self.fds['custody'])
            need(self.ops.journal_identity(self.journal_fd, self.fds['custody']) ==
                 self.journal_identity, 'JOURNAL_POSTWRITE_CUSTODY')
            need(time.monotonic() < self.binding.deadline, 'JOURNAL_ACK_LATE')
            self.journal_body, self.rows = expected, self.rows + 1
        except BaseException as error:
            self.journal_failure = str(error)
            self.uncertain = True
            raise UnknownOutcome('JOURNAL_ACK_UNKNOWN') from error

    def reserve(self, direction, engine):
        need(not self.closed and not self.uncertain and self.journal_failure is None,
             'RESERVATION_AFTER_CLOSED_OR_UNKNOWN')
        need(type(engine) is FixedTransaction and
             getattr(engine, 'adapter', None) is self and direction in self.used,
             'RESERVATION_OWNER')
        need(not self.used[direction], direction.upper() + '_ALREADY_CONSUMED')
        if direction == 'rollback':
            need(self.owner is engine and self.used['forward'], 'ROLLBACK_OWNER')
        self.gates(direction == 'rollback')
        self.used[direction] = True   # Never reset after a failed write.
        if direction == 'forward':
            self.owner = engine
        self.record('RESERVED', {'direction': direction})

    def move(self, source, target, expected, rollback, *, engine=None):
        need(type(rollback) is bool and self.owner is not None and
             (source, target) in (MOVES[2:] if rollback else MOVES[:2]), 'FIXED_DIRECTION_MOVE_ONLY')
        direction = 'rollback' if rollback else 'forward'
        need(self.used[direction], 'DIRECTION_NOT_RESERVED')
        pair = (direction, source, target)
        need(pair not in self.attempted_pairs and len(self.attempted_pairs) < 4,
             'NATIVE_ATTEMPT_ALREADY_CONSUMED')
        need(type(engine) is FixedTransaction and self.owner is engine and
             getattr(engine, 'adapter', None) is self, 'NATIVE_OWNER')
        self.gates(rollback)
        self.check_custody()
        self.check_backup()
        need(self.entry(source) == expected, 'SOURCE_PIN:' + source)
        need(self.entry(target) is None, 'TARGET_OCCUPIED:' + target)
        self.record('MOVE_INTENT', {'source': source, 'target': target,
                                  'device': expected.device, 'inode': expected.inode,
                                  'content': expected.content, 'direction': direction})
        # Gate/identity changes during intent retention must prevent acquisition.
        try:
            self.gates(rollback)
            self.check_custody()
            self.check_backup()
            need(self.entry(source) == expected, 'POST_INTENT_SOURCE_PIN')
            need(self.entry(target) is None, 'POST_INTENT_TARGET_OCCUPIED')
            self.gates(rollback)  # Fresh safe point AFTER all potentially long scans.
        except BaseException as error:
            self.native_failure[direction] = self.native_failure[direction] or str(error)
            self.record('MOVE_NOT_ISSUED', {'source': source, 'target': target,
                                          'reason': str(error)})
            raise
        self.attempted_pairs.add(pair)
        self.uncertain = True
        try:
            result, error = self.ops.rename_excl(self.fds[source], self.fds[target])
        except BaseException as caught:
            self.native_failure[direction] = 'NATIVE_RETURN_UNKNOWN:' + type(caught).__name__
            raise UnknownOutcome(self.native_failure[direction]) from caught
        self.last_native = {'return': result, 'errno': error, 'source': source,
                            'target': target, 'direction': direction}
        valid = type(result) is int and type(error) is int
        if not valid or result != 0:
            self.native_failure[direction] = 'RENAME:' + (
                errno.errorcode.get(error, str(error)) if valid else 'MALFORMED_RETURN')
        # Preserve the raw outcome and first native failure before fallible ACK.
        self.record('NATIVE_RETURN', self.last_native)
        if valid and result == -1 and error in NO_MOVE:
            self.uncertain = False
            raise Refusal(self.native_failure[direction])
        if not valid or result != 0:
            raise UnknownOutcome('RENAME_OUTCOME_UNBOUND')
        self._fresh_admission(rollback)
        self.ops.sync_parent(self.fds[source])
        self._fresh_admission(rollback)
        self.ops.sync_parent(self.fds[target])
        self._fresh_admission(rollback)
        self.check_custody()
        need(self.entry(source) is None and self.entry(target) == expected, 'POST_MOVE_CUSTODY_UNKNOWN')
        self._fresh_admission(rollback)
        self.record('MOVE_DONE', {'source': source, 'target': target})
        self._fresh_admission(rollback)
        self.uncertain = False

    def close(self):
        if self.closed:
            return tuple(self.close_errors)
        self.closed = True
        owned = list(self.fds.values())
        self.fds.clear()             # Relinquish before close, including failures.
        if self.journal_fd is not None:
            owned.append(self.journal_fd)
            self.journal_fd = None
        for fd in reversed(owned):
            try:
                self.ops.close(fd)
            except BaseException as error:
                self.close_errors.append({'fd': fd, 'type': type(error).__name__,
                                          'errno': getattr(error, 'errno', None)})
        if self.ops is not None:
            self.close_errors.extend(self.ops.cleanup_errors)
        return tuple(self.close_errors)


class FixedTransaction:
    """One fixed four-move maximum sequence. Rollback is always explicit."""
    def __init__(self, adapter):
        need(type(adapter) is DarwinAdapter and adapter.journal_fd is not None and
             not adapter.closed, 'OPEN_FIXED_ADAPTER_REQUIRED')
        self.adapter = adapter
        self.before, self.candidate = adapter.binding.before, adapter.binding.candidate
        self.moves = []
        self.attempts = 0
        self.primary_failure = self.rollback_failure = None
        self.phase = 'NEW'

    def snapshot(self):
        return {'phase': self.phase, 'primary_failure': self.primary_failure,
                'rollback_failure': self.rollback_failure,
                'journal_failure': self.adapter.journal_failure,
                'last_native': self.adapter.last_native,
                'uncertain': self.adapter.uncertain, 'verified_moves': tuple(self.moves),
                'directions_consumed': dict(self.adapter.used),
                'close_errors': tuple(self.adapter.close_errors), 'public_release_held': True}

    def _move(self, source, target, pin, rollback=False):
        need(self.attempts < 4, 'FIXED_MOVE_BUDGET')
        self.attempts += 1
        self.adapter.move(source, target, pin, rollback, engine=self)
        self.moves.append((source, target))

    def _stop(self, error, rollback):
        if isinstance(error, UnknownOutcome):
            self.adapter.uncertain = True
        direction = 'rollback' if rollback else 'forward'
        first = self.adapter.native_failure[direction] or str(error)
        if rollback:
            self.rollback_failure = self.rollback_failure or first
        else:
            self.primary_failure = self.primary_failure or first
        self.phase = 'PARKED_UNKNOWN' if self.adapter.uncertain else 'STOPPED_PARTIAL_OR_UNCHANGED'
        # Avoid additional writes when custody or acknowledgment is unknown.
        return self.snapshot()

    def commit(self):
        try:
            self.adapter.reserve('forward', self)
            self.adapter.gates()
            need(self.adapter.entry('destination') == self.before, 'BEFORE_IDENTITY_MISMATCH')
            need(self.adapter.entry('original') is None and self.adapter.entry('failed') is None,
                 'OWNED_SLOTS_OCCUPIED')
            if self.before is not None:
                self._move('destination', 'original', self.before)
            self._move('stage', 'destination', self.candidate)
            self.phase = 'INSTALLED_PENDING_HOST_VERIFICATION'
            self.adapter.record('FORWARD_DONE', self.snapshot())
            self.adapter.gates()
            return self.snapshot()
        except BaseException as error:
            return self._stop(error, False)

    def rollback(self):
        try:
            self.adapter.reserve('rollback', self)
            self.adapter.gates(True)
            self.adapter.check_custody()
            self.adapter.check_backup()
            if not self.moves:
                need(self.adapter.entry('destination') == self.before and
                     self.adapter.entry('original') is None, 'NO_MOVE_BEFORE_STATE_CHANGED')
                self.phase = 'ROLLED_BACK_NO_EFFECT'
            else:
                need(self.adapter.entry('original') == self.before, 'RETAINED_ORIGINAL_PIN')
                current = self.adapter.entry('destination')
                if ('stage', 'destination') in self.moves and current != self.candidate:
                    self.adapter.uncertain = True
                    raise UnknownOutcome('VERIFIED_INSTALLED_CANDIDATE_CUSTODY_LOST')
                if current == self.candidate:
                    self._move('destination', 'failed', self.candidate, True)
                else:
                    need(current is None, 'ROLLBACK_DESTINATION_NOT_OWNED')
                if self.before is not None:
                    self._move('original', 'destination', self.before, True)
                need(self.adapter.entry('destination') == self.before and
                     self.adapter.entry('original') is None, 'RESTORE_INVERSE_FAILED')
                self.phase = 'ROLLED_BACK_ORIGINAL' if self.before else 'ROLLED_BACK_ABSENCE'
            self.adapter.record('ROLLBACK_DONE', self.snapshot())
            self.adapter.gates(True)
            return self.snapshot()
        except BaseException as error:
            return self._stop(error, True)
