const crypto = require('node:crypto');


const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const fs = require('fs');
const llm = require('./llm');
const keychain = require('./keychain');
const probe = require('./probe');
const resolveApi = require('./resolve-api');
const toolRegistry = require('./tools/registry');
const { startMcpServer } = require('./services/mcpServer');
const { probeNamespaces } = require('./vs-plugin-probe');
const { renderPreviewFrame } = require('./preview-companion');
const { registerModelManager } = require('./model-manager');
const { capabilitySnapshot } = require('./neural-capability');
const { registerRecipeHandlers } = require('./recipes');
const { editorConfigurationSnapshot, registerEditorConfigurationBridge, isManualHostConfig, describeManualHostConfigProblem } = require('./editor-configuration');

// --- RUNTIME ARCHITECTURE (M1 OPTIMIZED) ---
// `isDev` controls Python runtime path lookups (inherited from vapoursage).
// `useStaticRenderer` controls whether the React renderer loads from the vite dev
// server or from the prebuilt static bundle at ../build/. The OFX plugin sets
// VSRES_USE_STATIC=1 when it spawns this process so we load the static bundle
// without needing vite running in the background.
const isDev = !app.isPackaged;

// TEST ISOLATION (root-caused 2026-10-31): the journey-test leak was NOT
// storage at all — it was the renderer's mount-time auto-discovery, which
// live-queries the machine's RUNNING Resolve (resolve-api.queryCurrentClip)
// and ADOPTS the playhead clip over the fixture config. That channel ignores
// HOME and userData entirely. Tests that must own the source therefore set
// BOTH: VSRES_DISABLE_RESOLVE_DISCOVERY=1 (kills the live query at its
// source) and VSRES_ALLOWED_SOURCE_ROOTS (preview-companion refuses any
// render whose script binds a path outside the fixture — fail-closed before
// any python or media open). VSRES_USER_DATA_DIR additionally owns this
// instance's Electron userData (localStorage/session still live in the REAL
// user dir regardless of HOME — a separate documented trap), so a test
// instance shares no state with the owner's.
if (process.env.VSRES_USER_DATA_DIR) {
    try { app.setPath('userData', process.env.VSRES_USER_DATA_DIR); } catch { /* best effort */ }
}
const useStaticRenderer = process.env.VSRES_USE_STATIC === '1' || app.isPackaged;

// Read --config-path=<file> from argv. The OFX plugin writes the current `_config`
// JSON blob to a tempfile and passes the path here; main reads it and pushes the
// parsed config to the renderer via the host-sync IPC channel on window load.
let initialConfig = null;
let hasConfigArgument = false;
let initialConfigReadError = null;
{
  const arg = process.argv.find(a => a.startsWith('--config-path='));
  if (arg) {
    hasConfigArgument = true;
    const configPath = arg.split('=')[1];
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      initialConfig = raw.length > 0 ? JSON.parse(raw) : null;
    } catch (e) {
      initialConfigReadError = e?.message || String(e);
      console.error('[vsres] failed to read --config-path:', e.message);
    }
  }
}

// Latest NodeConfig the main process has seen — boot config, then refreshed on
// every apply-config live-sync from the renderer. This is what get_chain_state
// (MCP + Archivist agentic tools) reads.
let latestConfig = initialConfig;
// Pending renderer round-trips for agentic tools: editId → resolve fn. Used by
// both the MCP apply_chain_edit bridge and the Archivist's propose_chain_edit
// tool-result ack.
const pendingToolBridges = new Map();

// SENDER POLICY (security re-review #4, 2026-11-11): execution-capable IPC
// handlers serve ONLY this window's own renderer — the same identity rule the
// configuration getter (editor-configuration.js) enforces. The preload bridge
// exists on this window alone; every other sender is refused before any
// spawn, file write or provider dispatch.
let editorWindow = null;
function isTrustedSender(event) {
  try {
    return !!editorWindow && !editorWindow.isDestroyed()
      && !!event && event.sender === editorWindow.webContents;
  } catch {
    return false;
  }
}

// Read --result-path=<file>. When the user clicks Accept in the renderer, main writes
// the pending configuration to this path. Manual-host sessions require the
// explicit Apply companion changes action in Resolve.
const manualHostApply = process.argv.includes('--host-apply-mode=manual');
const hostSessionId = process.argv.find(a => a.startsWith('--host-session-id='))?.slice('--host-session-id='.length) ?? null;
const requestedRevisionFloor = Number(process.argv.find(a => a.startsWith('--host-applied-revision='))?.slice('--host-applied-revision='.length) ?? 0);
const hostRevisionFloor = Number.isSafeInteger(requestedRevisionFloor) && requestedRevisionFloor >= 0
  ? requestedRevisionFloor : Number.MAX_SAFE_INTEGER;
let resultRevision = hostRevisionFloor;
const hostRecoveryRequired = process.argv.includes('--host-recovery-required=1');
const recoveryInputDescription = process.argv.includes('--host-config-origin=pending')
  ? 'Retained edits are shown for review.' : 'The host input snapshot is shown.';
let pendingRecoveryRequired = hostRecoveryRequired;
let recoveryNote = hostRecoveryRequired
  ? 'A prior pending result is retained. ' + recoveryInputDescription + ' Use Save and close explicitly to publish to this new recovery session.' : '';
let resultPath = null;
{
  const arg = process.argv.find(a => a.startsWith('--result-path='));
  if (arg) resultPath = arg.split('=')[1];
}

// Read only a bounded regular file through one no-follow descriptor. This is
// pending editor state, never evidence that Resolve accepted the configuration.
function readManualHostResult() {
  const fd = fs.openSync(resultPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 0 || before.size > 8 * 1024 * 1024) throw new Error('Invalid pending result file.');
    if (!before.size) return null;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error('Incomplete pending result.');
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error('Pending result changed.');
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Pending result changed.');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || value.sessionId !== hostSessionId || !Number.isSafeInteger(value.revision) || value.revision <= 0) {
      throw new Error('Pending result does not match this session.');
    }
    return value;
  } finally { fs.closeSync(fd); }
}

if (manualHostApply && resultPath) {
  try {
    const pending = readManualHostResult();
    if (pending) {
      resultRevision = Math.max(resultRevision, pending.revision);
      if (hostRecoveryRequired || pending.revision < hostRevisionFloor || !isManualHostConfig(pending.config)) {
        throw new Error('Pending configuration requires explicit recovery.');
      }
      initialConfig = pending.config;
      latestConfig = initialConfig;
      recoveryNote = 'Saved companion edits were reopened. Host apply and rendering remain unconfirmed.';
    }
  } catch {
    pendingRecoveryRequired = true;
    recoveryNote = 'The previous pending result could not be loaded. ' + recoveryInputDescription + ' Automatic writes are held to preserve that file; edit here, then explicitly Save and close to replace it.';
  }
}

