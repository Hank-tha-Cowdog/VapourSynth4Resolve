// Model staging copy/metadata IO. Callers own canonical-directory admission,
// transaction state, time budgets and any recovery policy. No cleanup/retry or
// filesystem fallback is performed here. Node 20.18.3 callback APIs only.
const CHUNK_BYTES = 64 * 1024;
const METADATA_BYTES = 64 * 1024;

function createStageIO({ fs, crypto, onFailure, onClosure, isStopped = () => false }) {
    const owned = new Set();
    const pending = new Set();
    const operations = new Set();
    const closed = () => owned.size === 0 && pending.size === 0 && operations.size === 0;
    const observeClosure = () => { try { onClosure?.(); } catch { /* observer teardown */ } };
    const errorObject = value => value && typeof value === 'object' && typeof value.message === 'string'
        ? value : new Error(String(value));
    const fail = (operation, error) => {
        if (!operation.error) operation.error = errorObject(error);
        if (!operation.notified) {
            operation.notified = true;
            try { onFailure?.(operation.error); } catch { /* observer teardown */ }
        }
        return operation.error;
    };
    const check = operation => {
        if (operation.error) throw operation.error;
        try { if (isStopped()) throw new Error('Model stage IO stopped'); }
        catch (error) { throw fail(operation, error); }
    };
    const validFile = file => {
        if (typeof file !== 'string' || !file.length) throw new Error('Model stage path must be a nonempty string');
    };
    const validMode = mode => {
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Model stage mode must contain only permission bits');
        return mode;
    };
    const regular = info => info && typeof info.isFile === 'function' && info.isFile() && info.nlink === 1;
    const snapshot = info => {
        if (!regular(info) || !Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino) ||
            !Number.isSafeInteger(info.mode) || info.mode < 0 || !Number.isSafeInteger(info.size) || info.size < 0 ||
            !Number.isFinite(info.mtimeMs) || !Number.isFinite(info.ctimeMs)) {
            throw new Error('Model stage file must be ordinary, single-link and have a supported exact size/metadata');
        }
        return { dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
            mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    };
    const matches = (info, expected) => regular(info) &&
        ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => info[key] === expected[key]);
    const assertMatch = (info, expected, label) => {
        if (!matches(info, expected)) throw new Error(`${label} changed or is not an ordinary single-link file`);
    };

    // beforeSettle runs before pending ownership is released or an observer is
    // called. In particular, every fd delivered by open is registered first.
    function invoke(operation, name, args, beforeSettle, cleanup = false) {
        if (!cleanup) check(operation);
        const token = {};
        pending.add(token);
        return new Promise((resolve, reject) => {
            let returned = false;
            const done = (error, ...values) => {
                if (returned) return;
                returned = true;
                let result = values;
                try { if (beforeSettle) result = beforeSettle(error, values); }
                catch (hookError) { if (!error) error = hookError; }
                if (error) fail(operation, error);
                pending.delete(token);
                observeClosure();
                if (error) reject(operation.error);
                else resolve(result);
            };
            try { fs[name](...args, done); }
            catch (error) { done(error); }
        });
    }
    function openOwned(operation, file, flags, mode) {
        return invoke(operation, 'open', [file, flags, mode], (error, values) => {
            const fd = values[0];
            if (!Number.isInteger(fd) || fd < 0) {
                if (!error) throw new Error('Model stage open returned no owned descriptor');
                return undefined;
            }
            const resource = { fd, closeRequested: false, closePromise: null };
            owned.add(resource);
            operation.resources.push(resource);
            return resource;
        });
    }
    function closeOwned(operation, resource) {
        if (resource.closeRequested) return resource.closePromise;
        resource.closeRequested = true;
        // A failed close is deliberately never retried using this numeric fd.
        // Its resource remains owned/unknown even after the callback returns.
        resource.closePromise = invoke(operation, 'close', [resource.fd], error => {
            if (!error) owned.delete(resource);
        }, true);
        return resource.closePromise;
    }
    async function operation(work, afterClose) {
        const state = { resources: [], error: null, notified: false };
        operations.add(state);
        let value;
        try {
            try { value = await work(state); }
            catch (error) { fail(state, error); }
            finally {
                // Both descriptors get one close request even when one fails.
                // A callback that never returns keeps this await and ownership.
                await Promise.allSettled(state.resources.map(resource => closeOwned(state, resource)));
            }
            if (state.error) throw state.error;
            return await afterClose(state, value);
        } catch (error) { throw fail(state, error); }
        finally { operations.delete(state); observeClosure(); }
    }
    const lstat = async (state, file) => (await invoke(state, 'lstat', [file]))[0];
    const fstat = async (state, resource) => (await invoke(state, 'fstat', [resource.fd]))[0];
    async function read(state, resource, buffer, offset, length, position) {
        const [count] = await invoke(state, 'read', [resource.fd, buffer, offset, length, position]);
        if (!Number.isSafeInteger(count) || count < 0 || count > length) throw new Error('Model stage read returned an invalid byte count');
        return count;
    }
    // No new syscall is dispatched after stop. An already admitted callback
    // may still complete; it remains pending/owned through exact fd closure.
    async function writeAll(state, resource, buffer, length, position) {
        let used = 0;
        while (used < length) {
            const [count] = await invoke(state, 'write', [resource.fd, buffer, used, length - used, position + used]);
            if (!Number.isSafeInteger(count) || count <= 0 || count > length - used) throw new Error('Model stage write did not make valid progress');
            used += count;
        }
    }
    async function exactEOF(state, resource, size) {
        if (await read(state, resource, Buffer.alloc(1), 0, 1, size)) throw new Error('Model stage file exceeded its pinned size');
    }
    async function readDigest(state, resource, size) {
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.alloc(CHUNK_BYTES);
        let used = 0;
        while (used < size) {
            const count = await read(state, resource, buffer, 0, Math.min(buffer.length, size - used), used);
            if (!count) throw new Error('Model stage file ended before its pinned size');
            hash.update(buffer.subarray(0, count)); used += count;
        }
        await exactEOF(state, resource, size);
        return hash.digest('hex');
    }
    async function createdFile(state, file, mode, readback) {
        const flags = (readback ? fs.constants.O_RDWR : fs.constants.O_WRONLY) |
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
        const resource = await openOwned(state, file, flags, mode);
        const info = await fstat(state, resource);
        if (!regular(info) || info.size !== 0) throw new Error('Model stage destination is not a new ordinary single-link file');
        // Creation honours umask; apply the caller's explicit safe permission
        // bits to this owned fd rather than making a pathname chmod request.
        await invoke(state, 'fchmod', [resource.fd, mode]);
        return { resource, identity: { dev: info.dev, ino: info.ino } };
    }
    function finalDestination(info, identity, size, mode) {
        if (!regular(info) || info.dev !== identity.dev || info.ino !== identity.ino ||
            info.size !== size || (info.mode & 0o777) !== mode) {
            throw new Error('Model stage destination identity, size or mode changed');
        }
        return snapshot(info);
    }

    function copyRegularFile(source, destination, expectedStats, { mode = 0o600 } = {}) {
        return operation(async state => {
            validFile(source); validFile(destination); validMode(mode);
            const expected = snapshot(expectedStats);
            assertMatch(await lstat(state, source), expected, 'Model stage source path');
            const input = await openOwned(state, source,
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
            assertMatch(await fstat(state, input), expected, 'Model stage source descriptor');
            const output = await createdFile(state, destination, mode, true);
            const hash = crypto.createHash('sha256');
            const buffer = Buffer.alloc(CHUNK_BYTES);
            let used = 0;
            while (used < expected.size) {
                const count = await read(state, input, buffer, 0, Math.min(buffer.length, expected.size - used), used);
                if (!count) throw new Error('Model stage source ended before its pinned size');
                hash.update(buffer.subarray(0, count));
                await writeAll(state, output.resource, buffer, count, used);
                used += count;
            }
            await exactEOF(state, input, expected.size);
            const digest = hash.digest('hex');
            const written = await fstat(state, output.resource);
            const destinationSnapshot = finalDestination(written, output.identity, expected.size, mode);
            if (await readDigest(state, output.resource, expected.size) !== digest) throw new Error('Model stage destination readback checksum mismatch');
            assertMatch(await fstat(state, output.resource), destinationSnapshot, 'Model stage destination descriptor');
            assertMatch(await fstat(state, input), expected, 'Model stage source descriptor');
            return { expected, destinationSnapshot, bytes: used, digest };
        }, async (state, value) => {
            assertMatch(await lstat(state, source), value.expected, 'Model stage source path');
            const identity = await lstat(state, destination);
            assertMatch(identity, value.destinationSnapshot, 'Model stage destination path');
            return { identity, bytes: value.bytes, digest: value.digest };
        });
    }

    function writeBytesExclusive(file, buffer, mode = 0o600) {
        return operation(async state => {
            validFile(file); validMode(mode);
            if (!Buffer.isBuffer(buffer) || buffer.length > METADATA_BYTES) throw new Error('Model stage metadata must be a Buffer of at most 64 KiB');
            const data = Buffer.from(buffer);
            const output = await createdFile(state, file, mode, false);
            await writeAll(state, output.resource, data, data.length, 0);
            return finalDestination(await fstat(state, output.resource), output.identity, data.length, mode);
        }, async (state, expected) => {
            const identity = await lstat(state, file);
            assertMatch(identity, expected, 'Model stage metadata path');
            return identity;
        });
    }

    function readBytes(file, maxBytes = METADATA_BYTES, expectedStats) {
        return operation(async state => {
            validFile(file);
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > METADATA_BYTES) {
                throw new Error('Model stage metadata read limit must be an integer from 0 to 64 KiB');
            }
            const initial = await lstat(state, file);
            const expected = snapshot(expectedStats === undefined ? initial : expectedStats);
            assertMatch(initial, expected, 'Model stage metadata path');
            if (expected.size > maxBytes) throw new Error('Model stage metadata exceeds its read limit');
            const input = await openOwned(state, file,
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
            assertMatch(await fstat(state, input), expected, 'Model stage metadata descriptor');
            const data = Buffer.alloc(expected.size);
            let used = 0;
            while (used < data.length) {
                const count = await read(state, input, data, used, Math.min(CHUNK_BYTES, data.length - used), used);
                if (!count) throw new Error('Model stage metadata ended before its pinned size');
                used += count;
            }
            await exactEOF(state, input, expected.size);
            assertMatch(await fstat(state, input), expected, 'Model stage metadata descriptor');
            return { data, expected };
        }, async (state, value) => {
            const identity = await lstat(state, file);
            assertMatch(identity, value.expected, 'Model stage metadata path');
            return { data: value.data, identity };
        });
    }

    return Object.freeze({ closed, copyRegularFile, writeBytesExclusive, readBytes });
}

module.exports = { createStageIO };
