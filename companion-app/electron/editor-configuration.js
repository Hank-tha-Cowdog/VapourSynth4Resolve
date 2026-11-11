// In-memory configuration delivery only. No file reads, writes, probes or native work.
const CHANNEL = 'editor:get-configuration';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Present-but-undefined optional fields are ABSENT in JSON semantics, but the
// renderer (and IPC structured clone) can materialize them as
// `{ nodeGuid: undefined }`. Live save failure (Oct 27, fresh node): the old
// check rejected a present-undefined nodeGuid and every Save and close died
// with a generic 'valid host session and chain array required' error.
// Optional fields therefore validate as: undefined/absent → OK; a present
// value must be the right type. Real invalid values are still rejected.
function describeManualHostConfigProblem(value) {
  if (!object(value)) return 'configuration is not an object';
  if (!Array.isArray(value.chain)) return 'chain is not an array';
  const integer = n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  const stringish = v => v === undefined || typeof v === 'string';
  const stringishOrNull = v => v === undefined || v === null || typeof v === 'string';
  const boolish = v => v === undefined || typeof v === 'boolean';
  if (value.schemaVersion !== undefined && !integer(value.schemaVersion)) return 'schemaVersion is not a bounded integer';
  if (!stringish(value.nodeId)) return 'nodeId is not text';
  // nodeGuid: stable host-generated per-node identity (persisted in _config).
  if (!stringish(value.nodeGuid)) return 'nodeGuid is not text';
  if (!boolish(value.manualOrder)) return 'manualOrder is not a boolean';
  if (value.mix !== undefined && (!Number.isFinite(value.mix) || Math.abs(value.mix) > 3.4028234663852886e38)) return 'mix is not a finite float32';
  if (value.colorManagement !== undefined) {
    if (!object(value.colorManagement)) return 'colorManagement is not an object';
    for (const field of ['inputColorSpace', 'inputGamma', 'outputColorSpace', 'outputGamma', 'ocioConfig']) {
      if (value.colorManagement[field] !== undefined && typeof value.colorManagement[field] !== 'string')
        return `colorManagement.${field} is not text`;
    }
  }
  for (const step of Array.from(value.chain)) {
    if (!object(step)) return 'a chain step is not an object';
    if (step.params !== undefined && !object(step.params)) return 'a chain step params is not an object';
    for (const k of ['id', 'type']) if (step[k] !== undefined && typeof step[k] !== 'string') return `a chain step ${k} is not text`;
    for (const k of ['enabled', 'approved']) if (!boolish(step[k])) return `a chain step ${k} is not a boolean`;
    // Content-bound approval (2026-11-11): the binding is the exact emitted
    // body; null = no binding (unapproved).
    if (!stringishOrNull(step.approvedContent)) return 'a chain step approvedContent is not text';
    for (const k of ['stage', 'version']) if (step[k] !== undefined && !integer(step[k])) return `a chain step ${k} is not a bounded integer`;
  }
  return null;
}

function isManualHostConfig(value) {
  return describeManualHostConfigProblem(value) === null;
}

function editorConfigurationSnapshot({ initialConfig, latestConfig, hasConfigArgument, readError, hasResultPath, manualHostApply, recoveryNote }) {
  if (readError || (hasConfigArgument && !object(initialConfig))) {
    return { ok: false, error: 'The supplied editor configuration could not be loaded.' };
  }
  if (hasResultPath && (!hasConfigArgument || !object(initialConfig))) {
    return { ok: false, error: 'A host result path was supplied without a usable initial configuration.' };
  }
  const config = latestConfig ?? initialConfig;
  if (config != null && !object(config)) {
    return { ok: false, error: 'The companion configuration snapshot is not an object.' };
  }
  return { ok: true, mode: hasResultPath ? (manualHostApply ? 'host-manual' : 'host') : 'standalone', config: config ?? null, ...(recoveryNote ? { note: recoveryNote } : {}) };
}

function registerEditorConfigurationBridge(ipcMain, win, readSnapshot) {
  let active = true;
  ipcMain.handle(CHANNEL, event => {
    if (!active || event?.sender !== win.webContents) {
      return { ok: false, error: 'Configuration is available only to its editor window.' };
    }
    return readSnapshot();
  });
  const cleanup = () => {
    if (!active) return;
    active = false;
    ipcMain.removeHandler(CHANNEL);
  };
  win.once('closed', cleanup);
  return cleanup;
}

module.exports = { editorConfigurationSnapshot, registerEditorConfigurationBridge, isManualHostConfig, describeManualHostConfigProblem };