// Preview round-trip: we write a request JSON to previewRequestPath; the OFX plugin's
// PreviewService renders the chain and writes a PNG to previewResponsePath. We watch
// that path for changes and stream each new render to the renderer.
let previewRequestPath = null;
let previewResponsePath = null;
{
  const reqArg = process.argv.find(a => a.startsWith('--preview-request-path='));
  if (reqArg) previewRequestPath = reqArg.split('=')[1];
  const respArg = process.argv.find(a => a.startsWith('--preview-response-path='));
  if (respArg) previewResponsePath = respArg.split('=')[1];
}

// Plugin status path — the OFX plugin writes a JSON snapshot after each render
// (state: passthrough | chain-empty | chain-ok | chain-error, plus any error and a
// preview of the composed VS script). Popout polls + surfaces in a banner so the
// user can SEE why a chain isn't producing output.
let statusPath = null;
{
  const arg = process.argv.find(a => a.startsWith('--status-path='));
  if (arg) statusPath = arg.split('=')[1];
}

// On macOS Production, 'process.resourcesPath' points to
// VapourSage.app/Contents/Resources. The legacy 'runtime/' tree is an
// OPTIONAL layout (owner decision B4); the runtime that ALWAYS ships is the
// OFX bundle's embedded CPython framework — the same interpreter the preview
// path uses. resolveRuntimes() reports absent components honestly instead
// of assuming paths that may not exist on the installed machine.
const { resolveRuntimes } = require('./prod-paths');
const { disposeAllWorkers } = require('./preview-worker');
const RUNTIMES = resolveRuntimes({
  resourcesPath: isDev ? path.join(__dirname, '../runtime') : process.resourcesPath,
});

const PATHS = {
  python: RUNTIMES.python.path,
  pythonSource: RUNTIMES.python.source,   // 'runtime' | 'ofx-bundle'
  pythonHome: RUNTIMES.pythonHome,
  ffmpeg: RUNTIMES.ffmpeg.path,
  ffprobe: RUNTIMES.ffprobe.path,
  vsPluginPath: RUNTIMES.vsPluginPath.path,
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#09090b',
    frame: false, 
    titleBarStyle: 'hidden', 
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  const startUrl = useStaticRenderer
    ? `file://${path.join(__dirname, '../build/index.html')}`
    : 'http://localhost:5173';

  // The app window is the ONLY sender trusted by execution-capable IPC
  // (see isTrustedSender). Other windows/senders are refused outright.
  editorWindow = win;

  // NAVIGATION POLICY (security re-review #4, 2026-11-11): the preload
  // bridge is safe only while this window stays ON the app page — a
  // navigated frame or child window would still receive the preload and
  // could drive every execution handler. Both routes are refused.
  const appFilePath = path.join(__dirname, '../build/index.html');
  const isAppUrl = rawUrl => {
    try {
      const target = new URL(rawUrl);
      if (target.protocol === 'file:') return target.pathname === appFilePath;
      return !useStaticRenderer && isDev && target.origin === new URL(startUrl).origin;
    } catch {
      return false;
    }
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      console.warn('[security] blocked renderer navigation to', url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[security] denied renderer window.open to', url);
    return { action: 'deny' };
  });

  const readEditorConfiguration = () => editorConfigurationSnapshot({
    initialConfig, latestConfig, hasConfigArgument, readError: initialConfigReadError,
    hasResultPath: !!resultPath, manualHostApply, recoveryNote,
  });
  registerEditorConfigurationBridge(ipcMain, win, readEditorConfiguration);
  win.loadURL(startUrl);
  if (isDev && !useStaticRenderer) win.webContents.openDevTools();

  // Compatibility push uses the same current snapshot as the getter. Recreated
  // renderers must not receive a stale boot config after earlier local writes.
  if (initialConfig) {
    win.webContents.once('did-finish-load', () => {
      const snapshot = readEditorConfiguration();
      if (snapshot.ok && snapshot.config) win.webContents.send('host-sync', snapshot.config);
    });
  }
  
  ipcMain.on('window-min', () => win.minimize());
  ipcMain.on('window-max', () => win.isMaximized() ? win.unmaximize() : win.maximize());
  ipcMain.on('window-close', () => win.close());
  
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('check-runtime', async () => {
      // Automatic GPU Inference
      let gpuInfo = "Integrated / Software";
      if (process.platform === 'darwin' && process.arch === 'arm64') {
          gpuInfo = "Metal (Apple Silicon)";
      } else if (process.platform === 'win32') {
          gpuInfo = "Discrete GPU (DirectX/CUDA)";
      }

      return {
          python: { path: PATHS.python, source: PATHS.pythonSource, exists: fs.existsSync(PATHS.python) },
          ffmpeg: { path: PATHS.ffmpeg, exists: fs.existsSync(PATHS.ffmpeg) },
          ffprobe: { path: PATHS.ffprobe, exists: fs.existsSync(PATHS.ffprobe) },
          vs: { path: PATHS.vsPluginPath, exists: fs.existsSync(PATHS.vsPluginPath) },
          platform: `${process.platform} (${process.arch})`,
          gpu: gpuInfo
      };
  });
}

