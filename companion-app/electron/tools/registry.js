// Shared tool registry — the single source of truth for agentic capabilities.
//
// The same definitions + executors feed two consumers (mirroring the pattern in
// firstcut_v3's editorialMcpServer):
//   1. The Archivist's agentic loop (electron/llm/anthropic.js) — Claude tool format.
//   2. The local MCP server (electron/services/mcpServer.js) — MCP inputSchema is the
//      same JSON Schema, just exposed under the camelCase key.
//
// `propose_chain_edit` is NOT here — it stays a bespoke UI-bridged tool in main.js
// because its execution is the renderer's confirm-card / auto-apply flow. Everything
// in this file executes entirely in the main process.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const probe = require('../probe');

// Longest sample we will render in one tool call. Samples are meant to be quick
// iteration, not deliverables — a full render goes through the normal pipeline.
const MAX_SAMPLE_SEC = 30;
const SAMPLE_OUTPUT_EXISTS = 'output already exists; choose a new outputPath';
const SAMPLE_RUN_MS = 10 * 60 * 1000;
const SAMPLE_STOP_GRACE_MS = 2000;
const SAMPLE_CLOSE_GRACE_MS = 2000;
const SAMPLE_DIAGNOSTIC_BYTES = 8192;

function sampleDiagnostic() {
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      const incoming = Math.min(bytes.length, SAMPLE_DIAGNOSTIC_BYTES);
      const prior = Math.min(tail.length, SAMPLE_DIAGNOSTIC_BYTES - incoming);
      // Copy only retained suffixes: no view can pin a huge incoming buffer.
      const next = Buffer.alloc(prior + incoming);
      tail.copy(next, 0, tail.length - prior);
      bytes.copy(next, prior, bytes.length - incoming);
      tail = next;
    },
    text: () => tail.toString('utf8'),
    info: () => ({ totalBytes, retainedBytes: tail.length,
      discardedBytes: totalBytes - tail.length, truncated: totalBytes > tail.length }),
  };
}

// Stage playbooks — the pipeline block diagram as agent-usable skills. Shared
// JSON so the renderer's PipelinePanel teaching layer and this tool never drift.
const STAGE_PLAYBOOKS = require('../../shared/stage-playbooks.json');

// ---------------------------------------------------------------------------
// probe_source aggregation — extracted from main.js's clip:probe handler so the
// IPC handler, the MCP server, and the Archivist all run the identical probe.
// ---------------------------------------------------------------------------
async function probeSourceAggregate(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'filePath required' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'file not found', missing: true };
  }
  let integrity = null;
  let integrityError = null;
  try {
    integrity = probe.hashFileChunks(filePath);
  } catch (e) {
    integrityError = e?.message || String(e);
    console.warn('[probe_source] hash failed:', integrityError);
  }

  const [metadata, fieldDetection, mi] = await Promise.all([
    probe.probeFile(filePath),
    probe.analyzeFields(filePath).catch((e) => ({ ok: false, error: e?.message || String(e) })),
    probe.analyzeMediaInfo(filePath).catch((e) => ({ ok: false, error: e?.message || String(e) })),
  ]);
  if (metadata && integrity) {
    metadata.sourceHash    = integrity.hash;
    metadata.sourceSize    = integrity.size;
    metadata.sourceMtimeMs = integrity.mtimeMs;
  }
  if (metadata && metadata.video && fieldDetection?.ok) {
    metadata.video.detectedScanType = fieldDetection.detected;
    metadata.video.scanConfidence   = fieldDetection.confidence;
    metadata.video.scanBreakdown    = fieldDetection.breakdown;
  }
  if (metadata && metadata.video && mi?.ok) {
    metadata.video.mediainfo = {
      scanType:          mi.scanType,
      scanOrder:         mi.scanOrder,
      scanTypeOriginal:  mi.scanTypeOriginal,
      scanOrderOriginal: mi.scanOrderOriginal,
      format:            mi.format,
      formatProfile:     mi.formatProfile,
      codecId:           mi.codecId,
    };
  }
  return { ok: true, metadata, integrityError };
}

