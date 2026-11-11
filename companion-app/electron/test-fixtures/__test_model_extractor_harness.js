// Reuse only the declared fixture section of the reviewed lifecycle test.
// Existing methods are not evaluated/registered in this helper.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const body = fs.readFileSync(path.join(__dirname, '..', '__test_model_extractor_lifecycle.js'), 'utf8');
const boundary = body.indexOf('\nasync function assertBlocked(h)');
if (boundary < 0 || body.indexOf("\ntest('", 0) < boundary) throw new Error('Unexpected lifecycle fixture source framing');
const modulePort = { exports: {} };
vm.runInNewContext(body.slice(0, boundary) + '\nmodule.exports = { harness };', {
    module: modulePort, exports: modulePort.exports, __dirname: path.join(__dirname, '..'),
    require(name) {
        if (name === './test-fixtures/__test_model_stage_port') return require('./__test_model_stage_port');
        if (name.startsWith('node:')) return require(name);
        throw new Error('Unadmitted extracted fixture dependency: ' + name);
    },
    Buffer, URL, AbortController, queueMicrotask, setTimeout, clearTimeout, process,
}, { filename: 'declared-model-extractor-fixture.js', timeout: 1000 });
module.exports = modulePort.exports;
