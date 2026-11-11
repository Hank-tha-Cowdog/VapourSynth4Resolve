'use strict';
const { ChildProcess } = require('node:child_process');

// Only a retained ChildProcess may be signalled. A detached group is used only
// while its leader is still owned and live; never look up a process by name.
async function terminateOwnedChild(child, { group = false, timeoutMs = 5000 } = {}) {
    if (!(child instanceof ChildProcess)) throw new TypeError('A retained ChildProcess is required');
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    let timer;
    const closed = new Promise((resolve, reject) => {
        child.once('close', resolve);
        timer = setTimeout(() => reject(new Error('Owned child did not close after termination')), timeoutMs);
    });
    try {
        try {
            if (group) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
        await closed;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { terminateOwnedChild };
