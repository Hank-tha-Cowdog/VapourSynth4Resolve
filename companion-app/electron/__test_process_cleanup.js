'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { terminateOwnedChild } = require('../../tests/owned_child_process');

test('test cleanup refuses numeric process selectors', async () => {
    await assert.rejects(terminateOwnedChild(process.pid), /retained ChildProcess/);
});

test('owned group cleanup reaps its child and preserves another same-command child', async () => {
    const launch = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' });
    const own = launch();
    const other = launch();
    try {
        await terminateOwnedChild(own, { group: true });
        assert.equal(own.signalCode, 'SIGKILL');
        assert.equal(other.exitCode, null);
        assert.equal(other.signalCode, null);
        assert.doesNotThrow(() => process.kill(other.pid, 0));
    } finally {
        await terminateOwnedChild(own, { group: true });
        await terminateOwnedChild(other, { group: true });
    }
});