// ── Native application menu — DELIBERATE Cmd+W conflict resolution ──────────
// The default macOS menu owns Cmd+W (Close Window), and a menu key equivalent
// fires BEFORE any renderer handler — a renderer-only Cmd+W listener would
// silently lose the race. We therefore replace the default menu with a
// minimal template that (a) keeps the standard roles users expect (app, edit,
// view), (b) rebinds Cmd+W to a 'shortcut:toggle-ab' IPC event which the
// renderer guards (Preview tab active AND focus NOT in a text field), and
// (c) keeps an accelerator-less Close Window item so the header
// Close/Save-and-close route stays explicit and native. Consequence,
// documented for the user: Cmd+W no longer closes the companion window.
// Resolve's own shortcuts are a separate process and are never intercepted.
function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const sendToFocused = (name) => () => {
    const w = BrowserWindow.getFocusedWindow();
    if (w) w.webContents.send('shortcut', { name });
  };
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Preview',
      submenu: [
        { label: 'Toggle Source / Chain (A/B)', accelerator: 'CmdOrCtrl+W', click: sendToFocused('toggle-ab') },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ role: 'front' }] : []),
        { type: 'separator' },
        // Close WITHOUT the Cmd+W accelerator (that now toggles A/B) — the
        // header Close / Save-and-close buttons remain the explicit routes.
        { label: 'Close Window', click: () => { const w = BrowserWindow.getFocusedWindow(); if (w) w.close(); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  installApplicationMenu();
  // ── Single window per node (live diagnosis Oct 26: two Configure presses
  // on one node spawned two simultaneous editors of the same chain) ──
  // Keyed by the node's persistent GUID (initialConfig.nodeGuid — legacy
  // configs without one skip this and behave as before). A second launch for
  // a node whose editor is already open does NOT create a conflicting
  // window: it drops an activate sentinel and exits; the running editor
  // polls for the sentinel, brings itself forward, and removes it. Saves and
  // chat stay in the one window that owns the node.
  const appSupportDir = path.join(os.homedir(), 'Library/Application Support/VapourSynth-OFX');
  const locksDir = path.join(appSupportDir, 'locks');
  const nodeGuid = (typeof initialConfig?.nodeGuid === 'string' && /^[\w][\w-]{0,63}$/.test(initialConfig.nodeGuid))
    ? initialConfig.nodeGuid : null;   // malformed guids never reach a lock/sentinel filename
  const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // ── Lock heartbeat + wedged-lock takeover ──────────────────────────────
  // A pid being ALIVE proves nothing about the editor being USABLE: a
  // companion whose renderer froze (or whose main loop wedged, e.g. after
  // its host Resolve died) keeps its lock, so a fresh Configure would
  // "activate" a dead window and exit — leaving the user with an
  // unresponsive editor and no way in (live owner report 2026-10-29).
  // Fix: the lock's freshness is the last RENDERER ping (editor:heartbeat
  // IPC) — the main interval rewrites the lock but NEVER advances
  // freshness, so a frozen renderer goes stale even while main survives.
  // A second launch defers only to a FRESH lock (or one inside its
  // startup grace window); otherwise it TAKES OVER. The old process's
  // will-quit cleanup still checks pid ownership, so a revived zombie can
  // never delete the new editor's lock.
  const LOCK_STALE_MS = 15_000;
  const LOCK_STARTUP_GRACE_MS = 30_000;
  const heartbeat = { last: Date.now() };
  let myLockPath = null;
  let heartbeatTimer = null;
  const writeLock = () => {
    if (!myLockPath) return;
    try {
      fs.writeFileSync(myLockPath, JSON.stringify({ pid: process.pid, heartbeat: heartbeat.last }));
    } catch { /* best effort */ }
  };
  if (nodeGuid) {
    try {
      fs.mkdirSync(locksDir, { recursive: true });
      const lockPath = path.join(locksDir, `${nodeGuid}.lock`);
      const sentinel = path.join(locksDir, `${nodeGuid}.activate`);
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { existing = null; }
      const existingHb = Number.isFinite(existing?.heartbeat) ? existing.heartbeat : 0;
      const ownerAlive = existing && Number.isInteger(existing.pid)
        && existing.pid !== process.pid && pidAlive(existing.pid);
      // Fresh = the live owner's RENDERER pinged recently.
      const existingFresh = ownerAlive && (Date.now() - existingHb) < LOCK_STALE_MS;
      // Startup grace: a still-booting editor's renderer hasn't begun to
      // ping yet. For NEW-format locks (heartbeat present) grace is
      // heartbeat-age-only — a wedged main keeps REWRITING the file (mtime
      // always fresh) and must not fake grace. Mtime is a proxy ONLY for
      // old-format locks with no heartbeat field (migration).
      let graceOk = false;
      if (ownerAlive) {
        if (existingHb > 0) {
          graceOk = (Date.now() - existingHb) < LOCK_STARTUP_GRACE_MS;
        } else {
          try { graceOk = (Date.now() - fs.statSync(lockPath).mtimeMs) < LOCK_STARTUP_GRACE_MS; }
          catch { /* no file */ }
        }
      }
      if (ownerAlive && !existingFresh && !graceOk) {
        console.warn(`[single-window] node ${nodeGuid} lock pid ${existing.pid} is alive but UNRESPONSIVE `
          + `(last renderer ping ${Math.max(0, Math.round((Date.now() - existingHb) / 1000))}s ago) — taking over the lock.`);
      }
      if (existingFresh || graceOk) {
        fs.writeFileSync(sentinel, String(Date.now()));
        console.log(`[single-window] node ${nodeGuid} already has an editor (pid ${existing.pid}); activating it and exiting.`);
        app.exit(0);
        return;
      }
      heartbeat.last = Date.now();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeat: heartbeat.last }));
      myLockPath = lockPath;
      // Rewrite the lock periodically WITHOUT advancing freshness: keeps
      // pid/current fields honest; only the renderer ping proves usability.
      heartbeatTimer = setInterval(writeLock, 5_000);
    } catch (e) { console.warn('[single-window] lock unavailable, continuing:', e.message); }
  }
  ipcMain.handle('editor:heartbeat', () => {
    heartbeat.last = Date.now();
    writeLock();
    return true;
  });
  const releaseMyLock = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (!myLockPath) return;
    try {
      const current = JSON.parse(fs.readFileSync(myLockPath, 'utf8'));
      if (current && current.pid === process.pid) fs.unlinkSync(myLockPath);
    } catch { /* already gone */ }
  };
  app.on('will-quit', releaseMyLock);
  app.on('will-quit', () => { try { disposeAllWorkers(); } catch { /* best effort */ } });
  if (nodeGuid) {
    const sentinel = path.join(locksDir, `${nodeGuid}.activate`);
    const activatePoll = setInterval(() => {
      try {
        if (fs.existsSync(sentinel)) {
          fs.unlinkSync(sentinel);
          const wins = BrowserWindow.getAllWindows();
          if (wins.length) { wins[0].show(); wins[0].focus(); }
        }
      } catch { /* best effort */ }
    }, 500);
    app.on('will-quit', () => clearInterval(activatePoll));
  }

  createWindow();

  ipcMain.on('reveal-file', (event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
    }
  });

  ipcMain.on('execute-script', (event, scriptContent) => {
    const sender = event?.sender;
    // Renderer teardown must not turn a late child event into a main-process crash.
    const send = (channel, payload) => {
      try {
        if (sender && (typeof sender.isDestroyed !== 'function' || !sender.isDestroyed())) {
          sender.send(channel, payload);
        }
      } catch { /* the receiving window can close between the check and send */ }
    };
    let finished = false;
    const complete = (code, error) => {
      if (finished) return false;
      finished = true;
      send('execution-complete', { code, error });
      return true;
    };
    // SENDER POLICY (security re-review #4): only this window's own renderer
    // may feed Python stdin. Refused BEFORE any runtime probe or spawn.
    if (!isTrustedSender(event)) {
      complete(1, 'Untrusted sender: script execution is available only to its own editor window.');
      return;
    }
    if (typeof scriptContent !== 'string') {
      complete(1, 'Script must be text.');
      return;
    }
    
    if (!fs.existsSync(PATHS.python)) {
        send('log', { type: 'error', message: `CRITICAL: No Python runtime found (looked for the optional runtime/ tree and the embedded OFX-bundle framework). Reinstall the companion app.` });
        complete(1, 'Runtime Missing');
        return;
    }

    send('log', { type: 'info', message: `Initializing Runtime (${process.arch}, ${PATHS.pythonSource})...` });

    // --- ENVIRONMENT CONFIGURATION ---
    const env = { ...process.env };

    if (PATHS.pythonSource === 'ofx-bundle') {
        // EMBEDDED FRAMEWORK PYTHON: self-resolves its stdlib + VapourSynth
        // via the bundle's vapoursynth.toml — exactly the environment the
        // preview render path uses. Setting PYTHONHOME/PYTHONPATH here would
        // BREAK it (framework pythons reject PYTHONHOME).
        // SELF-CONTAINMENT (2026-10-31): resolve filter plugins from the
        // bundle's staged Contents/Plugins (PATHS.vsPluginPath is
        // bundle-first; the legacy user dir remains the fallback). The old
        // VS_PLUGIN_PATH name was never consumed by any script.
        env.VAPOURSYNTH_EXTRA_PLUGIN_PATH = PATHS.vsPluginPath;
        env.VS_PLUGIN_PATH = PATHS.vsPluginPath;
    } else {
        // LEGACY runtime/ STANDALONE layout: explicit home + site-packages.
        env.PYTHONHOME = PATHS.pythonHome;
        const sitePackages = path.join(PATHS.pythonHome, 'lib', 'python3.11', 'site-packages');
        env.PYTHONPATH = `${sitePackages}:${env.PYTHONPATH || ''}`;
        env.VS_PLUGIN_PATH = PATHS.vsPluginPath;
        const vsLibPath = path.join(sitePackages, 'vapoursynth');
        if (fs.existsSync(vsLibPath)) {
            env.DYLD_LIBRARY_PATH = `${vsLibPath}:${env.DYLD_LIBRARY_PATH || ''}`;
            env.PATH = `${path.dirname(PATHS.ffmpeg)}:${path.join(PATHS.pythonHome, 'bin')}:${env.PATH}`;
        } else {
            send('log', { type: 'warn', message: `Could not locate VapourSynth dylib path at ${vsLibPath}. 'import vapoursynth' may fail.` });
        }
    }

    env.PYTHONUNBUFFERED = '1';
    env.OMP_NUM_THREADS = '1'; // Prevent thread contention in UI apps

    let child;
    try {
        // Spawn Python and pipe the script to stdin
        child = spawn(PATHS.python, ['-'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
        complete(-1, `Spawn Error: ${e.message}`);
        return;
    }

    let errorBuffer = '';
    let pipeError = null;
    // spawn failures are asynchronous; a try/catch around spawn is insufficient.
    child.on('error', error => {
      if (!child.pid) complete(-1, `Spawn Error: ${error.message}`);
      else {
        // A failed control operation is not evidence that a live child stopped.
        pipeError = pipeError || `Process Error: ${error.message}`;
        send('log', { type: 'error', message: `Process state is unconfirmed: ${error.message}` });
      }
    });
    const failPipe = error => {
      if (finished || pipeError) return;
      pipeError = `Pipe Error: ${error.message}`;
      send('log', { type: 'error', message: pipeError });
      try { child.stdin.destroy(); } catch { /* best effort */ }
      // Only this retained child is stopped. Completion follows its close event.
      try { child.kill('SIGKILL'); } catch (terminationError) {
        send('log', { type: 'error', message: `Process termination is unconfirmed: ${terminationError.message}` });
      }
    };
    child.stdin.on('error', failPipe);

    child.stdout.on('data', (data) => {
        send('log', { type: 'info', message: data.toString().trim() });
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        // VapourSynth outputs frame progress to stderr, capturing it as info
        // Standardize output for renderer regex
        if (msg.startsWith('Frame:')) {
             send('log', { type: 'info', message: msg });
        } 
        else if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('traceback')) {
             errorBuffer += msg + '\n';
             send('log', { type: 'error', message: msg });
        } else {
             send('log', { type: 'runtime', message: msg });
        }
    });

    child.on('close', (code) => {
        const resultCode = pipeError ? -1 : code;
        if (!complete(resultCode, pipeError || (code === 0 ? undefined : errorBuffer))) return;
        send('log', { type: resultCode === 0 ? 'success' : 'error', message: `Process exited with code ${resultCode}` });
    });

    try {
        // Write the user's script to the Python process
        child.stdin.end(scriptContent);
    } catch (e) {
         failPipe(e);
    }
  });

  // ----- v2.0 OFX-popout IPC stubs -----
  // Wired to a real XPC service in Phase 2; for now these resolve with placeholders
  // so the renderer's preload contract is satisfied and the UI can develop in isolation.
  ipcMain.handle('request-frame', async (_event, _timecode) => {
    return { stub: true, note: 'IOSurface frame share lands in Phase 2' };
  });
  // Preview chain → render in OFX plugin → response PNG. Atomic write on the OFX side
  // so we never see a half-written file. We rely on file mtime to detect a new render.
  ipcMain.handle('preview-chain', async (event, payload) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted sender: preview is available only to its own editor window.' };
    }
    if (manualHostApply) return { ok: false, error: 'Native preview is unavailable in this build; no request was dispatched.' };
    if (!previewRequestPath || !previewResponsePath) {
      return { ok: false, error: 'Preview unavailable (no --preview-*-path args). Open via Resolve\'s Configure button.' };
    }
    try {
      const reqJson = JSON.stringify({
        chain: typeof payload?.chain === 'string' ? payload.chain : JSON.stringify(payload?.chain ?? {}),
        mix: typeof payload?.mix === 'number' ? payload.mix : 1.0,
        timecode: typeof payload?.timecode === 'number' ? payload.timecode : 0,
        requestId: 'prv-' + Date.now().toString(36),
      });
      const beforeMtime = fs.existsSync(previewResponsePath)
        ? fs.statSync(previewResponsePath).mtimeMs : 0;
      // Direct overwrite — NOT write+rename. The OFX-side PreviewService opens
      // the request file with O_RDONLY at startup and watches its fd via
      // dispatch_source (DISPATCH_SOURCE_TYPE_VNODE). A write+rename leaves
      // the old inode orphaned and the watcher never fires, so the request
      // is never seen → preview times out at 20 s. Direct write triggers the
      // DISPATCH_VNODE_WRITE event the watcher is bound to.
      fs.writeFileSync(previewRequestPath, reqJson, { encoding: 'utf8' });

      // Poll for the response PNG to update. ~20 s timeout — heavy filters can be slow.
      const startedAt = Date.now();
      const deadline = startedAt + 20_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(previewResponsePath)) {
          const mt = fs.statSync(previewResponsePath).mtimeMs;
          if (mt > beforeMtime) {
            return {
              ok: true,
              path: previewResponsePath,
              mtime: mt,
              elapsedMs: Date.now() - startedAt,
            };
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return { ok: false, error: 'Preview render timed out after 20s' };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Read the latest preview PNG as a data URL for the renderer's <img>/<canvas>.
  // file:// URLs are blocked under contextIsolation; reading + sending base64 is the
  // robust path. ~MB-class buffers are fine for IPC.
  ipcMain.handle('read-preview-image', async () => {
    if (manualHostApply) return { ok: false, error: 'Native preview is unavailable in this build.' };
    if (!previewResponsePath || !fs.existsSync(previewResponsePath)) {
      return { ok: false, error: 'no preview yet' };
    }
    try {
      const buf = fs.readFileSync(previewResponsePath);
      if (buf.length === 0) return { ok: false, error: 'preview is 0 bytes' };
      const b64 = buf.toString('base64');
      return { ok: true, dataUrl: 'data:image/png;base64,' + b64, bytes: buf.length };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  // Both modes request the same configuration-file write. close=true also
  // schedules the existing window-close callback. Replies report this companion
  // operation only; they do not acknowledge an OFX apply, render or window closure.
  ipcMain.handle('apply-config', async (event, config, options = {}) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted sender: configuration writes are available only to their own editor window.', writePhase: 'not-attempted', closeScheduled: false };
    }
    const close = options?.close !== false;  // default true for backward compat
    console.log('[apply-config]',
      close ? 'ACCEPT' : 'live-sync',
      '— chain steps:', config?.chain?.length ?? 0,
      '· archivist messages:', config?.archivist?.messages?.length ?? 0);
    if (config) latestConfig = config;  // keep the agentic-tools snapshot fresh

    if (!resultPath) {
      // This companion session has no host result target (e.g. standalone dev).
      return { ok: true, writePhase: 'no-host-path', closeScheduled: false,
        note: 'no --result-path set, dev mode' };
    }
    if (manualHostApply && !close) return { ok: true,
      writePhase: 'editor-only', closeScheduled: false,
      note: pendingRecoveryRequired ? 'The prior pending result is retained. Use Save and close explicitly to publish these edits.'
        : 'Edits remain in this editor. Use Save and close to publish a pending file for Resolve.' };
    let writePhase = 'not-attempted';
    let closeScheduled = false;
    try {
      // Manual-host sessions publish a complete, correlated pending revision.
      // The OFX Apply action sees either the old complete file or this one.
      // Save failures must be actionable (live Oct 27: the generic text hid
      // the actual cause): name the exact validation problem.
      if (manualHostApply && !hostSessionId) {
        throw new Error('No host session id — this companion was not launched from a Configure press.');
      }
      if (manualHostApply) {
        const problem = describeManualHostConfigProblem(config);
        if (problem) {
          throw new Error(`The saved configuration is not publishable: ${problem}. Nothing was written; fix the chain and Save again.`);
        }
      }
      if (manualHostApply && !pendingRecoveryRequired) {
        const previous = readManualHostResult();
        if (previous) resultRevision = Math.max(resultRevision, previous.revision);
      }
      if (manualHostApply && resultRevision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('This session cannot publish another revision. Reopen Configure.');
      }
      const serialized = JSON.stringify(manualHostApply
        ? { sessionId: hostSessionId, revision: ++resultRevision, config } : config);
      if (manualHostApply && Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024) {
        throw new Error('Configuration exceeds the host exchange limit of 8 MiB.');
      }
      writePhase = 'unconfirmed';
      if (manualHostApply) {
        const pending = resultPath + '.pending-' + crypto.randomUUID();
        // wx refuses a leftover/competing publication. Failure remains unknown;
        // no deletion of an entry whose creation was not confirmed here.
        fs.writeFileSync(pending, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(pending, resultPath);
      } else {
        fs.writeFileSync(resultPath, serialized, { encoding: 'utf8' });
      }
      writePhase = 'write-reported';
      if (manualHostApply) pendingRecoveryRequired = false;
      if (close) {
        // Closing is scheduled only after the companion reports publication.
        // The explicit host Apply action is still required for manual sessions.
        setTimeout(() => {
          BrowserWindow.getAllWindows().forEach(w => w.close());
        }, 220);
        closeScheduled = true;
      }
      return { ok: true, writePhase, closeScheduled };
    } catch (e) {
      console.error('[apply-config] write failed:', e.message);
      return { ok: false, error: e?.message || String(e), writePhase, closeScheduled };
    }
  });
  ipcMain.handle('get-clip-metadata', async () => {
    return {
      width: 1920, height: 1080, fps: 23.976,
      isInterlaced: false, colorSpace: 'Rec.709',
      stub: true,
    };
  });

  // ----- Archivist streaming bridge (Anthropic) -----
  // Per TKT-A4 the full agentic + MCP build-out lands later; this is the streaming
  // text path with a single high-value tool — propose_chain_edit — that lets the
  // Archivist write Script steps directly into the user's chain. Multi-vendor
  // dispatch is still TKT-A5.
  // inflightArchivistStreams removed — was Anthropic-SDK-specific. Multi-vendor abort
  // is plumbed via the dispatcher's onError callbacks for now; per-provider
  // AbortController wiring is a TKT-A4 follow-up.

  // The one tool exposed for now: lets the model edit the chain directly.
  // Operations: add | update | remove. The system prompt tells the model to prefer
  // `update` with an existing step's id when modifying — that's the fix for the
  // "asking for a change creates a whole new script" complaint.
  const ARCHIVIST_TOOLS = [{
    name: 'propose_chain_edit',
    description: 'Modify the user\'s filter chain. Add new steps, update existing steps in '
      + 'place, or remove them. The user sees a confirmation card in the assistant message '
      + 'with the proposed operations and either applies all of them or dismisses. Use this '
      + 'INSTEAD of writing VapourSynth code in chat — code in chat has no path into the chain. '
      + 'When the user asks for a change to an existing step, use op:"update" with that step\'s '
      + 'target_id — DO NOT add a duplicate step. The result includes renderVerification: the '
      + 'actual VapourSynth evaluation verdict from the next render/preview. If its state is '
      + '"chain-error", the chain is NOT running (frames pass through untouched) — read the '
      + 'error, fix the script, and re-apply in this same turn. Never report success to the '
      + 'user while renderVerification says chain-error.',
    input_schema: {
      type: 'object',
      properties: {
        explanation: {
          type: 'string',
          description: 'One or two sentences in plain text describing what changes you\'re '
            + 'proposing and why. Shown above the confirm card.'
        },
        operations: {
          type: 'array',
          description: 'Ordered list of operations. Stage-sort is applied automatically unless '
            + 'the user has Manual Order on.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['add', 'update', 'remove'],
                description: 'add = new step; update = modify existing step (requires target_id); '
                  + 'remove = delete existing step (requires target_id).'
              },
              target_id: {
                type: 'string',
                description: 'For update/remove: the id of the existing step to modify. Reference '
                  + 'the IDs listed in "Current chain state" in the system prompt.'
              },
              step: {
                type: 'object',
                description: 'For add: the new step descriptor.',
                properties: {
                  type: { type: 'string', enum: ['script'], description: 'v2.0 only supports "script".' },
                  stage: { type: 'integer', description: '10/20/30/40/50/60/70/80/90 per canonical pipeline.' },
                  label: { type: 'string' },
                  code: { type: 'string', description: 'Python that mutates `clip`. MUST include rich teaching comments above every parameter cluster.' },
                },
                required: ['type', 'stage', 'code'],
              },
              code: {
                type: 'string',
                description: 'For update: the new code body. MUST include rich teaching comments. '
                  + 'When updating, you may rewrite the script body wholesale (e.g. add new params, '
                  + 'change preset) — comments should reflect the new choices.'
              },
              stage: { type: 'integer', description: 'For update: new stage (optional — only if the operation type changed).' },
              label: { type: 'string', description: 'For update: new label (optional).' },
            },
            required: ['op'],
          },
        },
      },
      required: ['operations'],
    },
  }];

  // API keys are entered in Provider Settings and resolved only from Keychain.

  // Registry executor shared by the MCP server and the Archivist's agentic loop.
  const executeRegistryTool = toolRegistry.createExecutor({
    getLatestConfig: () => latestConfig,
    getStatusPath: () => statusPath,
  });

  // ---- Runtime plugin availability (the honest manifest) ----
  // The static manifest overclaimed (live: a chain referencing fft3dfilter —
  // listed as installed, never registered — was refused). The renderer
  // probes the REAL registered set once per run and reconciles the Filter
  // Library badges + the Archivist prompt manifest against it.
  ipcMain.handle('plugin:probe-namespaces', async () => {
    const result = await probeNamespaces();
    if (result.namespaces) {
      return { ok: true, namespaces: result.namespaces, probedAt: result.at };
    }
    return { ok: false, error: result.error || 'probe unavailable' };
  });

  // ---- Optional neural-model manager (explicit, cancellable, in-app) ----
  const broadcastToRenderer = (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
  };
  registerModelManager(ipcMain, broadcastToRenderer);
  // Portable, identity-free recipe store (chain-only; never nodeGuid/source/chat).
  registerRecipeHandlers(ipcMain);

  // ONE authoritative neural-capability snapshot: Models UI, chatbot tools
  // and the app reference all read this (never a divergent claim). Level
  // ladder: weights → adapter → backend → load → inference ("usable" ONLY
  // at inference-verified).
  ipcMain.handle('models:capability', async () => capabilitySnapshot());

  // Chat export: OS save dialog; writes exactly the provided contents.
  ipcMain.handle('app:save-text-file', async (event, request) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender: file saves are available only to their own editor window.' };
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: 'no window' };
      const { filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(os.homedir(), 'Documents',
          String(request?.defaultName ?? 'export.txt').replace(/[^\w.-]+/g, '-')),
        filters: request?.defaultName?.endsWith('.md')
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : undefined,
      });
      if (!filePath) return { ok: false, error: 'cancelled' };
      fs.writeFileSync(filePath, String(request?.contents ?? ''), 'utf8');
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- Companion chain preview (manual-host sessions) ----
  // Renders frames of the HOST'S composed script (last-composed.vpy — the
  // exact script the node evaluates on every render) via the bundled
  // renderer: processed (chain result) and source (pre-chain) for A/B.
  // The native PreviewService path stays authoritative for non-manual host
  // sessions; this IPC exists so manual-host sessions get a real preview
  // instead of the old 'unavailable in this build' placeholder.
  ipcMain.handle('preview:render-frame', async (event, request) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Untrusted sender: preview rendering is available only to its own editor window.' };
    }
    const frame = Number.isInteger(request?.frame) ? request.frame : 0;
    const time = Number.isFinite(request?.time) ? request.time : undefined;
    const mode = request?.mode === 'source' ? 'source' : 'processed';
    const sar = typeof request?.sar === 'string' ? request.sar : undefined;
    const nodeGuid = typeof request?.nodeGuid === 'string' ? request.nodeGuid : undefined;
    // draftScript: the CURRENT editor chain composed by the renderer through
    // shared/draft-composer (exact native mirror). Present when the caller
    // wants the DRAFT preview (live WYSIWYG); absent = accepted-chain preview.
    const draftScript = typeof request?.draftScript === 'string' ? request.draftScript : undefined;
    // Native-depth scope metrics are computed in the render worker ONLY when
    // the Scopes panel is open (scopes work stops when scopes are off).
    const scopes = request?.scopes === true;
    // RGB analysis convention: the node's configured input matrix is the
    // CONTROLLED assumption for sources that leave _Matrix unspecified.
    const analysisMatrix = typeof request?.analysisMatrix === 'string' ? request.analysisMatrix : undefined;
    // Metrics-only refreshes ride a SEPARATE worker process (never block frames).
    const metricsWorker = request?.metricsWorker === true;
    // The preview boundary validates explicit budgets; preserve invalid values
    // so callers receive a visible error rather than an implicit default.
    const timeoutMs = request?.timeoutMs;
    const maxOutputBytes = request?.maxOutputBytes;
    const maxPngBytes = request?.maxPngBytes;
    return renderPreviewFrame({ frame, time, mode, sar, nodeGuid, draftScript, scopes, analysisMatrix, metricsWorker, timeoutMs, maxOutputBytes, maxPngBytes });
  });

  // Read the host's composed script verbatim (the Script view's source).
  // NODE-SPECIFIC: prefers the per-GUID copy the host writes
  // (nodes/<guid>.vpy) so the view can never show another node's script;
  // the global file is a legacy fallback only.
  ipcMain.handle('plugin:read-composed-script', (_event, request) => {
    try {
      const dir = path.join(os.homedir(), 'Library/Application Support/VapourSynth-OFX');
      const requestedGuid = request?.nodeGuid;
      const guid = typeof requestedGuid === 'string' && /^[\w-]+$/.test(requestedGuid)
        ? requestedGuid : null;
      // A node-specific request must never adopt another node's global script.
      if (requestedGuid != null) {
        if (!guid) return '';
        const nodePath = path.join(dir, 'nodes', `${guid}.vpy`);
        return fs.existsSync(nodePath) ? fs.readFileSync(nodePath, 'utf8') : '';
      }
      const composed = path.join(dir, 'last-composed.vpy');
      if (!fs.existsSync(composed)) return '';
      return fs.readFileSync(composed, 'utf8');
    } catch { return ''; }
  });

  // ---- Post-edit render verification (the self-healing signal) ----
  // A chain edit that composes fine can still die at VS evaluation (the live
  // a live client session's "name 'havs' is not defined" failed exactly once, got
  // cached, and every later render silently served passthrough). Both the OFX
  // render path and the popout's auto-preview write a status JSON after each
  // evaluation — so after applying an edit we wait for the NEXT status write
  // and hand its verdict back to whoever made the edit (MCP client or the
  // Archivist's tool loop), which can then repair the chain instead of
  // assuming success.
  const readStatusSnapshot = () => {
    if (!statusPath || !fs.existsSync(statusPath)) return null;
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      return raw.trim() ? JSON.parse(raw) : null;
    } catch { return null; }
  };
  const statusMtime = () => {
    try { return statusPath ? fs.statSync(statusPath).mtimeMs : 0; } catch { return 0; }
  };
  async function verifyAfterChainEdit(baselineMtimeMs, timeoutMs = 6000) {
    if (!statusPath) {
      return { state: 'unverified', note: 'no status path — popout not launched from Resolve' };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (statusMtime() > baselineMtimeMs) {
        const s = readStatusSnapshot();
        if (s) {
          return {
            state: s.state,
            error: s.error || null,
            stepCount: s.stepCount ?? null,
            note: s.state === 'chain-error'
              ? 'VS evaluation FAILED — fix the reported error and re-apply; do not assume the chain is running'
              : undefined,
          };
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return {
      state: 'unverified',
      note: `no fresh render/preview within ${timeoutMs}ms — trigger a preview or move the playhead, then check get_plugin_status`,
    };
  }

  ipcMain.handle('archivist:send', async (event, { messages, system, modelId }) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender: provider dispatch is available only to its own editor window.' };
    const requestId = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Strip pendingAction (UI-only) before forwarding to the provider. We pass the
    // user/assistant text only; tool_use blocks from prior turns are intentionally
    // omitted — chain state is re-injected into the system prompt every turn, and
    // the agentic loop (Anthropic) now feeds real tool_results back mid-turn.
    const apiMessages = (messages || []);

    // propose_chain_edit keeps its renderer confirm-card/auto-apply flow; the
    // registry tools (probe_source, get_chain_state, get_plugin_status,
    // render_sample) execute in the main process. Only Anthropic runs the loop.
    const tools = [...ARCHIVIST_TOOLS, ...toolRegistry.TOOL_DEFINITIONS];

    // Agentic executor: called by the Anthropic loop for each tool_use block.
    // Returns the string that becomes the tool_result content.
    const executeAgentTool = async (name, input, meta = {}) => {
      if (name === 'propose_chain_edit') {
        // Delegate to the renderer (single implementation of chain edits) and
        // await its ack so the model learns whether the edit was auto-applied
        // or parked behind a confirm card.
        const editId = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const statusBaseline = statusMtime();
        const ack = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingToolBridges.delete(editId);
            resolve({ outcome: 'delivered (no UI ack within 12s)' });
          }, 12_000);
          pendingToolBridges.set(editId, (result) => {
            clearTimeout(timer);
            pendingToolBridges.delete(editId);
            resolve(result);
          });
        });
        event.sender.send('archivist:tool-use', {
          requestId,
          editId,
          toolUseId: meta.toolUseId,
          name,
          input,
        });
        const result = await ack;
        // Self-healing signal: wait for the next render/preview status write
        // and report the VS evaluation verdict alongside the UI outcome. On
        // chain-error the model is expected to fix and re-apply within the
        // same turn (it has tool iterations left for exactly this).
        if (result.outcome === 'auto-applied' || /applied/.test(String(result.outcome || ''))) {
          result.renderVerification = await verifyAfterChainEdit(statusBaseline);
        }
        return JSON.stringify(result);
      }
      const result = await executeRegistryTool(name, input);
      return JSON.stringify(result);
    };

    llm.streamChat({
      modelId,
      messages: apiMessages,
      system,
      tools,
      executeAgentTool,
      getApiKey: keychain.getApiKey,
      getEndpoint: async (pid) => keychain.getEndpoint(pid),
      callbacks: {
        onChunk: (text) => event.sender.send('archivist:chunk', { requestId, text }),
        onToolUse: (p) => event.sender.send('archivist:tool-use', {
          requestId,
          toolUseId: p.toolUseId,
          name: p.name,
          input: p.input,
        }),
        onToolActivity: (p) => event.sender.send('archivist:tool-activity', { requestId, ...p }),
        onComplete: () => event.sender.send('archivist:complete', { requestId }),
        onError: (err) => event.sender.send('archivist:error', { requestId, error: err }),
      },
    });

    return { requestId };
  });

  // Renderer acks a bridged tool call (propose_chain_edit from the agentic loop,
  // or apply_chain_edit from an MCP client).
  ipcMain.on('archivist:tool-ack', (_event, { editId, ...result }) => {
    const resolve = pendingToolBridges.get(editId);
    if (resolve) resolve(result);
  });

  // --- Keychain / providers IPC for the Settings modal ---
  ipcMain.handle('keychain:has-api-key', async (_e, { providerId }) =>
    keychain.hasApiKey(providerId));
  ipcMain.handle('keychain:set-api-key', async (event, { providerId, key }) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender: credential changes are available only to their own editor window.' };
    await keychain.setApiKey(providerId, key);
    return { ok: true };
  });
  ipcMain.handle('keychain:list-configured', async () =>
    keychain.listConfiguredProviders());
  ipcMain.handle('keychain:set-endpoint', async (event, { providerId, url }) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender: endpoint changes are available only to their own editor window.' };
    keychain.setEndpoint(providerId, url);
    return { ok: true };
  });
  ipcMain.handle('keychain:get-endpoint', async (_e, { providerId }) =>
    keychain.getEndpoint(providerId));
  ipcMain.handle('providers:list', async () => {
    // Strip non-serializable fields if any. Currently all values are plain — return as-is.
    return llm.providers;
  });

  // Plugin status snapshot — the OFX plugin writes a JSON file after each render.
  // Renderer polls this to surface the state (passthrough / chain-ok / chain-error)
  // and any error message in a banner at the top of the popout.
  ipcMain.handle('plugin:read-status', async () => {
    if (!statusPath || !fs.existsSync(statusPath)) {
      return { ok: false, error: 'no status path' };
    }
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      if (!raw.trim()) return { ok: false, error: 'status empty' };
      return { ok: true, status: JSON.parse(raw) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Clip metadata has two layers:
  //   1. `timeline` (auto): OFX clip API gives us the timeline-conformed delivery
  //      props on every Configure click. Injected by the C++ side. No user gesture.
  //   2. `source` (opt-in): user identifies the source file once (drag-drop or picker).
  //      ffprobe runs, we cache the digest + filePath in NodeConfig. From then on
  //      every Configure auto-re-probes the file (only if it still exists).
  ipcMain.handle('clip:pick-file', async () => {
    const windows = BrowserWindow.getAllWindows();
    const parent = windows[0] || undefined;
    const result = await dialog.showOpenDialog(parent, {
      title: 'Identify source clip file',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: [
          'mov', 'mp4', 'm4v', 'mkv', 'mxf', 'avi', 'wmv', 'webm',
          'dv', 'mts', 'm2ts', 'ts', 'vob', 'r3d', 'braw', 'arri', 'mlv',
          'exr', 'dpx', 'tiff', 'tif',
        ]},
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, filePath: result.filePaths[0] };
  });

  ipcMain.handle('clip:probe', async (event, { filePath }) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender: source probing is available only to its own editor window.' };
    // Aggregation (ffprobe + idet + mediainfo + chunk hash) lives in
    // tools/registry.js now — the same probe serves this IPC handler, the MCP
    // server's probe_source, and the Archivist's agentic probe_source tool.
    // See registry.probeSourceAggregate for the per-source rationale comments.
    try {
      return await toolRegistry.probeSourceAggregate(filePath);
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Auto-discover the source file path of the clip at Resolve's current playhead
  // via the DaVinci Resolve Python scripting API. Works zero-gesture when the user
  // has enabled scripting in Preferences. Falls back cleanly otherwise.
  ipcMain.handle('resolve:query-current-clip', async () => {
    return resolveApi.queryCurrentClip();
  });

  // Abort plumbing is intentionally a no-op for now. With the multi-vendor dispatcher
  // we don't hold provider-specific stream handles in this map anymore; a proper
  // abort needs per-provider AbortController integration (TKT-A4 follow-up).
  ipcMain.on('archivist:abort', (_event, _requestId) => {});

  // ----- Local MCP server (agentic access for external clients) -----
  // apply_chain_edit round-trips through the renderer so MCP edits share the
  // exact chain-ops implementation (stage sort, id allocation) the UI uses.
  // SECURITY (security review #3, 2026-11-05): the server enforces a per-launch
  // bearer token; the registration command (with the token) is logged here so
  // the user can configure their MCP client of choice.
  startMcpServer({
    toolDefinitions: toolRegistry.TOOL_DEFINITIONS,
    execute: executeRegistryTool,
    requestChainEdit: (payload) => new Promise((resolve) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) {
        resolve({ ok: false, error: 'popout window not open' });
        return;
      }
      const editId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const statusBaseline = statusMtime();
      const timer = setTimeout(() => {
        pendingToolBridges.delete(editId);
        resolve({ ok: false, error: 'renderer did not ack the edit within 12s' });
      }, 12_000);
      pendingToolBridges.set(editId, (result) => {
        clearTimeout(timer);
        pendingToolBridges.delete(editId);
        // Attach the VS-evaluation verdict from the next render/preview so MCP
        // clients see chain-error instead of a silently-passthrough success.
        verifyAfterChainEdit(statusBaseline).then((renderVerification) => {
          resolve({ ok: true, ...result, renderVerification });
        });
      });
      win.webContents.send('mcp:chain-edit', {
        editId,
        operations: payload?.operations ?? [],
        explanation: payload?.explanation,
      });
    }),
  }).then((mcp) => {
    // security review #3 + re-review: surface the registration command. The
    // TOKEN ITSELF is only printed when VSRES_MCP_LOG_TOKEN=1 (re-review
    // finding: the log carries the same capability as an authorized client;
    // default logs must not leak it). The token remains available on `mcp`
    // for a future settings-UI surface.
    // POSTURE DECISION (2026-11-11, security review #5 remainder): the opt-in
    // deliberately prints the FULL registration command — it is today's only
    // path to register an external MCP client. The gate is explicit, the
    // token rotates every launch, and output is local stdout only. The
    // default (unset) branch never prints it.
    if (mcp) {
      if (process.env.VSRES_MCP_LOG_TOKEN === '1') {
        console.log('[mcp] NOTE: the next line contains a LIVE registration credential for THIS LAUNCH ONLY — do not paste it into shared logs or tickets.');
        console.log(`[mcp] client registration (this launch):\n  claude mcp add --transport http vapoursynth-restoration --header "Authorization: Bearer ${mcp.token}" http://127.0.0.1:${mcp.port}/mcp`);
      } else {
        console.log(`[mcp] MCP server ready on http://127.0.0.1:${mcp.port}/mcp — the per-launch bearer token is NOT logged by default; relaunch with VSRES_MCP_LOG_TOKEN=1 to print the registration command.`);
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// When spawned by the OFX plugin the popout is a one-shot per Configure click —
// quit on close regardless of platform so subsequent clicks get a fresh process.
app.on('window-all-closed', () => {
  app.quit();
});
