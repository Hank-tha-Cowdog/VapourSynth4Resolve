// In-memory Node callback filesystem port. No real descriptor or pathname is
// passed to any host fs method. Public callback shapes match Node20 fs APIs.
function createFakeStageFS(constants, options = {}) {
    const files = new Map();
    const descriptors = new Map();
    const calls = [], held = [], forbidden = [];
    let nextInode = 10, nextFd = 100, tick = 1000, seq = 0;
    const source = '/fixture/source.bin', destination = '/fixture/destination.bin', metadata = '/fixture/metadata.json';
    const error = (code, message) => Object.assign(new Error(message || code), { code });
    const put = (file, data, extra = {}) => {
        const node = { type: 'file', dev: 7, ino: nextInode++, nlink: 1,
            mode: 0o100640, mtimeMs: tick, ctimeMs: tick,
            data: Buffer.from(data), ...extra };
        files.set(file, node); return node;
    };
    const stats = node => {
        if (!node) throw error('ENOENT', 'missing inert fixture');
        const type = node.type;
        return { dev: node.dev, ino: node.ino, nlink: node.nlink,
            size: node.size === undefined ? node.data.length : node.size,
            mode: node.mode, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
            isFile: () => type === 'file', isDirectory: () => type === 'directory', isSymbolicLink: () => type === 'symlink' };
    };
    const h = { source, destination, metadata, files, descriptors, calls, held, forbidden, options, put,
        stopped: false, errors: [], closureStates: [], io: null,
        stats: file => stats(files.get(file)), bytes: file => Buffer.from(files.get(file).data),
        node: file => files.get(file),
        link(file, alias) { const node = files.get(file); node.nlink++; files.set(alias, node); },
        replace(file, data, extra = {}) { return put(file, data, extra); },
        closeCalls: file => calls.filter(call => call.name === 'close' && call.path === file),
        release(item, replacementError) {
            if (item.released) throw new Error('Fake callback already released');
            item.released = true;
            queueMicrotask(() => item.deliver(replacementError));
        },
    };
    put(source, options.sourceBytes || Buffer.from('inert stage copy bytes\n'));
    function request(name, detail, callback, perform) {
        const call = { seq: ++seq, name, ...detail };
        calls.push(call);
        const synchronous = options.throwSync?.(call, h);
        if (synchronous) throw synchronous;
        let values = [], failure;
        try {
            options.before?.(call, h);
            failure = options.error?.(call, h);
            if (!failure) values = perform();
            if (!failure) failure = options.afterError?.(call, h, values);
            options.after?.(call, h, values);
        } catch (caught) { failure = caught; }
        const item = { call, released: false,
            deliver(replacementError) {
                const outcome = replacementError === undefined ? failure : replacementError;
                if (!outcome && name === 'close') descriptors.delete(detail.fd);
                callback(outcome || null, ...values);
            } };
        if (options.hold?.(call, h)) held.push(item);
        else queueMicrotask(() => { item.released = true; item.deliver(); });
    }
    const fd = number => {
        const opened = descriptors.get(number);
        if (!opened) throw error('EBADF', 'unknown inert descriptor');
        return opened;
    };
    const methods = {
        constants,
        lstat(file, callback) { request('lstat', { path: file }, callback, () => [stats(files.get(file))]); },
        open(file, flags, mode, callback) {
            request('open', { path: file, flags, mode }, callback, () => {
                let node = files.get(file);
                if (node && (flags & constants.O_CREAT) && (flags & constants.O_EXCL)) throw error('EEXIST', 'inert destination exists');
                if (node?.type === 'symlink') {
                    if (flags & constants.O_NOFOLLOW) throw error('ELOOP', 'inert no-follow refusal');
                    node = files.get(node.target);
                }
                if (!node) {
                    if (!(flags & constants.O_CREAT)) throw error('ENOENT', 'inert source missing');
                    node = put(file, Buffer.alloc(0), { mode: 0o100000 | (mode & ~(options.umask || 0)) });
                }
                const number = nextFd++;
                descriptors.set(number, { node, path: file, flags });
                callFd(number);
                return [number];
                function callFd(number) { calls[calls.length - 1].acquiredFd = number; }
            });
        },
        fstat(number, callback) {
            const opened = descriptors.get(number);
            request('fstat', { fd: number, path: opened?.path }, callback, () => [stats(fd(number).node)]);
        },
        fchmod(number, mode, callback) {
            const opened = descriptors.get(number);
            request('fchmod', { fd: number, path: opened?.path, mode }, callback, () => {
                const node = fd(number).node; node.mode = 0o100000 | mode; node.ctimeMs = ++tick; return [];
            });
        },
        read(number, buffer, offset, length, position, callback) {
            const opened = descriptors.get(number);
            request('read', { fd: number, path: opened?.path, length, position }, callback, () => {
                const data = fd(number).node.data;
                let count = Math.min(length, options.maxRead || length, Math.max(0, data.length - position));
                if (options.readCount) count = options.readCount({ fd: number, path: opened?.path, length, position, count }, h);
                const applied = Math.min(length, Math.max(0, Math.floor(count)));
                data.copy(buffer, offset, position, position + applied);
                return [count, buffer];
            });
        },
        write(number, buffer, offset, length, position, callback) {
            const opened = descriptors.get(number);
            request('write', { fd: number, path: opened?.path, length, position }, callback, () => {
                const node = fd(number).node;
                let count = Math.min(length, options.maxWrite || length);
                if (options.writeCount) count = options.writeCount({ fd: number, path: opened?.path, length, position, count }, h);
                const applied = Math.min(length, Math.max(0, Math.floor(count)));
                if (position + applied > node.data.length) {
                    const grown = Buffer.alloc(position + applied); node.data.copy(grown); node.data = grown;
                }
                buffer.copy(node.data, position, offset, offset + applied);
                if (applied) { node.mtimeMs = ++tick; node.ctimeMs = tick; }
                return [count, buffer];
            });
        },
        close(number, callback) {
            const opened = descriptors.get(number);
            request('close', { fd: number, path: opened?.path }, callback, () => { fd(number); return []; });
        },
    };
    h.fs = new Proxy(methods, { get(target, key) {
        if (key in target) return target[key];
        return () => { forbidden.push(String(key)); throw new Error('Unadmitted fake FS operation: ' + String(key)); };
    } });
    return h;
}

module.exports = { createFakeStageFS };
