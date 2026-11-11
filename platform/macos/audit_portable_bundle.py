"""Audit Mach-O path policy without launching otool, payloads or repair tools.

Metadata checks are cooperative observations, not a sandbox or dyld closure.
@rpath/@executable_path remain explicitly unqualified, even on a policy pass.
"""
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import struct
import sys
import time

_scandir, _open, _pread = os.scandir, os.open, os.pread
THIN = {b'\xce\xfa\xed\xfe': ('<', 28), b'\xfe\xed\xfa\xce': ('>', 28),
        b'\xcf\xfa\xed\xfe': ('<', 32), b'\xfe\xed\xfa\xcf': ('>', 32)}
FAT = {b'\xca\xfe\xba\xbe': ('>', 20), b'\xbe\xba\xfe\xca': ('<', 20),
       b'\xca\xfe\xba\xbf': ('>', 32), b'\xbf\xba\xfe\xca': ('<', 32)}
COMMANDS = {0xc: ('load_dylib', 24), 0xd: ('id_dylib', 24),
            0x80000018: ('weak_dylib', 24), 0x8000001f: ('reexport_dylib', 24),
            0x80000023: ('upward_dylib', 24), 0x20: ('lazy_dylib', 24),
            0x10: ('prebound_dylib', 20), 0xe: ('load_dylinker', 12),
            0xf: ('id_dylinker', 12), 0x8000001c: ('rpath', 12),
            0x27: ('dyld_environment', 12)}


class AuditError(Exception):
    pass


class MissingTarget(AuditError):
    def __init__(self, message, tokens):
        super().__init__(message)
        depth, self.stays_internal = 0, True
        for part in tokens:
            if part in ('', '.'):
                continue
            if part == '..':
                if depth == 0:
                    self.stays_internal = False
                    break
                depth -= 1
            else:
                depth += 1


