// Bounded direct-child lifecycle for companion probes.
// Callers supply spawn and separate provisional budgets; no tool discovery here.
// Named process defaults VSRES_<KIND>_TIMEOUT_MS and VSRES_<KIND>_MAX_OUTPUT_BYTES
// let existing GUI callers select legitimate longer budgets without source edits.
// Explicit options override environment; invalid values fail visibly, never clamp.
// A successful kill request is not closure. Unconfirmed stops quarantine only
// that probe kind, and a late close releases only its own child token.
const { MAX_STRING_LENGTH } = require('buffer').constants;
const stopped = new Map();
const MAX_TIMER_MS = 2 ** 31 - 1;

function runProbeProcess(spawn, bin, args, spawnOptions, defaults, options = {}) {
  const fail = (reason, error, extra = {}) => ({ ok: false, reason, error, noAutomaticReplay: true, ...extra });
  let timeoutMs, maxOutputBytes, closeTimeoutMs, signal;
  try {
    if (!options || typeof options !== 'object') throw new Error('probe options must be an object');
    const configured = (name, suffix, fallback) => {
      if (options[name] !== undefined) return options[name];
      const key = `VSRES_${defaults.kind.toUpperCase()}_${suffix}`;
      if (Object.hasOwn(process.env, key)) {
        const value = process.env[key];
        return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      }
      return fallback;
    };
    timeoutMs = configured('timeoutMs', 'TIMEOUT_MS', defaults.timeoutMs);
    maxOutputBytes = configured('maxOutputBytes', 'MAX_OUTPUT_BYTES', defaults.maxOutputBytes);
    closeTimeoutMs = options.closeTimeoutMs === undefined ? 5000 : options.closeTimeoutMs;
    signal = options.signal == null ? undefined : options.signal;
    for (const [name, value] of [['timeoutMs', timeoutMs], ['closeTimeoutMs', closeTimeoutMs]]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
        throw new Error(`${name} must be a positive integer <= ${MAX_TIMER_MS}; values are never clamped`);
      }
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_STRING_LENGTH) {
      throw new Error(`maxOutputBytes must be a positive integer <= ${MAX_STRING_LENGTH} (text representation limit); values are never clamped`);
    }
    if (signal !== undefined && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')) throw new Error('signal must be an AbortSignal');
  } catch (error) {
    return Promise.resolve(fail('probe-invalid-budget', error.message, { closed: true, notStarted: true }));
  }
  if (signal?.aborted) return Promise.resolve(fail('probe-cancelled', 'Probe cancelled before start', { closed: true, notStarted: true }));
  if (stopped.get(defaults.kind)?.size) {
    return Promise.resolve(fail('probe-stop-pending', `Previous ${defaults.kind} child close is unconfirmed; no new probe started`,
      { closed: false, cleanupUnconfirmed: true, notStarted: true }));
  }
  return new Promise(resolve => {
    let proc, settled = false, closed = false, exited = false;
    let timer = null, closeTimer = null, stop = null, stopError = null;
    let bytes = 0;
    function capture() {
      const blocks = [];
      const blockSize = Math.min(64 * 1024, maxOutputBytes);
      let last = null, used = blockSize, length = 0;
      return {
        append(buffer) {
          let offset = 0;
          while (offset < buffer.length) {
            if (used === blockSize) { last = Buffer.allocUnsafeSlow(blockSize); blocks.push(last); used = 0; }
            const count = Math.min(blockSize - used, buffer.length - offset);
            buffer.copy(last, used, offset, offset + count);
            used += count; offset += count; length += count;
          }
        },
        text() { return Buffer.concat(blocks, length).toString('utf8'); },
      };
    }
    let stdout = capture(), stderr = capture();
    function release() {
      const children = stopped.get(defaults.kind);
      if (children) {
        children.delete(proc);
        if (!children.size) stopped.delete(defaults.kind);
      }
    }
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      try { signal?.removeEventListener('abort', abort); }
      catch (error) {
        value = value.ok ? fail('probe-signal-error', `Abort listener cleanup failed: ${error.message}`, { closed: value.closed })
          : { ...value, signalCleanupError: error.message };
      }
      resolve(value);
    }
    function failure(isClosed) {
      return fail(stop.reason, stop.error + (isClosed ? '' : '; owned child close unconfirmed'), {
        closed: isClosed, cleanupUnconfirmed: !isClosed, stopError,
        timeoutMs, maxOutputBytes, receivedBytes: bytes,
      });
    }
    function stopOnce(reason, error) {
      if (closed || stop || settled) return;
      stop = { reason, error };
      stdout = null; stderr = null; // Do not retain partial/truncated JSON as a result.
      let children = stopped.get(defaults.kind);
      if (!children) stopped.set(defaults.kind, children = new Set());
      children.add(proc);
      // Never signal a child whose exit was already observed. Close may still
      // be pending because its pipes have not closed; that remains unconfirmed.
      if (!exited && proc.exitCode == null && proc.signalCode == null) {
        try {
          if (proc.kill('SIGKILL') === false) stopError = 'owned stop request was not accepted';
        } catch (error) { stopError = error.message; }
      }
      if (!settled) closeTimer = setTimeout(() => finish(failure(false)), closeTimeoutMs);
    }
    function abort() { stopOnce('probe-cancelled', 'Probe cancelled'); }
    function output(which, chunk) {
      if (closed || stop || settled) return; // Continue draining without retention after stop.
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > maxOutputBytes) {
        stopOnce('probe-output-limit', `${defaults.kind} output exceeded ${maxOutputBytes} bytes; choose an explicit larger maxOutputBytes for unusually large metadata`);
        return;
      }
      (which === 'stdout' ? stdout : stderr).append(buffer);
    }
    try { proc = spawn(bin, args, spawnOptions); }
    catch (error) {
      finish(fail('probe-spawn-failed', error.message, { closed: true, notStarted: true }));
      return;
    }
    proc.stdout?.on('data', chunk => output('stdout', chunk));
    proc.stderr?.on('data', chunk => output('stderr', chunk));
    const streamError = error => {
      if (!settled && !closed && !stop) stopOnce('probe-stream-error', error.message);
    };
    proc.stdout?.on('error', streamError);
    proc.stderr?.on('error', streamError);
    proc.on('exit', () => { exited = true; });
    proc.on('error', error => {
      if (settled || stop || closed) return;
      if (proc.pid == null) {
        stdout = null; stderr = null;
        finish(fail('probe-spawn-failed', error.message, { closed: true, notStarted: true }));
      } else stopOnce('probe-process-error', error.message);
    });
    proc.on('close', (code, exitSignal) => {
      if (closed) return;
      closed = true;
      release();
      if (settled) { stdout = null; stderr = null; return; }
      if (stop) finish(failure(true));
      else finish({ ok: true, closed: true, code, signal: exitSignal || null,
        stdout: stdout.text(), stderr: stderr.text() });
      stdout = null; stderr = null;
    });
    timer = setTimeout(() => stopOnce('probe-timeout',
      `${defaults.kind} timed out after ${timeoutMs} ms; choose an explicit larger timeoutMs for intentionally long probes`), timeoutMs);
    if (signal) {
      try {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); // Close the precheck/registration race.
      } catch (error) { stopOnce('probe-signal-error', `Abort listener registration failed: ${error.message}`); }
    }
  });
}

// Pure query: cached/trusted callers must not bypass an outstanding stop.
// No mutable token, process control or release operation is exposed.
function hasPendingProbeStop(kind) { return (stopped.get(kind)?.size || 0) > 0; }

module.exports = { runProbeProcess, hasPendingProbeStop };
