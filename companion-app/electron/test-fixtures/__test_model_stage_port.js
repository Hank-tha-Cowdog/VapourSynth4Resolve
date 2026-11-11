// Test-only binding of the ACTUAL staging modules to each harness's filesystem.
// Async callback shapes use fixture-confined sync calls + microtasks, so the
// existing deterministic clocks never await host I/O/real child or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const IO_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'model-stage-io.js'), 'utf8');
const TX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'model-stage-transaction.js'), 'utf8');
function stagePort(files, crypto, env, options = {}) {
    const ports = { ...files,
        statfsSync() { return { bavail: 1n << 40n, bsize: 4096n }; } };
    for (const [name, sync] of [['open', 'openSync'], ['lstat', 'lstatSync'], ['fstat', 'fstatSync'],
        ['read', 'readSync'], ['write', 'writeSync'], ['fchmod', 'fchmodSync'], ['close', 'closeSync']]) {
        ports[name] = (...args) => {
            const callback = args.pop(); let value, error;
            try { value = ports[sync](...args); } catch (caught) { error = caught; }
            queueMicrotask(() => callback(error || null, value, ...(['read', 'write'].includes(name) ? [args[1]] : [])));
        };
    }
    const run = (source, bindings, filename) => {
        const module = { exports: {} };
        vm.runInNewContext(source, { module, exports: module.exports, Buffer,
            Date: options.Date || Date, process: { env, getuid: () => process.getuid() },
            require(name) {
                if (name === 'fs') return ports;
                if (name === 'path') return path;
                if (name === 'crypto') return crypto;
                if (Object.hasOwn(bindings, name)) return bindings[name];
                throw new Error('Unadmitted staging fixture dependency: ' + name);
            },
        }, { filename, timeout: 1000 });
        return module.exports;
    };
    const io = run(IO_SOURCE, {}, 'actual-model-stage-io-fixture.js');
    return run(TX_SOURCE, { './model-stage-io': io }, 'actual-model-stage-transaction-fixture.js');
}
module.exports = { stagePort };