def require(value, message):
    if not value:
        raise AuditError(message)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Auditor:
    def __init__(self, contents, *, seconds=120, max_entries=150000,
                 max_read_bytes=128 * 1024**2):
        require(type(seconds) in (int, float) and 0 < seconds <= 3600, 'invalid audit time budget')
        require(type(max_entries) is int and max_entries > 0, 'invalid entry budget')
        require(type(max_read_bytes) is int and max_read_bytes > 0, 'invalid metadata read budget')
        self.root = Path(contents).absolute()
        require(self.root.resolve() == self.root and self.root.is_dir(), 'contents must be a canonical existing directory')
        self.deadline = time.monotonic() + seconds
        self.max_entries, self.max_read = max_entries, max_read_bytes
        self.rows, self.paths, self.violations, self.unqualified_text = {}, [], [], []
        self.read_bytes = self.images = self.output_bytes = 0

    def tick(self):
        require(time.monotonic() < self.deadline, 'audit deadline exhausted')

    def scan(self, directory=None, prefix='', depth=0):
        self.tick()
        directory = self.root if directory is None else directory
        require(depth <= 64, 'directory depth budget')
        with _scandir(directory) as entries:
            names = []
            for entry in entries:
                require(len(names) < 4096, 'directory entry budget')
                names.append(entry.name)
        for leaf in sorted(names):
            self.tick()
            require(leaf not in ('', '.', '..') and all(ord(c) >= 32 and ord(c) != 127 for c in leaf), 'unsafe namespace component')
            name = prefix + '/' + leaf if prefix else leaf
            require(len(name.encode()) <= 4096 and len(self.rows) < self.max_entries, 'namespace entry/length budget')
            info = (directory / leaf).lstat()
            kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else 'special'
            require(kind != 'special', 'special namespace entry: ' + name)
            self.rows[name] = {'kind': kind, 'identity': identity(info)}
            if kind == 'link':
                self.rows[name]['target'] = os.readlink(directory / leaf)
            elif kind == 'directory':
                self.scan(directory / leaf, name, depth + 1)

    def resolve(self, text):
        pending, resolved, seen, link_hops = text.split('/'), [], set(), 0
        for step in range(8192):
            self.tick()
            if not pending:
                return '/'.join(resolved)
            require(len(resolved) + len(pending) <= 8192, 'namespace resolution token budget')
            require(sum(len(part.encode()) for part in resolved + pending) <= 65536, 'namespace resolution byte budget')
            state = hashlib.sha256(json.dumps([resolved, pending], ensure_ascii=False, separators=(',', ':')).encode()).digest()
            require(state not in seen, 'namespace link cycle')
            seen.add(state)
            part = pending.pop(0)
            if part in ('', '.'):
                continue
            if part == '..':
                require(resolved, 'path escapes bundle')
                resolved.pop()
                continue
            resolved.append(part)
            name = '/'.join(resolved)
            if name not in self.rows:
                raise MissingTarget('target absent from bundle: ' + name, resolved + pending)
            row = self.rows[name]
            if row['kind'] == 'link':
                link_hops += 1
                require(link_hops <= 128, 'namespace link hop budget')
                target = row['target']
                require(target and not target.startswith('/') and len(target.encode()) <= 4096, 'external/invalid namespace link')
                resolved.pop()
                pending = target.split('/') + pending
            elif pending:
                require(row['kind'] == 'directory', 'path crosses non-directory')
        raise AuditError('namespace resolution step budget')

    def read_file(self, name, operation):
        self.tick()
        path, row = self.root / name, self.rows[name]
        fd = _open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(identity(os.fstat(fd)) == row['identity'], 'opened file changed: ' + name)
            size = row['identity'][4]
            def read(offset, amount):
                self.tick()
                require(0 <= offset <= size and 0 <= amount <= size - offset, 'read outside file')
                self.read_bytes += amount
                require(self.read_bytes <= self.max_read, 'metadata read budget')
                value = _pread(fd, amount, offset)
                require(len(value) == amount, 'short metadata read')
                return value
            result = operation(read, size)
            require(identity(os.fstat(fd)) == row['identity'], 'file changed during read: ' + name)
        finally:
            os.close(fd)
        require(identity(path.lstat()) == row['identity'], 'named file changed: ' + name)
        return result

    def record(self, image, command, value):
        require(value and len(value.encode()) <= 4096, 'invalid path command string')
        role = ('rpath_search_policy' if command == 'rpath' else 'identity_metadata' if command.startswith('id_')
                else 'dyld_environment_metadata' if command == 'dyld_environment' else 'load_dependency')
        row = {'image': image, 'command': command, 'role': role, 'path': value}
        if command == 'dyld_environment':
            row['classification'] = 'unqualified_dyld_environment'
            row['violation'] = True
        elif value.startswith('/'):
            normalized = posixpath.normpath(value)
            system = normalized in ('/System', '/usr/lib') or normalized.startswith(('/System/', '/usr/lib/'))
            row.update(classification='absolute_system' if system else 'absolute_non_system', violation=not system)
        elif value == '@loader_path' or value.startswith('@loader_path/'):
            row['classification'] = 'loader_relative'
            if role != 'identity_metadata':
                combined = '/'.join(image.split('/')[:-1]) + value[len('@loader_path'):]
                try:
                    target = self.resolve(combined)
                    expected = 'directory' if command == 'rpath' else 'file'
                    require(('directory' if target == '' else self.rows.get(target, {}).get('kind')) == expected, 'loader target has wrong type')
                    row['resolved_relative'] = target
                except MissingTarget as error:
                    row.update(classification='loader_relative_unresolved', reason=str(error),
                               violation=command != 'weak_dylib' or not error.stays_internal)
                except AuditError as error:
                    row.update(classification='loader_relative_unresolved', reason=str(error), violation=True)
        elif value == '@rpath' or value.startswith('@rpath/'):
            row['classification'] = 'rpath_context_unqualified'
        elif value == '@executable_path' or value.startswith('@executable_path/'):
            row['classification'] = 'executable_context_unqualified'
        else:
            row.update(classification='unqualified_relative_or_token', violation=True)
        self.output_bytes += len(json.dumps(row, ensure_ascii=True).encode()) * (2 if row.get('violation') else 1)
        require(self.output_bytes <= 16 * 1024**2, 'path report budget')
        self.paths.append(row)
        if row.get('violation'):
            self.violations.append(row)

    def text_violation(self, name, role):
        row = {'image': name, 'role': role, 'violation': True}
        self.output_bytes += len(json.dumps(row, ensure_ascii=True).encode())
        require(self.output_bytes <= 16 * 1024**2, 'path report budget')
        self.violations.append(row)

    def thin(self, read, offset, length, name):
        require(length >= 28, 'short Mach-O slice')
        magic = read(offset, 4)
        require(magic in THIN, 'fat member is not thin Mach-O')
        endian, header_size = THIN[magic]
        require(length >= header_size, 'short Mach-O header')
        fields = struct.unpack(endian + ('IiiIIIII' if header_size == 32 else 'IiiIIII'), read(offset, header_size))
        count, amount = fields[4:6]
        require(count <= 8192 and amount <= 2 * 1024**2 and header_size + amount <= length, 'load-command budget/range')
        data, cursor = read(offset + header_size, amount), 0
        for _ in range(count):
            self.tick()
            require(cursor + 8 <= len(data), 'truncated load command')
            command, size = struct.unpack_from(endian + 'II', data, cursor)
            require(size >= 8 and size % (8 if header_size == 32 else 4) == 0 and cursor + size <= len(data), 'invalid load command size')
            if command in COMMANDS:
                label, minimum = COMMANDS[command]
                require(size >= minimum, 'short path command')
                block = data[cursor:cursor + size]
                position = struct.unpack_from(endian + 'I', block, 8)[0]
                require(minimum <= position < size, 'invalid path string offset')
                end = block.find(b'\0', position)
                require(position <= end and end - position <= 4096, 'unterminated/oversized path string')
                self.record(name, label, block[position:end].decode('utf-8', errors='strict'))
            cursor += size
        require(cursor == len(data), 'load-command count/size mismatch')

    def macho(self, read, size, name):
        if size < 4:
            return
        magic = read(0, 4)
        if magic in THIN:
            self.thin(read, 0, size, name)
            self.images += 1
        elif magic in FAT:
            endian, stride = FAT[magic]
            require(size >= 8, 'short fat header')
            count = struct.unpack(endian + 'I', read(4, 4))[0]
            require(0 < count <= 16 and 8 + count * stride <= size, 'fat table budget/range')
            table, ranges = read(8, count * stride), []
            for index in range(count):
                entry = struct.unpack_from(endian + ('iiQQII' if stride == 32 else 'iiIII'), table, index * stride)
                start, amount, alignment = entry[2:5]
                require(alignment <= 30 and start % (1 << alignment) == 0 and start >= 8 + count * stride
                        and 0 < amount <= size - start, 'fat member range/alignment')
                require(all(start + amount <= a or b <= start for a, b in ranges), 'overlapping fat members')
                ranges.append((start, start + amount))
                self.thin(read, start, amount, name)
            self.images += 1

    def text_note(self, logical_name, line_number, classification):
        row = {'image': logical_name, 'line': line_number, 'classification': classification}
        self.output_bytes += len(json.dumps(row, ensure_ascii=True).encode())
        require(self.output_bytes <= 16 * 1024**2 and len(self.unqualified_text) < 4096, 'text report budget')
        self.unqualified_text.append(row)

    def text_name(self, logical_name, target):
        if logical_name.endswith('.pth'):
            require(self.rows.get(target, {}).get('kind') == 'file', '.pth alias target is not ordinary')
            def pth(read, size):
                require(size <= 1024**2, '.pth metadata budget')
                return read(0, size).decode('utf-8', errors='strict')
            text = self.read_file(target, pth)
            if re.search(r'/(?:opt/homebrew|usr/local|Users)(?:/|$)', text, re.MULTILINE):
                self.text_violation(logical_name, 'pth_external_path')
            for line_number, line in enumerate(text.splitlines(), 1):
                value = line.strip()
                if not value or value.startswith('#'):
                    continue
                if value.startswith(('import ', 'import\t')):
                    self.text_note(logical_name, line_number, 'executable_pth_unqualified')
                elif value.startswith('/'):
                    self.text_violation(logical_name, 'pth_external_path')
                else:
                    require(len(value.encode()) <= 4096, '.pth path byte budget')
                    try:
                        self.resolve('/'.join(logical_name.split('/')[:-1]) + '/' + value)
                    except MissingTarget as error:
                        if error.stays_internal:
                            self.text_note(logical_name, line_number, 'optional_internal_pth_target_absent')
                        else:
                            self.text_violation(logical_name, 'pth_external_path')
                    except AuditError:
                        self.text_violation(logical_name, 'pth_external_path')
        if Path(logical_name).name in ('sitecustomize.py', 'usercustomize.py'):
            self.text_violation(logical_name, 'python_customization_hook')

    def run(self):
        self.scan()
        for name, row in self.rows.items():
            self.tick()
            if row['kind'] == 'link':
                target = self.resolve(name)
                self.text_name(name, target)
            elif row['kind'] == 'file':
                self.read_file(name, lambda read, size: self.macho(read, size, name))
                self.text_name(name, name)
        require(self.images > 0, 'no Mach-O image found; no empty audit pass')
        return {'status': 'PATH_POLICY_FAIL' if self.violations else 'PATH_POLICY_PASS_NOT_RUNTIME_QUALIFIED',
                'native_images': self.images, 'entries': len(self.rows), 'metadata_read_bytes': self.read_bytes,
                'paths': self.paths, 'violations': self.violations, 'unqualified_text': self.unqualified_text,
                'runtime_closure_qualified': False, 'archives_inspected': False}


def main(argv):
    require(len(argv) == 1, 'usage: audit_portable_bundle.py <canonical-bundle-contents>')
    report = Auditor(argv[0]).run()
    text = json.dumps(report, sort_keys=True)
    require(len(text.encode()) <= 16 * 1024**2, 'complete report budget')
    print(text, flush=True)
    return 1 if report['violations'] else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (AuditError, OSError, UnicodeError, struct.error) as error:
        print('AUDIT FAIL: ' + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