// ---------------------------------------------------------------------------
// render_sample — standalone engine validation without Resolve. Spawns a system
// Python that can import VapourSynth (see findSamplePython), composes a recipe
// script, and pipes y4m into ffmpeg → ProRes HQ .mov.
// ---------------------------------------------------------------------------
function findSamplePython() {
  const candidates = [
    process.env.VSRES_SAMPLE_PYTHON,
    '/opt/homebrew/opt/python@3.14/bin/python3.14',
    '/opt/homebrew/bin/python3.14',
    '/opt/homebrew/bin/python3.13',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const VS_PY_DIR = path.join(os.homedir(), 'Library/Application Support/VapourSynth-OFX/vs-python');
const VS_PLUGIN_DIR = path.join(os.homedir(), 'Library/Application Support/VapourSynth/Plugins');
const DEFAULT_SAMPLE_DIR = path.join(os.homedir(), 'Movies', 'VapourSynth-OFX Samples');

function buildSampleScript({ filePath, mode, tff, preset, startSec, durationSec, rawScript }) {
  const header = `
import os, sys
sys.path.insert(0, ${JSON.stringify(VS_PY_DIR)})
import vapoursynth as vs
core = vs.core
import havsfunc as haf

src = core.lsmas.LWLibavSource(${JSON.stringify(filePath)})
fps = src.fps_num / src.fps_den
start = max(0, int(round(${startSec} * fps)))
count = max(1, int(round(${durationSec} * fps)))
roll = 20  # pre/post-roll for QTGMC temporal radius + srestore cadence lock-in
a = max(0, start - roll)
b = min(src.num_frames, start + count + roll)
work = src[a:b]
lead = start - a  # frames of pre-roll actually available
`;
  const body = {
    // Native-rate interlaced → single-rate progressive. NOT a bob.
    qtgmc_25p: `
fmt = vs.YUV422P16 if work.format.subsampling_w == 1 and work.format.subsampling_h == 0 else vs.YUV420P16
work = core.resize.Point(work, format=fmt)
deint = haf.QTGMC(work, Preset=${JSON.stringify(preset)}, TFF=${tff ? 'True' : 'False'}, FPSDivisor=2,
                  SourceMatch=3, Lossless=0, ThSAD2=96, NoiseProcess=0)
out = deint[lead:lead + count]
`,
    // Blended standards conversion (e.g. PAL→NTSC) → recover original 25p.
    // QTGMC FPSDivisor=1 is the required internal double-rate step, never delivered.
    //
    // SourceMatch=3 is NOT optional: without it QTGMC's interpolated fields drift
    // from the true source fields and srestore's cadence decision lands on the wrong
    // frames — measured 4 combed frames in 750 on this material with it absent, 0 in
    // 7401 with it present.
    //
    // Lossless=0, CORRECTED 2026-08-11 — this shipped as Lossless=2 through v4 and it
    // was wrong. Lossless=2 reinstates the tape's original field lines verbatim among
    // lines that have been motion-compensated and temporally smoothed, and that
    // alternation between original and smoothed rows IS energy at the vertical
    // Nyquist frequency — a stationary comb, invisible at 480 lines and a staircase at
    // 4K. Measured on the reference job: comb ratio 9.09 (Lossless=2) vs 0.85 (Lossless=0) on a
    // static shot; the delivered v4 master measured 8.71 mean / 12.28 worst-frame
    // against v5's 0.79 / 1.18 on the same eight frames. Confirmed NOT a cadence
    // regression: srestore selects the identical frames either way (405-probe
    // alignment check, offset 0 throughout), so this is a pure interpolation-quality
    // fix, not a re-run of the SourceMatch finding above.
    //
    // ThSAD2=96 is the grain correction Lossless=0 alone does not provide. QTGMC's
    // final motion-compensated temporal smooth (TR2) is a denoiser regardless of
    // NoiseProcess, and it was eating a third of the tape's fine texture: the OLD
    // "98.8% grain retained" figure on this material was wrong, computed without
    // regard to direction so the Lossless=2 comb counted as texture and concealed the
    // real loss, which measured 74.2% on the delivered v4 master. ThSAD2=96 makes TR2
    // fussier about which blocks it will average; v5 measures 89.5% on the same
    // frames. Below about ThSAD2=64 the trade overshoots 100%, which is sharpening,
    // not preservation — sweep the value before trusting it elsewhere.
    //
    // NoiseProcess=0 is deliberate on two counts: presets above 'Slower' enable
    // QTGMC's noise processing, which needs fft3dfilter (absent in this arm64
    // plugin set), and altering a tape's grain is wrong for preservation work.
    pal_recover_srestore: `
if work.height == 486:
    work = core.std.Crop(work, top=4, bottom=2)  # 486→480, parity-preserving
fmt = vs.YUV422P16 if work.format.subsampling_w == 1 and work.format.subsampling_h == 0 else vs.YUV420P16
work = core.resize.Point(work, format=fmt)
bob = haf.QTGMC(work, Preset=${JSON.stringify(preset)}, TFF=${tff ? 'True' : 'False'}, FPSDivisor=1,
                SourceMatch=3, Lossless=0, ThSAD2=96, NoiseProcess=0)
rest = haf.srestore(bob, frate=25)
out_count = max(1, int(round(${durationSec} * 25)))
lead25 = int(round(lead * 25.0 / fps))
out = rest[lead25:lead25 + out_count]
`,
    // Escape hatch: caller-provided VS Python operating on `work`, must set `out`.
    raw_script: `
${rawScript || 'out = work'}
`,
  }[mode];

  const footer = `
out = core.resize.Point(out, format=vs.YUV422P10)
print(f"# out: {out.width}x{out.height} {out.fps} {out.num_frames} frames", file=sys.stderr)
out.set_output()
out.output(sys.stdout.buffer, y4m=True)
`;
  return header + body + footer;
}

async function renderSample(input) {
  const {
    filePath,
    mode = 'qtgmc_25p',
    tff = true,
    preset = 'Slower',
    startSec = 10,
    durationSec: requestedSec = 3,
    outputPath,
    rawScript,
  } = input || {};

  // These scalars become Python source. Validate without coercion before any
  // filesystem, executable discovery, output or process effects.
  if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) {
    return { ok: false, error: 'startSec must be a finite number >= 0' };
  }
  if (typeof requestedSec !== 'number' || !Number.isFinite(requestedSec) || requestedSec <= 0) {
    return { ok: false, error: 'durationSec must be a finite number > 0' };
  }
  if (outputPath !== undefined && (typeof outputPath !== 'string' || !outputPath.length || outputPath.includes('\0'))) {
    return { ok: false, error: 'outputPath must be a nonempty local file path' };
  }
  // Model/MCP input cannot grant consent to execute arbitrary Python. Refuse
  // before file access, discovery, staging or spawn until a trusted approval
  // can bind the exact script, source and render arguments.
  if (mode === 'raw_script') {
    return { ok: false, error: 'raw_script sample execution is unavailable: explicit user approval must be bound to the exact script, source and render arguments' };
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: `source file not found: ${filePath}` };
  }
  if (!['qtgmc_25p', 'pal_recover_srestore'].includes(mode)) {
    return { ok: false, error: `unknown mode "${mode}"` };
  }
  // CLAMP, do not fail. Rejecting the whole call over a too-long duration throws
  // away a request the caller can't repair without knowing a limit that was not
  // in the tool schema — an agent just sees an opaque error and retries blind.
  // Clamping does the useful part of the work and reports what it did.
  let durationSec = requestedSec;
  let clampNote = null;
  if (requestedSec > MAX_SAMPLE_SEC) {
    clampNote = `durationSec ${requestedSec} exceeds the ${MAX_SAMPLE_SEC}s sample limit — rendered ${MAX_SAMPLE_SEC}s instead`;
    durationSec = MAX_SAMPLE_SEC;
  }
  let outFile;
  if (outputPath === undefined) {
    const base = path.basename(filePath).replace(/\.[^.]+$/, '');
    outFile = path.join(DEFAULT_SAMPLE_DIR, `${base}_${mode}_${Date.now().toString(36)}.mov`);
  } else {
    outFile = path.resolve(outputPath);
  }
  // Fast refusal includes directories and dangling symlinks. The later atomic
  // link, rather than this precheck, protects against a competing creator.
  try {
    fs.lstatSync(outFile);
    return { ok: false, error: SAMPLE_OUTPUT_EXISTS };
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: `cannot inspect sample output (${e.code || 'unknown error'})` };
  }

  const python = findSamplePython();
  if (!python) {
    return { ok: false, error: 'no VapourSynth-capable python found (set VSRES_SAMPLE_PYTHON)' };
  }
  const ffmpeg = probe.findFfmpeg();
  const script = buildSampleScript({ filePath, mode, tff, preset, startSec, durationSec, rawScript });

  // Keep FFmpeg away from the final path. Same-parent staging keeps publication
  // on one filesystem; unsupported hard links fail without a replacing fallback.
  let stageDir;
  try {
    if (outputPath === undefined) fs.mkdirSync(DEFAULT_SAMPLE_DIR, { recursive: true });
    stageDir = fs.mkdtempSync(path.join(path.dirname(outFile), '.vsres-sample-'));
  } catch (e) {
    return { ok: false, error: `cannot prepare temporary sample output (${e.code || 'unknown error'})` };
  }
  const stagedFile = path.join(stageDir, path.basename(outFile));
  const env = { ...process.env, VAPOURSYNTH_EXTRA_PLUGIN_PATH: VS_PLUGIN_DIR, PYTHONUNBUFFERED: '1' };

  let result;
  let closureKnown = true; // No acquired children until the inline run begins.
  try {
    const run = await new Promise((resolve) => {
      const startedAt = Date.now();
      const states = ['producer', 'writer'].map(name => ({ name, child: null, exited: false,
        closed: false, exitCode: null, exitSignal: null, code: null, signal: null,
        error: null, stopDenied: false, stopError: null, stopRequests: [], log: sampleDiagnostic() }));
      let settled = false;
      let startupFinished = false;
      let signalling = 0;
      let primaryError = null;
      let runTimer = null;
      let stopTimer = null;
      let closeTimer = null;
      const message = e => String(e?.message || e).slice(0, 512);
      const allClosed = () => states.every(s => !s.child || s.closed);

      function finish() {
        if (settled) return;
        settled = true;
        for (const timer of [runTimer, stopTimer, closeTimer]) if (timer !== null) clearTimeout(timer);
        closureKnown = allClosed();
        const pyText = states[0].log.text();
        const ffText = states[1].log.text();
        const ok = !primaryError && closureKnown && states.every(s => s.child && s.code === 0 && !s.signal);
        resolve({ ok, ...(primaryError ? { error: primaryError } : {}), closureKnown,
          ...(!closureKnown ? { retryable: false,
            closureWarning: 'child/stdio closure unconfirmed; do not retry automatically' } : {}),
          elapsedMs: Date.now() - startedAt,
          vsInfo: (pyText.match(/^# .*$/gm) || []).join('\n'),
          ...(!ok ? { vsError: pyText.slice(-1500) || null, ffmpegError: ffText.slice(-500) || null } : {}),
          diagnostics: { maxRetainedBytes: SAMPLE_DIAGNOSTIC_BYTES,
            producer: states[0].log.info(), writer: states[1].log.info() },
          processes: Object.fromEntries(states.map(s => [s.name, { acquired: Boolean(s.child),
            exitObserved: s.exited, exitCode: s.exitCode, exitSignal: s.exitSignal,
            observedExitCode: s.child?.exitCode ?? null, observedSignalCode: s.child?.signalCode ?? null,
            closed: s.closed, code: s.code, signal: s.signal, error: s.error,
            stopDenied: s.stopDenied, stopError: s.stopError,
            stopRequests: s.stopRequests.map(r => ({ ...r })) }])) });
      }
      function maybeFinish() {
        if (!settled && startupFinished && !signalling && allClosed()) finish();
      }
      function stopOwned(signal) {
        for (const s of states) {
          const child = s.child;
          // Exit is distinct from stdio close. Never signal an exited/reused PID.
          if (settled || !child || s.closed || s.exited || child.exitCode != null || child.signalCode != null
            || !Number.isInteger(child.pid) || child.pid <= 0 || s.stopDenied
            || s.stopRequests.some(r => r.signal === signal)) continue;
          const request = { signal, accepted: null };
          s.stopRequests.push(request); signalling++;
          try {
            request.accepted = child.kill(signal) === true;
            if (!request.accepted) {
              s.stopDenied = true;
              s.stopError ||= { signal, code: null, message: 'signal was not sent' };
            }
          } catch (e) {
            request.accepted = false; s.stopDenied = true;
            s.stopError ||= { signal, code: e.code || null, message: message(e) };
          } finally { signalling--; }
        }
        maybeFinish();
      }
      function fail(error) {
        if (settled) return;
        if (!primaryError) {
          primaryError = error;
          // Schedule before signalling so a synchronous close cannot leave a timer.
          stopTimer = setTimeout(() => { if (!settled) stopOwned('SIGKILL'); }, SAMPLE_STOP_GRACE_MS);
          closeTimer = setTimeout(finish, SAMPLE_STOP_GRACE_MS + SAMPLE_CLOSE_GRACE_MS);
          stopOwned('SIGTERM');
        }
        maybeFinish();
      }
      function register(s, child) {
        s.child = child;
        closureKnown = false;
        child.on('error', e => {
          if (settled) return;
          s.error ||= { phase: 'process', code: e.code || null, message: message(e),
            afterStopRequest: s.stopRequests.length > 0 };
          if (s.stopRequests.length) {
            s.stopDenied = true;
            const detail = { signal: s.stopRequests.at(-1).signal, code: e.code || null, message: message(e) };
            if (!s.stopError) s.stopError = detail;
            else if (!s.stopError.code && e.code) s.stopError = { ...detail, initialMessage: s.stopError.message };
          }
          fail(`${s.name} process error: ${message(e)}`);
        });
        child.on('exit', (code, signal) => {
          if (settled) return;
          s.exited = true; s.exitCode = code; s.exitSignal = signal || null;
          if (code !== 0 || signal) fail(s.name === 'writer' && !signal
            ? `render failed (ffmpeg exit ${code})` : `${s.name} exited with ${signal || `code ${code}`}`);
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          s.closed = true; s.code = code; s.signal = signal || null;
          if (code !== 0 || signal) fail(s.name === 'writer' && !signal
            ? `render failed (ffmpeg exit ${code})` : `${s.name} exited with ${signal || `code ${code}`}`);
          maybeFinish();
        });
        for (const name of ['stdout', 'stderr', 'stdin']) {
          const stream = child[name];
          if (!stream) continue;
          stream.on('error', e => {
            if (settled) return;
            s.error ||= { phase: name, code: e.code || null, message: message(e) };
            fail(`${s.name} ${name} error: ${message(e)}`);
          });
        }
        child.stderr?.on('data', chunk => { if (!settled) s.log.append(chunk); });
        return child;
      }

      runTimer = setTimeout(() => fail('sample render timed out'), SAMPLE_RUN_MS);
      let startupPhase = 'producer spawn';
      try {
        const py = register(states[0], spawn(python, ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
        if (!primaryError) {
          startupPhase = 'writer spawn';
          const ff = register(states[1], spawn(ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-n', '-i', 'pipe:',
            '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', stagedFile,
          ], { stdio: ['pipe', 'ignore', 'pipe'] }));
          if (!primaryError) {
            startupPhase = 'pipe';
            if (!py.stdout || !ff.stdin) throw new Error('sample pipe unavailable');
            py.stdout.pipe(ff.stdin);
          }
        }
      } catch (e) { fail(`sample ${startupPhase} error: ${message(e)}`); }
      startupFinished = true;
      maybeFinish();
    });
    result = run;
    if (run.ok) {
      try {
        const staged = fs.lstatSync(stagedFile);
        if (!staged.isFile() || staged.size <= 0) {
          result = { ...run, ok: false, error: 'render produced no regular nonempty sample output' };
        } else {
          fs.linkSync(stagedFile, outFile); // Sole no-replace final publication.
          result = { ...run, outputPath: outFile, mode, tff, preset,
            durationSec, ...(clampNote ? { warning: clampNote } : {}) };
        }
      } catch (e) {
        result = { ...run, ok: false, error: e.code === 'EEXIST' ? SAMPLE_OUTPUT_EXISTS
          : `cannot publish sample output (${e.code || 'unknown error'})` };
      }
    }
  } catch (e) {
    result = { ok: false, error: `sample render failed before completion: ${e.message || String(e)}` };
  } finally {
    const cleanupErrors = [];
    if (!closureKnown) {
      cleanupErrors.push({ operation: 'retain', path: stageDir, code: 'CHILD_CLOSURE_UNKNOWN' });
    } else {
      for (const [operation, target] of [['unlinkSync', stagedFile], ['rmdirSync', stageDir]]) {
        try { fs[operation](target); }
        catch (e) { if (e.code !== 'ENOENT') cleanupErrors.push({ operation, path: target, code: e.code || 'UNKNOWN' }); }
      }
    }
    if (cleanupErrors.length) {
      // Publication success stays success: an ambiguous failure could prompt a
      // duplicate retry. Primary render/publication errors also remain intact.
      result.cleanupWarning = 'temporary sample output cleanup incomplete';
      result.temporaryOutputPath = stagedFile;
      result.cleanupErrors = cleanupErrors;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Definitions (Claude tool format — MCP consumers remap input_schema→inputSchema)
// ---------------------------------------------------------------------------
const TOOL_DEFINITIONS = [
  {
    name: 'probe_source',
    description: 'Probe a media file on disk with ffprobe + ffmpeg-idet (pixel-content field-order '
      + 'scan) + MediaInfo. Returns container metadata AND a pixel-level interlace verdict — the '
      + 'two disagree on real-world tapes (a clip flagged BFF can be TFF at pixel level; trust the '
      + 'idet detection). Call this before recommending deinterlace parameters.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the media file.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'get_chain_state',
    description: 'Return the current NodeConfig snapshot: filter chain steps (id, stage, label, '
      + 'code), color management, and identified source-clip metadata. Use to inspect the chain '
      + 'before proposing edits or to verify an edit landed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_plugin_status',
    description: 'Read the OFX plugin\'s last render status and, when launched from Resolve, the '
      + 'state of the node\'s applied chain. States: "passthrough" (no chain applied on this node), '
      + '"chain-empty"/"chain-disabled"/"chain-awaiting-approval" (chain exists but renders nothing yet), '
      + '"config-applied" (a saved chain was accepted; render unconfirmed), '
      + '"config-apply-refused" (the saved chain did NOT evaluate — the previous chain keeps '
      + 'rendering; read the error, fix the offending step, save again), '
      + '"chain-ok" (a chain actually rendered), "chain-error" (render failed). '
      + 'A refusal stays sticky until a new revision is accepted. After any chain edit, call this '
      + 'to confirm acceptance before telling the user it worked.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_stage_playbook',
    description: 'Retrieve the restoration playbook for one canonical pipeline stage (or all of '
      + 'them) — purpose, when to use, canonical filters, key params, and teaching notes, '
      + 'including the srestore blend-recovery explanation and the PAL→NTSC case study under '
      + 'frame-ops. Consult before designing a chain or explaining a stage to the user; these '
      + 'are the same blocks shown in the Pipeline panel.',
    input_schema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Stage key (preprocess | field-ops | crop | denoise | restore | sharpen | '
            + 'frame-ops | resize | format) or numeric stage (10..90). Omit for all stages.',
        },
      },
    },
  },
  {
    name: 'render_sample',
    description: 'Render a short validation sample from a source file through the real VapourSynth '
      + 'engine, WITHOUT needing Resolve. Modes: "qtgmc_25p" (interlaced → single-rate progressive '
      + 'via QTGMC, no bob), "pal_recover_srestore" (field-blended NTSC standards conversion → '
      + 'recover original PAL 25p via QTGMC double-rate + srestore). Raw-script samples are '
      + 'unavailable. Writes a ProRes HQ .mov and returns its path. '
      + 'Takes seconds to minutes — use short durations (3-10s).',
    input_schema: {
      type: 'object',
      properties: {
        filePath:    { type: 'string',  description: 'Absolute path to the source media file.' },
        mode:        { type: 'string',  enum: ['qtgmc_25p', 'pal_recover_srestore'] },
        tff:         { type: 'boolean', description: 'Field order: true = top-field-first. Use probe_source\'s pixel verdict, not the container flag.' },
        preset:      { type: 'string',  description: 'QTGMC preset. Default "Slower". Use "Fast" for quick iteration.' },
        startSec:    { type: 'number', minimum: 0, description: 'Finite sample start position in seconds, at least 0. Default 10.' },
        durationSec: { type: 'number', exclusiveMinimum: 0, description: 'Finite sample length in seconds, greater than 0. Default 3. Values above 30 are clamped to 30 and reported in the result warning, not rejected.' },
        outputPath:  { type: 'string',  description: 'Optional explicit output .mov path. Defaults to ~/Movies/VapourSynth-OFX Samples/. Existing files, links or directories are never replaced; choose a new path. Publication requires hard-link support on the output filesystem.' },
      },
      required: ['filePath'],
    },
  },
];

// ---------------------------------------------------------------------------
// Executor. `ctx` is injected by main.js:
//   getLatestConfig(): object|null — latest NodeConfig (boot config ⊕ live-sync)
//   getStatusPath(): string|null   — --status-path arg
// ---------------------------------------------------------------------------
function createExecutor(ctx) {
  return async function execute(name, input) {
    switch (name) {
      case 'probe_source':
        return probeSourceAggregate(input?.filePath);

      case 'get_chain_state': {
        const cfg = ctx.getLatestConfig();
        if (!cfg) return { ok: false, error: 'no config yet — popout has not synced' };
        // The companion is NODE-scoped, not playhead-scoped: clip metadata arrives
        // when the popout is launched from a specific OFX node's Configure button.
        // Without a live session the metadata is whatever was last synced, which
        // may describe an entirely different clip — moving the playhead does not
        // update it. Returning that silently is how an agent ends up reasoning
        // about the wrong media, so the staleness is stated rather than implied.
        const live = Boolean(ctx.getStatusPath && ctx.getStatusPath());
        const meta = cfg.clipMetadata ?? null;
        return {
          ok: true,
          chain: cfg.chain ?? [],
          colorManagement: cfg.colorManagement ?? null,
          clipMetadata: meta,
          clipMetadataIsLive: live,
          ...(!live && meta ? {
            warning: 'No popout session is attached, so clipMetadata is the last synced '
              + 'snapshot and may not be the clip currently under the playhead. Launch the '
              + 'popout from the node\'s Configure button in Resolve to bind a live session, '
              + 'or call probe_source with an explicit filePath.',
          } : {}),
          archivistMessageCount: cfg.archivist?.messages?.length ?? 0,
        };
      }

      case 'get_plugin_status': {
        const statusPath = ctx.getStatusPath();
        if (!statusPath || !fs.existsSync(statusPath)) {
          return { ok: false, error: 'no status path — popout not launched from Resolve' };
        }
        try {
          const raw = fs.readFileSync(statusPath, 'utf8');
          if (!raw.trim()) return { ok: false, error: 'status empty' };
          return { ok: true, status: JSON.parse(raw) };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      }

      case 'get_stage_playbook': {
        const want = input?.stage != null ? String(input.stage) : null;
        if (!want) return { ok: true, stages: STAGE_PLAYBOOKS.stages };
        const hit = STAGE_PLAYBOOKS.stages.find(
          s => s.key === want || String(s.stage) === want
        );
        return hit
          ? { ok: true, playbook: hit }
          : { ok: false, error: `unknown stage "${want}" — use preprocess|field-ops|crop|denoise|restore|sharpen|frame-ops|resize|format or 10..90` };
      }

      case 'render_sample':
        return renderSample(input);

      default:
        return { ok: false, error: `unknown tool "${name}"` };
    }
  };
}

module.exports = { TOOL_DEFINITIONS, createExecutor, probeSourceAggregate, renderSample };
