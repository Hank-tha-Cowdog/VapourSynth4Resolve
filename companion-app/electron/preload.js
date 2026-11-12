const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // ----- inherited from vapoursage -----
  executeScript: (script) => ipcRenderer.send('execute-script', script),
  onLog: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('log', subscription);
    return () => ipcRenderer.removeListener('log', subscription);
  },
  onComplete: (callback) => {
    const subscription = (_event, code) => callback(code);
    ipcRenderer.on('execution-complete', subscription);
    return () => ipcRenderer.removeListener('execution-complete', subscription);
  },
  windowControl: (action) => ipcRenderer.send(action),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  checkRuntime: () => ipcRenderer.invoke('check-runtime'),
  platform: process.platform,
  revealFile: (path) => ipcRenderer.send('reveal-file', path),

  // ----- v2.0 OFX-popout IPC surface -----
  // Wired to XPC service in main.js Phase 2; for now main.js stubs these.
  syncFromHost: (callback) => {
    const subscription = (_event, config) => callback(config);
    ipcRenderer.on('host-sync', subscription);
    return () => ipcRenderer.removeListener('host-sync', subscription);
  },
  getEditorConfiguration: () => ipcRenderer.invoke('editor:get-configuration'),
  // Lock liveness ping: a USABLE editor proves it regularly. A frozen
  // renderer stops pinging, so a fresh Configure can take over the lock
  // instead of deferring to a wedged window (see main.js single-window).
  editorHeartbeat: () => ipcRenderer.invoke('editor:heartbeat'),
  requestFrame: (timecode) => ipcRenderer.invoke('request-frame', timecode),
  previewChain: (chain, mix, timecode) =>
    ipcRenderer.invoke('preview-chain', { chain, mix, timecode }),
  readPreviewImage: () => ipcRenderer.invoke('read-preview-image'),
  applyConfig: (config, options) => ipcRenderer.invoke('apply-config', config, options),
  getClipMetadata: () => ipcRenderer.invoke('get-clip-metadata'),
  loadNodeRecord: (guid) => ipcRenderer.invoke('node-records:load', { guid }),

  // ----- Render queue (beta-batch): vspipe|ffmpeg jobs on the bundled runtimes -----
  renderQueueAdd: (request) => ipcRenderer.invoke('render-queue:add', request),
  renderQueueList: () => ipcRenderer.invoke('render-queue:list'),
  renderQueueCancel: (id) => ipcRenderer.invoke('render-queue:cancel', { id }),
  renderQueueRemove: (id) => ipcRenderer.invoke('render-queue:remove', { id }),
  renderQueueClear: () => ipcRenderer.invoke('render-queue:clear'),
  renderQueueChooseOutput: (request) => ipcRenderer.invoke('render-queue:choose-output', request),
  onRenderQueueEvent: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('render-queue:event', sub);
    return () => ipcRenderer.removeListener('render-queue:event', sub);
  },

  // ----- Archivist streaming bridge (Anthropic for now; multi-vendor in TKT-A5) -----
  sendArchivistMessage: (payload) => ipcRenderer.invoke('archivist:send', payload),
  onArchivistChunk: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('archivist:chunk', sub);
    return () => ipcRenderer.removeListener('archivist:chunk', sub);
  },
  onArchivistComplete: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('archivist:complete', sub);
    return () => ipcRenderer.removeListener('archivist:complete', sub);
  },
  onArchivistToolUse: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('archivist:tool-use', sub);
    return () => ipcRenderer.removeListener('archivist:tool-use', sub);
  },
  onArchivistError: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('archivist:error', sub);
    return () => ipcRenderer.removeListener('archivist:error', sub);
  },
  abortArchivist: (requestId) => ipcRenderer.send('archivist:abort', requestId),
  // Agentic-loop additions: renderer acks bridged tool calls so the model (or an
  // MCP client) learns the outcome, and MCP chain edits arrive on their own channel.
  sendArchivistToolAck: (payload) => ipcRenderer.send('archivist:tool-ack', payload),
  onArchivistToolActivity: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('archivist:tool-activity', sub);
    return () => ipcRenderer.removeListener('archivist:tool-activity', sub);
  },
  onMcpChainEdit: (cb) => {
    const sub = (_event, data) => cb(data);
    ipcRenderer.on('mcp:chain-edit', sub);
    return () => ipcRenderer.removeListener('mcp:chain-edit', sub);
  },

  // ----- Keychain + provider config for Settings modal -----
  listProviders: () => ipcRenderer.invoke('providers:list'),
  hasApiKey: (providerId) => ipcRenderer.invoke('keychain:has-api-key', { providerId }),
  setApiKey: (providerId, key) => ipcRenderer.invoke('keychain:set-api-key', { providerId, key }),
  listConfiguredProviders: () => ipcRenderer.invoke('keychain:list-configured'),
  getEndpoint: (providerId) => ipcRenderer.invoke('keychain:get-endpoint', { providerId }),
  setEndpoint: (providerId, url) => ipcRenderer.invoke('keychain:set-endpoint', { providerId, url }),

  // ----- Source-clip identification + ffprobe -----
  pickClipFile: () => ipcRenderer.invoke('clip:pick-file'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  probeClip: (filePath) => ipcRenderer.invoke('clip:probe', { filePath }),
  queryCurrentClip: () => ipcRenderer.invoke('resolve:query-current-clip'),
  // ACTUALLY registered VapourSynth namespaces (runtime probe; honest source
  // for Filter Library availability + the Archivist manifest).
  probeNamespaces: () => ipcRenderer.invoke('plugin:probe-namespaces'),
  // Companion chain preview (manual-host sessions): render a frame of the
  // HOST'S composed script. mode 'processed' (chain result) | 'source' (A/B).
  renderPreviewFrame: (request) => ipcRenderer.invoke('preview:render-frame', request),
  // Read the host's composed script (last-composed.vpy) verbatim.
  readComposedScript: (request) => ipcRenderer.invoke('plugin:read-composed-script', request),
  // Optional neural-model manager (explicit, cancellable downloads).
  listModels: () => ipcRenderer.invoke('models:list'),
  // ONE authoritative capability snapshot (levels: weights → adapter →
  // backend → load → inference; "usable" only when inference-verified).
  neuralCapability: () => ipcRenderer.invoke('models:capability'),
  downloadModel: (request) => ipcRenderer.invoke('models:download', request),
  extractModel: (request) => ipcRenderer.invoke('models:extract', request),
  cancelModelDownload: (request) => ipcRenderer.invoke('models:cancel', request),
  removeModel: (request) => ipcRenderer.invoke('models:remove', request),
  // Read-only removal scope preview (for the confirm dialog).
  describeModelRemoval: (request) => ipcRenderer.invoke('models:removal-scope', request),
  // Portable, identity-free recipes (chain-only; never nodeGuid/source/chat).
  listRecipes: () => ipcRenderer.invoke('recipes:list'),
  saveRecipe: (request) => ipcRenderer.invoke('recipes:save', request),
  loadRecipe: (request) => ipcRenderer.invoke('recipes:load', request),
  deleteRecipe: (request) => ipcRenderer.invoke('recipes:delete', request),
  // Read a text file the user chose (recipe import).
  openTextFile: () => ipcRenderer.invoke('app:open-text-file'),
  // Native-menu shortcut events (Cmd+W A/B toggle). Returns an unsubscribe fn.
  onShortcut: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('shortcut', listener);
    return () => { ipcRenderer.removeListener('shortcut', listener); };
  },
  // Save a text file via the OS save dialog (chat export).
  saveTextFile: (request) => ipcRenderer.invoke('app:save-text-file', request),
  onModelProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('models:progress', listener);
    return () => ipcRenderer.removeListener('models:progress', listener);
  },

  // Plugin status (OFX-side render state surfaced for the popout banner)
  readPluginStatus: () => ipcRenderer.invoke('plugin:read-status'),

  // Install/Update the OFX plugin for Resolve (bundled vsres-install helper)
  pluginInstall: (action) => ipcRenderer.invoke('plugin:install', { action }),
});
