// Per-model staged extraction. Namespace changes require the original live
// process lease and closed owned resources; stored journals grant no authority.
// This is a cooperative two-rename transaction, not atomic swap/durability or
// native containment. Retained data is never recursively garbage-collected.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStageIO } = require('./model-stage-io');
const MAX_RECORD_BYTES = 64 * 1024;
const METADATA_ALLOWANCE = 4 * MAX_RECORD_BYTES;
const DEFAULT_HEADROOM_BYTES = 1024 * 1024 * 1024;
const PHASES = new Set(['claiming', 'preparing', 'prepared', 'extracting', 'closed', 'validated',
  'backup-intent', 'previous-moved', 'install-intent', 'installed', 'restoring', 'restored', 'failed-retained', 'committed']);
const FIXED_CONTROLS = new Set(['download.7z', 'download.partial', 'extracted.json', '.extraction-unverified.json']);

class HeldError extends Error { constructor(message) { super(message); this.held = true; } }
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer; values are never clamped`);
  return value;
}
function headroomPolicy(value, env = process.env) {
  if (value === undefined && Object.hasOwn(env, 'VSRES_MODEL_STAGE_HEADROOM_BYTES')) {
    const text = env.VSRES_MODEL_STAGE_HEADROOM_BYTES;
    value = typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : NaN;
  }
  return integer(value === undefined ? DEFAULT_HEADROOM_BYTES : value, 'stageHeadroomBytes');
}
function locations(root, id) {
  if (typeof id !== 'string' || !/^[\w][\w.-]*$/.test(id)) throw new Error('invalid model transaction id');
  root = path.resolve(root);
  return { root, live: path.join(root, id), anchor: path.join(root, `.vsres-${id}.transaction.json`),
    custody: path.join(root, `.vsres-custody-${id}`) };
}
function maybeStat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function ordinaryDirectory(file) {
  const info = fs.lstatSync(file);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HeldError(`not an ordinary directory: ${file}`);
  return info;
}
function regular(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1) throw new HeldError(`not an ordinary unshared file: ${file}`);
  return info;
}
function sameIdentity(file, expected) {
  if (!expected) return false;
  try { const actual = fs.lstatSync(file); return actual.dev === expected.dev && actual.ino === expected.ino; }
  catch { return false; }
}
function stableFile(file, expected) {
  try {
    const actual = regular(file);
    return sameIdentity(file, expected) && ['size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => actual[key] === expected[key]);
  } catch { return false; }
}
function identity(info) { return info ? { dev: info.dev, ino: info.ino } : null; }
function kind(info) { return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : 'special'; }
function snapshot(info) { return { dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
  mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, nlink: info.nlink, kind: kind(info) }; }
function equalSnapshot(info, expected, movedRoot = false) {
  const actual = snapshot(info);
  return Object.keys(expected).every(key => movedRoot && ['mtimeMs', 'ctimeMs'].includes(key) ? true : actual[key] === expected[key]);
}
function pending(root, id) {
  const names = locations(root, id);
  try { return { present: !!maybeStat(names.anchor), path: names.anchor }; }
  catch (error) { return { present: true, path: names.anchor, error: error.message }; }
}
function readSmallSync(file) {
  let fd;
  try {
    const expected = regular(file);
    if (typeof process.getuid !== 'function' || expected.uid !== process.getuid() || (expected.mode & 0o777) !== 0o600) throw new HeldError('private metadata ownership/mode is unavailable');
    if (expected.size > MAX_RECORD_BYTES) throw new HeldError('metadata exceeds 64KiB');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new HeldError('metadata changed before read');
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1); let used = 0;
    while (used < buffer.length) { const count = fs.readSync(fd, buffer, used, buffer.length - used, null); if (!count) break; used += count; }
    if (used > MAX_RECORD_BYTES || !stableFile(file, expected)) throw new HeldError('metadata changed or exceeded its bound');
    return { data: JSON.parse(buffer.subarray(0, used).toString('utf8')), identity: expected };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validRootRecord(data, id, info) {
  return data && Object.keys(data).sort().join(',') === 'id,identity,schemaVersion' && data.schemaVersion === 1 && data.id === id &&
    data.identity?.dev === info.dev && data.identity?.ino === info.ino;
}
function retainedStorage(root, id, isPending = false) {
  const names = locations(root, id);
  try {
    const info = maybeStat(names.custody);
    if (!info) return isPending ? { status: 'pending', path: names.custody, bytes: null,
      note: 'A model transaction is held; its reserved data-custody folder may not yet contain copied files.' } : undefined;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HeldError('custody root is not ordinary');
    if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new HeldError('custody root privacy/ownership is unavailable');
    const marker = readSmallSync(path.join(names.custody, '.custody.json'));
    if (!validRootRecord(marker.data, id, info)) throw new HeldError('custody root metadata does not match this location');
    return { status: isPending ? 'pending' : 'retained', path: names.custody, bytes: null,
      note: 'Previous installs, archive copies and candidate files may be retained here. Their total size is not measured; this is data custody, not a guaranteed runnable rollback. Current model removal does not include this folder.' };
  } catch (error) {
    return { status: 'held', path: names.custody, bytes: null,
      note: `This retained-storage location could not be verified and was left untouched: ${error.message}` };
  }
}
function inspect(root, id, entry) {
  const names = locations(root, id);
  try {
    if (!maybeStat(names.anchor)) return { ok: true, pending: false, canRestore: false, retainedStorage: retainedStorage(root, id) };
    const { data } = readSmallSync(names.anchor);
    if (!data || Object.keys(data).sort().join(',') !== 'id,original,phase,schemaVersion,sha256,space,stage,token,transaction,version' || data.schemaVersion !== 1 || data.id !== id || data.version !== entry.version || data.sha256 !== entry.sha256 ||
        !/^[a-f0-9]{32}$/.test(data.token) || !PHASES.has(data.phase)) throw new HeldError('unrecognized transaction journal');
    const transaction = path.join(names.custody, data.token);
    return { ok: true, pending: true, canRestore: false, recordedPhase: data.phase,
      journal: names.anchor, transaction, previous: path.join(transaction, 'previous'), candidate: path.join(transaction, 'payload'),
      archiveCopy: path.join(transaction, 'archive.7z'), retainedStorage: retainedStorage(root, id, true),
      recovery: 'Stored metadata is inspection only. The original process recovery lease and owned-resource closure are unavailable; files remain held. No automatic restart repair was attempted.' };
  } catch (error) { return { ok: false, pending: true, canRestore: false, error: error.message,
    journal: names.anchor, retainedStorage: retainedStorage(root, id, true), recovery: 'Unknown journal data was retained. Inspection grants no mutation or native-child closure authority.' }; }
}

class ModelStageTransaction {
  constructor({ root, id, entry, originalIdentity, archiveIdentity, hooks, stageHeadroomBytes, maxEntries = 100000, maxDepth = 128, maxManifestBytes = 64 * 1024 * 1024 }) {
    this.names = locations(root, id); this.id = id; this.entry = entry; this.originalIdentity = originalIdentity;
    this.originalArchiveIdentity = archiveIdentity; this.hooks = hooks;
    this.headroomBytes = headroomPolicy(stageHeadroomBytes);
    this.limits = { maxEntries: integer(maxEntries, 'stageMaxEntries'), maxDepth: integer(maxDepth, 'stageMaxDepth'),
      maxManifestBytes: integer(maxManifestBytes, 'stageMaxManifestBytes') };
    if (!maxEntries || !maxDepth || !maxManifestBytes) throw new Error('stage traversal limits must be positive');
    this.directoryResources = new Set();
    this.token = crypto.randomBytes(16).toString('hex'); this.phase = 'claiming'; this.released = false; this.releaseUncertain = false;
    this.ownerUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (this.ownerUid === null) throw new Error('staged model transactions require the supported POSIX ownership API');
    this.ioGroups = []; this.io = this.newIO(false); this.inRecovery = false; this.autoRestoreAttempted = false;
    this.transaction = path.join(this.names.custody, this.token); this.stage = path.join(this.transaction, 'payload');
    this.archive = path.join(this.transaction, 'archive.7z'); this.previous = path.join(this.transaction, 'previous');
    this.history = path.join(this.transaction, 'journal.json'); this.sourceManifest = null;
  }
  newIO(recovery) {
    let failed = false;
    const stopToken = this.hooks.stopToken?.();
    if (recovery) this.recoveryStopToken = stopToken;
    const io = createStageIO({ fs, crypto,
      onFailure: error => { failed = true; try { this.hooks.onFailure(error); } catch { /* observer teardown */ } },
      onClosure: () => { try { this.hooks.onClosure(); } catch { /* observer teardown */ } },
      isStopped: () => failed || this.hooks.returnedUnknown() || (recovery && this.hooks.stopToken && this.hooks.stopToken() !== stopToken) || (!recovery && this.hooks.isStopped()) });
    this.ioGroups.push(io); return io;
  }
  resourcesClosed() { return this.directoryResources.size === 0 && this.ioGroups.every(io => io.closed()); }
  traversal() { return { entries: 1, bytes: 0n }; }
  account(state, relative, info) {
    this.hooks.checkDeadline?.();
    if ((!this.inRecovery && this.hooks.isStopped()) || (this.inRecovery && this.hooks.stopToken && this.hooks.stopToken() !== this.recoveryStopToken)) throw new HeldError('staged work stopped at a traversal checkpoint');
    const depth = relative ? relative.split(path.sep).length : 0;
    if (depth > this.limits.maxDepth) throw new Error(`stage traversal depth exceeds ${this.limits.maxDepth}; choose an explicit larger stageMaxDepth`);
    state.bytes += BigInt(Buffer.byteLength(JSON.stringify({ relative, metadata: snapshot(info) })));
    if (state.bytes > BigInt(this.limits.maxManifestBytes)) throw new Error(`stage manifest metadata exceeds ${this.limits.maxManifestBytes} bytes; choose an explicit larger stageMaxManifestBytes`);
  }
  entries(file, state, relative = '') {
    const directory = fs.opendirSync(file, { bufferSize: 32 }); this.directoryResources.add(directory);
    const result = []; let firstError;
    try {
      while (true) {
        this.hooks.checkDeadline?.();
        if ((!this.inRecovery && this.hooks.isStopped()) || (this.inRecovery && this.hooks.stopToken && this.hooks.stopToken() !== this.recoveryStopToken)) throw new HeldError('staged work stopped at a traversal checkpoint');
        const entry = directory.readSync(); if (!entry) break;
        if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes(path.sep)) throw new HeldError('unsupported directory entry name was retained');
        if (state.entries >= this.limits.maxEntries) throw new Error(`stage traversal exceeds ${this.limits.maxEntries} entries; choose an explicit larger stageMaxEntries`);
        state.entries++;
        const depth = (relative ? relative.split(path.sep).length : 0) + 1;
        if (depth > this.limits.maxDepth) throw new Error(`stage traversal depth exceeds ${this.limits.maxDepth}; choose an explicit larger stageMaxDepth`);
        result.push(entry);
      }
    } catch (error) { firstError = error; }
    finally {
      try { directory.closeSync(); this.directoryResources.delete(directory); }
      catch (error) { firstError = firstError || error; try { this.hooks.onFailure(error); } catch {} }
      try { this.hooks.onClosure(); } catch {}
    }
    if (firstError) throw firstError;
    return result;
  }
  allClosed() { return this.resourcesClosed() && this.hooks.knownClosed(); }
  assertLease(prospectiveRecovery = false) {
    if (!prospectiveRecovery) this.hooks.checkDeadline?.();
    const recoveryStopped = this.inRecovery && this.hooks.stopToken && this.hooks.stopToken() !== this.recoveryStopToken;
    if (this.released || this.releaseUncertain || !this.hooks.current() || (!prospectiveRecovery && (this.hooks.returnedUnknown() || recoveryStopped || (!this.inRecovery && this.hooks.isStopped())))) throw new HeldError('transaction mutation lease is unavailable');
    if (!this.anchorIdentity || !stableFile(this.names.anchor, this.anchorIdentity)) throw new HeldError('transaction journal was replaced or changed; it was retained');
    if (!sameIdentity(this.names.root, this.rootIdentity) || !sameIdentity(this.names.custody, this.custodyIdentity) ||
        !sameIdentity(this.transaction, this.transactionIdentity)) throw new HeldError('transaction directory ownership changed; all paths were retained');
    if (this.rootMarkerIdentity && !stableFile(path.join(this.names.custody, '.custody.json'), this.rootMarkerIdentity)) throw new HeldError('custody metadata changed; it was retained');
  }
  async writeExclusive(file, value) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('transaction metadata exceeds 64KiB');
    return this.io.writeBytesExclusive(file, bytes, 0o600);
  }
  journal(phase) { return { schemaVersion: 1, id: this.id, version: this.entry.version, sha256: this.entry.sha256,
    token: this.token, phase, original: identity(this.originalIdentity), transaction: identity(this.transactionIdentity),
    stage: identity(this.stageIdentity), space: this.space || null }; }
  async phaseTo(phase) {
    this.assertLease();
    const temp = path.join(this.transaction, `.journal-${crypto.randomBytes(12).toString('hex')}.tmp`);
    const written = await this.writeExclusive(temp, this.journal(phase)); this.assertLease();
    if (!stableFile(temp, written.identity || written)) throw new HeldError('journal temporary was replaced; replacement retained');
    const before = this.anchorIdentity;
    try { fs.renameSync(temp, this.names.anchor); }
    catch (error) {
      if (sameIdentity(this.names.anchor, written.identity || written) && !maybeStat(temp)) {
        this.anchorIdentity = regular(this.names.anchor); this.phase = phase;
      } else if (!stableFile(this.names.anchor, before)) this.releaseUncertain = true;
      throw error;
    }
    if (!sameIdentity(this.names.anchor, written.identity || written)) { this.releaseUncertain = true; throw new HeldError('journal publication ownership is uncertain'); }
    this.anchorIdentity = regular(this.names.anchor); this.phase = phase;
  }
  async claim() {
    this.rootIdentity = ordinaryDirectory(this.names.root);
    const written = await this.writeExclusive(this.names.anchor, this.journal('claiming'));
    this.anchorIdentity = regular(this.names.anchor);
    if (!sameIdentity(this.names.anchor, written.identity || written)) throw new HeldError('journal claim changed');
    let custody = maybeStat(this.names.custody);
    if (!custody) {
      fs.mkdirSync(this.names.custody, { mode: 0o700 }); custody = ordinaryDirectory(this.names.custody);
      if (custody.uid !== this.ownerUid || (custody.mode & 0o777) !== 0o700) throw new HeldError('private custody root ownership/mode is unavailable');
      const rootWritten = await this.writeExclusive(path.join(this.names.custody, '.custody.json'),
        { schemaVersion: 1, id: this.id, identity: identity(custody) });
      this.rootMarkerIdentity = rootWritten.identity || rootWritten;
    } else {
      if (!custody.isDirectory() || custody.isSymbolicLink() || custody.uid !== this.ownerUid || (custody.mode & 0o777) !== 0o700) throw new HeldError('existing custody root is unsupported and was retained');
      const rootRead = await this.io.readBytes(path.join(this.names.custody, '.custody.json'), MAX_RECORD_BYTES);
      if (rootRead.identity.uid !== this.ownerUid || (rootRead.identity.mode & 0o777) !== 0o600 || !validRootRecord(JSON.parse(rootRead.data.toString('utf8')), this.id, custody)) throw new HeldError('unrecognized custody root metadata');
      this.rootMarkerIdentity = rootRead.identity;
    }
    this.custodyIdentity = custody;
    if (custody.dev !== this.rootIdentity.dev || this.originalIdentity.dev !== this.rootIdentity.dev) throw new Error('staged publication requires one destination filesystem; old data was not moved');
    fs.mkdirSync(this.transaction, { mode: 0o700 }); this.transactionIdentity = ordinaryDirectory(this.transaction);
    fs.mkdirSync(this.stage, { mode: 0o700 }); this.stageIdentity = ordinaryDirectory(this.stage);
    this.assertLease(); await this.phaseTo('preparing');
  }
  ordinary(info, file) {
    if ((!info.isDirectory() && !info.isFile()) || info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || (info.mode & 0o7000)) {
      throw new Error(`unsupported linked/special payload entry retained in the previous tree: ${file}`);
    }
    if (info.isFile()) integer(info.size, 'payload size');
  }
  async metadataMatches(file) {
    const read = await this.io.readBytes(file, MAX_RECORD_BYTES);
    const value = JSON.parse(read.data.toString('utf8'));
    return value && Object.keys(value).sort().join(',') === 'extractedAt,id,sha256,version' && value.id === this.id &&
      value.version === this.entry.version && value.sha256 === this.entry.sha256 && Number.isSafeInteger(value.extractedAt) && value.extractedAt >= 0;
  }
  async collectSource() {
    this.assertLease(); const all = new Map(), payload = [], controls = new Set();
    const traversal = this.traversal();
    const rootEntries = this.entries(this.names.live, traversal);
    const names = new Set(rootEntries.map(entry => entry.name));
    for (const entry of rootEntries) {
      const file = path.join(this.names.live, entry.name), info = fs.lstatSync(file);
      if (entry.name === 'download.7z') {
        if (!stableFile(file, this.originalArchiveIdentity)) throw new HeldError('original archive changed before copy'); controls.add(entry.name);
      } else if (entry.name === 'download.partial') {
        if (!info.isFile() || info.nlink !== 1) throw new Error('unsupported partial artifact was retained'); controls.add(entry.name);
      } else if (entry.name === 'extracted.json' && (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))) {
        controls.add(entry.name); // Preserve linked completion node in previous custody, never clone/follow it.
      } else if (['extracted.json', '.extraction-unverified.json'].includes(entry.name)) {
        if (!info.isFile() || info.nlink !== 1 || !await this.metadataMatches(file)) throw new Error('unrecognized completion/status metadata was retained'); controls.add(entry.name);
      } else if (/^\.completion-[A-Za-z0-9]{6}(\.record)?$/.test(entry.name)) {
        const base = entry.name.replace(/\.record$/, ''), directory = path.join(this.names.live, base), saved = directory + '.record';
        const reservation = maybeStat(directory), record = maybeStat(saved);
        if (!names.has(base) || !names.has(base + '.record') || !reservation?.isDirectory() || reservation.isSymbolicLink() ||
            this.entries(directory, this.traversal()).length !== 0 || !record || (!record.isSymbolicLink() && (!record.isFile() || record.nlink !== 1 || !await this.metadataMatches(saved)))) {
          throw new Error('ambiguous completion-custody entry was retained');
        }
        controls.add(base); controls.add(base + '.record');
      } else if (/^\.extracted-[a-f0-9]{24}\.tmp$/.test(entry.name)) {
        if (!info.isFile() || info.nlink !== 1 || !await this.metadataMatches(file)) throw new Error('ambiguous completion temporary was retained'); controls.add(entry.name);
      } else if (entry.name.startsWith('.completion-') || entry.name.startsWith('.extracted-')) {
        throw new Error('ambiguous reserved-name entry was retained rather than omitted');
      }
    }
    const stack = [{ file: this.names.live, relative: '' }]; let seeded = 0n;
    while (stack.length) {
      const current = stack.pop(); const info = fs.lstatSync(current.file);
      if (!current.relative) { if (!sameIdentity(current.file, this.originalIdentity)) throw new HeldError('original directory changed'); }
      else this.ordinary(info, current.file);
      this.account(traversal, current.relative, info); all.set(current.relative, snapshot(info));
      if (current.relative) payload.push({ relative: current.relative, info });
      if (!info.isDirectory()) { seeded += BigInt(integer(info.size, 'seeded payload size')); continue; }
      for (const entry of current.relative ? this.entries(current.file, traversal, current.relative) : rootEntries) {
        const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
        const file = path.join(current.file, entry.name);
        if (!current.relative && controls.has(entry.name)) { const control = fs.lstatSync(file); this.account(traversal, relative, control); all.set(relative, snapshot(control)); continue; }
        stack.push({ file, relative });
      }
    }
    this.sourceManifest = all; this.seedPayload = payload; this.seedDirectories = new Set(payload.filter(item => item.info.isDirectory()).map(item => item.relative)); this.seedBytes = seeded;
  }
  sourceUnchanged(base = this.names.live, moved = false) {
    if (!this.sourceManifest || !sameIdentity(base, this.originalIdentity)) return false;
    try {
      const actual = new Map(), stack = [{ file: base, relative: '' }], traversal = this.traversal();
      while (stack.length) {
        const current = stack.pop(), info = fs.lstatSync(current.file); this.account(traversal, current.relative, info); actual.set(current.relative, info);
        if (info.isDirectory() && (!current.relative || this.seedDirectories.has(current.relative))) {
          for (const entry of this.entries(current.file, traversal, current.relative)) stack.push({ file: path.join(current.file, entry.name), relative: current.relative ? path.join(current.relative, entry.name) : entry.name });
        }
      }
      return actual.size === this.sourceManifest.size && [...this.sourceManifest].every(([relative, expected]) =>
        actual.has(relative) && equalSnapshot(actual.get(relative), expected, moved && relative === ''));
    } catch { return false; }
  }
  async prepare() {
    await this.collectSource(); this.assertLease();
    integer(this.originalArchiveIdentity.size, 'opened archive size'); integer(this.entry.diskBytesNeeded, 'registry diskBytesNeeded');
    const planned = BigInt(this.originalArchiveIdentity.size) + this.seedBytes + BigInt(this.entry.diskBytesNeeded) + BigInt(METADATA_ALLOWANCE);
    const facts = fs.statfsSync(this.names.custody, { bigint: true });
    if (typeof facts.bavail !== 'bigint' || typeof facts.bsize !== 'bigint' || facts.bavail < 0n || facts.bsize <= 0n) throw new Error('destination available-byte observation is unavailable');
    const available = facts.bavail * facts.bsize, required = planned + BigInt(this.headroomBytes);
    this.space = { plannedAdditionalBytes: planned.toString(), availableBytesObserved: available.toString(), headroomBytes: this.headroomBytes,
      observedAtMs: Date.now(), metadataAllowanceBytes: METADATA_ALLOWANCE, seededPayloadBytes: this.seedBytes.toString() };
    if (required > available) throw new Error(`staging needs an estimated ${planned} additional bytes plus ${this.headroomBytes} headroom; ${available} available bytes were observed. Old data was not moved.`);
    await this.phaseTo('preparing');
    const archiveCopy = await this.io.copyRegularFile(path.join(this.names.live, 'download.7z'), this.archive, this.originalArchiveIdentity, { mode: 0o600 });
    if (archiveCopy.digest !== this.entry.sha256) throw new Error('owned archive copy checksum mismatch');
    this.archiveIdentity = archiveCopy.identity;
    const directories = this.seedPayload.filter(item => item.info.isDirectory()).sort((a, b) => a.relative.split(path.sep).length - b.relative.split(path.sep).length);
    for (const item of directories) { this.assertLease(); fs.mkdirSync(path.join(this.stage, item.relative), { mode: 0o700 }); }
    for (const item of this.seedPayload.filter(item => item.info.isFile())) {
      this.assertLease(); await this.io.copyRegularFile(path.join(this.names.live, item.relative), path.join(this.stage, item.relative), item.info, { mode: item.info.mode & 0o777 });
    }
    this.assertLease(); this.scanStage(false);
    if (!this.sourceUnchanged()) throw new HeldError('original payload changed while candidate was seeded');
    await this.phaseTo('prepared');
  }
  scanStage(controlsAdded) {
    this.assertLease(); if (!sameIdentity(this.stage, this.stageIdentity)) throw new HeldError('candidate directory was replaced');
    const stack = [{ file: this.stage, relative: '' }], traversal = this.traversal(); let bytes = 0n;
    while (stack.length) {
      const current = stack.pop(), info = fs.lstatSync(current.file); this.account(traversal, current.relative, info); this.ordinary(info, current.file);
      if (info.isDirectory()) {
        for (const item of this.entries(current.file, traversal, current.relative)) {
          const entry = item.name;
          if (!current.relative && !controlsAdded && (FIXED_CONTROLS.has(entry) || entry.startsWith('.completion-') || entry.startsWith('.extracted-'))) {
            throw new Error('candidate archive collides with a reserved product artifact; all data was retained');
          }
          stack.push({ file: path.join(current.file, entry), relative: current.relative ? path.join(current.relative, entry) : entry });
        }
      } else bytes += BigInt(integer(info.size, 'candidate size'));
    }
    if (controlsAdded && this.entry.diskBytesNeeded > 0 && bytes > BigInt(this.entry.diskBytesNeeded) * 3n) throw new Error('candidate total size exceeds the registry limit; old data was retained');
    return bytes;
  }
  assertPrepared() {
    this.assertLease(); if (!this.resourcesClosed() || !this.sourceUnchanged() || !stableFile(this.archive, this.archiveIdentity)) throw new HeldError('prepared transaction changed or resource closure is unavailable');
    this.scanStage(false);
  }
  async beforeWriter() { this.assertPrepared(); await this.phaseTo('extracting'); this.assertPrepared(); }
  async writerClosed() { if (!this.allClosed()) throw new HeldError('owned resources are not all closed'); await this.phaseTo('closed'); }
  async validateCandidate() {
    this.assertLease(); if (!this.allClosed()) throw new HeldError('owned resources are not all closed'); this.scanStage(false);
    if (!stableFile(this.archive, this.archiveIdentity)) throw new HeldError('archive copy was replaced/changed and was retained');
    const archiveTarget = path.join(this.stage, 'download.7z');
    const reserved = await this.io.writeBytesExclusive(archiveTarget, Buffer.alloc(0), 0o600);
    const reserveIdentity = reserved.identity || reserved;
    this.assertLease(); if (!stableFile(archiveTarget, reserveIdentity) || !stableFile(this.archive, this.archiveIdentity)) throw new HeldError('archive-copy move destination changed; replacement retained');
    fs.renameSync(this.archive, archiveTarget);
    if (!sameIdentity(archiveTarget, this.archiveIdentity)) throw new HeldError('archive-copy move outcome is uncertain');
    this.archiveInCandidate = true; this.archiveIdentity = regular(archiveTarget);
    await this.writeExclusive(path.join(this.stage, 'extracted.json'), { id: this.id, version: this.entry.version, sha256: this.entry.sha256, extractedAt: Date.now() });
    this.scanStage(true); // Includes own archive and completion bytes, preserving prior cap intent.
    if (!this.sourceUnchanged()) throw new HeldError('old payload changed before publication');
    await this.phaseTo('validated');
  }
  reserveDirectory(file) { fs.mkdirSync(file, { mode: 0o700 }); return ordinaryDirectory(file); }
  slot(file, allowed) {
    const actual = maybeStat(file);
    if (!actual) return null;
    if (!allowed.some(expected => expected && actual.dev === expected.dev && actual.ino === expected.ino)) throw new HeldError(`unknown replacement was retained at ${file}`);
    return actual;
  }
  validateSlots(prospectiveRecovery = false) {
    this.assertLease(prospectiveRecovery);
    this.slot(this.names.live, [this.originalIdentity, this.stageIdentity, this.liveReservation]);
    this.slot(this.previous, [this.originalIdentity, this.previousReservation]);
    this.slot(this.stage, [this.stageIdentity, this.stageReservation]);
    this.slot(this.history, [this.historyReservation]);
    if (this.archiveIdentity) {
      if (this.archiveInCandidate) {
        const candidateBase = sameIdentity(this.names.live, this.stageIdentity) ? this.names.live : this.stage;
        if (!stableFile(path.join(candidateBase, 'download.7z'), this.archiveIdentity)) throw new HeldError('candidate archive changed and was retained');
      } else if (!stableFile(this.archive, this.archiveIdentity)) throw new HeldError('archive copy changed and was retained');
    }
  }
  async release(phase) {
    this.assertLease(); if (!this.allClosed()) throw new HeldError('resource closure is unavailable at journal disposition');
    await this.phaseTo(phase);
    if (this.historyReservation) {
      if (this.historyReservation.size !== 0 || !stableFile(this.history, this.historyReservation)) throw new HeldError('journal archival reservation changed; retained');
    } else {
      const reserved = await this.io.writeBytesExclusive(this.history, Buffer.alloc(0), 0o600); this.historyReservation = reserved.identity || reserved;
    }
    this.assertLease(); if (!stableFile(this.history, this.historyReservation)) throw new HeldError('journal archival destination changed; retained');
    this.validateSlots();
    const oldBase = sameIdentity(this.names.live, this.originalIdentity) ? this.names.live : this.previous;
    if (this.sourceManifest && !this.sourceUnchanged(oldBase, true)) throw new HeldError('previous payload changed before journal disposition; data retained');
    const anchor = this.anchorIdentity;
    try { fs.renameSync(this.names.anchor, this.history); }
    catch (error) {
      if (stableFile(this.names.anchor, anchor) && stableFile(this.history, this.historyReservation)) throw error;
      this.releaseUncertain = true; throw new HeldError('fixed-anchor release outcome is uncertain; no restoration attempted');
    }
    // IRREVERSIBLE LINEARIZATION: a new owner can enter now. Never restore or
    // perform another filesystem write after this assignment, even on error.
    this.released = true;
    if (!sameIdentity(this.history, anchor)) throw new HeldError('anchor released but archival receipt changed; no restoration attempted');
  }
  async publish() {
    this.publicationStarted = true;
    if (!this.allClosed()) throw new HeldError('resource closure is unavailable before publication');
    this.validateSlots(); await this.phaseTo('backup-intent'); this.validateSlots();
    if (!this.sourceUnchanged()) throw new HeldError('old payload changed before backup move');
    this.previousReservation = this.reserveDirectory(this.previous); this.validateSlots();
    fs.renameSync(this.names.live, this.previous); this.originalMoved = true;
    if (!sameIdentity(this.previous, this.originalIdentity)) throw new HeldError('previous-directory move outcome is uncertain');
    await this.phaseTo('previous-moved'); await this.phaseTo('install-intent'); this.validateSlots();
    this.liveReservation = this.reserveDirectory(this.names.live); this.validateSlots();
    fs.renameSync(this.stage, this.names.live); this.candidateMoved = true;
    if (!sameIdentity(this.names.live, this.stageIdentity)) throw new HeldError('candidate publication outcome is uncertain');
    await this.phaseTo('installed'); this.validateSlots();
    await this.release('committed');
    return { ok: true, state: 'ready', closureKnown: true, retainedStorage: this.notice('retained'), space: this.space };
  }
  async retireFailure() {
    if (!this.allClosed() || !this.hooks.current() || this.hooks.returnedUnknown() || this.released || this.releaseUncertain) throw new HeldError('original-process closed failure-disposition lease is unavailable');
    this.inRecovery = true; this.io = this.newIO(true);
    if (this.released || this.releaseUncertain) throw new HeldError('journal disposition is unavailable');
    this.validateSlots(); if (!sameIdentity(this.names.live, this.originalIdentity)) throw new HeldError('old directory requires guarded restoration');
    if (this.sourceManifest && !this.sourceUnchanged()) throw new HeldError('original payload changed during failed staging; journal retained');
    await this.release('failed-retained');
    return { retainedStorage: this.notice('retained'), space: this.space };
  }
  async restore() {
    if (!this.allClosed() || this.released || this.releaseUncertain || !this.hooks.current() || this.hooks.returnedUnknown()) throw new HeldError('original-process closed recovery lease is unavailable');
    this.inRecovery = true; this.io = this.newIO(true);
    this.validateSlots(); await this.phaseTo('restoring'); this.validateSlots();
    if (sameIdentity(this.names.live, this.stageIdentity)) {
      if (maybeStat(this.stage)) throw new HeldError('restoration custody destination is occupied; all data retained');
      this.stageReservation = this.reserveDirectory(this.stage); this.validateSlots();
      fs.renameSync(this.names.live, this.stage); this.candidateMoved = false;
      if (!sameIdentity(this.stage, this.stageIdentity)) throw new HeldError('candidate custody move outcome is uncertain');
    }
    if (!sameIdentity(this.names.live, this.originalIdentity)) {
      if (!sameIdentity(this.previous, this.originalIdentity)) throw new HeldError('previous directory ownership is unavailable');
      const live = maybeStat(this.names.live);
      if (!live) this.liveReservation = this.reserveDirectory(this.names.live);
      else if (!sameIdentity(this.names.live, this.liveReservation)) throw new HeldError('restoration live destination is unknown; retained');
      this.validateSlots(); fs.renameSync(this.previous, this.names.live); this.originalMoved = false;
    }
    if (!sameIdentity(this.names.live, this.originalIdentity) || (this.sourceManifest && !this.sourceUnchanged(this.names.live, true))) throw new HeldError('restored previous identity/metadata could not be verified');
    await this.release('restored');
    return { ok: true, restoredPrevious: true, closureKnown: true, retainedStorage: this.notice('retained'), space: this.space };
  }
  notice(status) { return { status, path: this.names.custody, bytes: null,
    note: 'Previous installs, archive copies and candidate files are retained in this data-custody folder. Size is not measured; contents are not a guaranteed runnable rollback and are not removed with the current model.' }; }
  inspection() {
    let lease = false; try { this.validateSlots(true); lease = true; } catch {}
    const canRestore = lease && this.allClosed();
    return { ok: true, pending: !this.released, canRestore,
      recordedPhase: this.phase, journal: this.names.anchor, transaction: this.transaction, previous: this.previous, candidate: this.stage,
      archiveCopy: this.archive, retainedStorage: this.notice(this.released ? 'retained' : this.allClosed() ? 'pending' : 'held'),
      recovery: canRestore ? 'This original process has a prospective guarded restoration lease; no mutation was performed by inspection.'
        : 'An eligible original-process closed recovery lease is unavailable. Inspection grants no mutation or child-closure authority.' };
  }
}

module.exports = { ModelStageTransaction, HeldError, pending, retainedStorage, inspect, headroomPolicy,
  MAX_RECORD_BYTES, METADATA_ALLOWANCE, DEFAULT_HEADROOM_BYTES };
