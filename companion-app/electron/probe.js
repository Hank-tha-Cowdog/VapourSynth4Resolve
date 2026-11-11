// ffprobe wrapper. Runs ffprobe against a media file, parses the JSON output,
// digests it into a stable shape we can attach to the OFX node's config so the
// Archivist sees material-aware context every turn going forward.
//
// Packaged apps require their provisioned helper outside ASAR. Development
// keeps the explicit FFPROBE_BIN override and machine/PATH fallbacks.

const { spawn } = require('child_process');
const { existsSync, statSync, openSync, readSync, closeSync } = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveRuntimes } = require('./prod-paths');
const { runProbeProcess } = require('./probe-process');

// Provisional interactive budgets, not measured media or format maxima. Callers
// may explicitly raise timeoutMs/maxOutputBytes and supply an AbortSignal.
const METADATA_BUDGET = { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 * 1024 };
function processFailure(result) {
  return { ok: false, error: result.error, reason: result.reason,
    closed: result.closed === true, cleanupUnconfirmed: result.cleanupUnconfirmed === true,
    noAutomaticReplay: true, stopError: result.stopError || null };
}


function findFfprobe(options = {}) {
  let packaged = options.packaged === true;
  let resourcesPath = options.resourcesPath || process.resourcesPath;
  // Electron's actual launch mode wins over the Node-only fixture seam.
  // Never turn a failed Electron mode lookup into development fallback.
  if (process.versions.electron) {
    const { app } = require('electron');
    if (!app || typeof app.isPackaged !== 'boolean') {
      throw new Error('Cannot determine Electron launch mode for bundled ffprobe');
    }
    packaged = app.isPackaged;
    resourcesPath = process.resourcesPath;
  }
  if (packaged) {
    const bundled = resolveRuntimes({ resourcesPath }).ffprobe;
    if (!bundled.exists) {
      throw new Error('Bundled ffprobe is missing or not a regular executable outside ASAR: ' +
        bundled.path);
    }
    return bundled.path;
  }
  const candidates = [
    process.env.FFPROBE_BIN,
    path.join(__dirname, '../runtime/ffmpeg/ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'ffprobe';
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_BIN,
    path.join(__dirname, '../runtime/ffmpeg/ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'ffmpeg';
}

function findMediaInfo() {
  const candidates = [
    process.env.MEDIAINFO_BIN,
    path.join(__dirname, '../runtime/mediainfo/mediainfo'),
    '/opt/homebrew/bin/mediainfo',
    '/usr/local/bin/mediainfo',
    '/usr/bin/mediainfo',
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;  // mediainfo isn't ubiquitous on macOS by default — null signals "skip"
}

function parseFraction(s) {
  if (!s || typeof s !== 'string') return null;
  const [num, den] = s.split('/');
  const n = parseFloat(num);
  const d = parseFloat(den);
  if (!isFinite(n) || !isFinite(d) || d === 0) return null;
  return n / d;
}

function digestProbeResult(raw, filePath) {
  const streams = Array.isArray(raw?.streams) ? raw.streams : [];
  const vstream = streams.find(s => s.codec_type === 'video') || null;
  const astream = streams.find(s => s.codec_type === 'audio') || null;
  const fmt = raw?.format || {};

  const video = vstream ? {
    codec: vstream.codec_long_name || vstream.codec_name || null,
    codecTag: vstream.codec_tag_string || null,
    width: vstream.width ?? null,
    height: vstream.height ?? null,
    fps: parseFraction(vstream.avg_frame_rate)
         ?? parseFraction(vstream.r_frame_rate),
    rFps: vstream.r_frame_rate || null,
    bitDepth: parseInt(vstream.bits_per_raw_sample, 10) || null,
    pixelFormat: vstream.pix_fmt || null,
    colorSpace: vstream.color_space || null,         // matrix coefficients (bt709, bt470bg, smpte170m, ...)
    colorPrimaries: vstream.color_primaries || null,
    colorTransfer: vstream.color_transfer || null,
    colorRange: vstream.color_range || null,         // tv / pc
    fieldOrder: vstream.field_order || null,         // tt=TFF, bb=BFF, tb, bt, progressive, unknown
    sampleAspectRatio: vstream.sample_aspect_ratio || null,
    displayAspectRatio: vstream.display_aspect_ratio || null,
    chromaLocation: vstream.chroma_location || null,
    frameCount: parseInt(vstream.nb_frames, 10) || null,
    duration: parseFloat(vstream.duration) || null,
    bitRate: parseInt(vstream.bit_rate, 10) || null,
  } : null;

  const audio = astream ? {
    codec: astream.codec_long_name || astream.codec_name || null,
    channels: astream.channels ?? null,
    channelLayout: astream.channel_layout || null,
    sampleRate: parseInt(astream.sample_rate, 10) || null,
    bitRate: parseInt(astream.bit_rate, 10) || null,
    bitDepth: parseInt(astream.bits_per_sample, 10) || null,
  } : null;

  return {
    filePath,
    fileName: path.basename(filePath),
    probedAt: new Date().toISOString(),
    container: fmt.format_long_name || fmt.format_name || null,
    formatName: fmt.format_name || null,
    duration: parseFloat(fmt.duration) || null,
    bitRate: parseInt(fmt.bit_rate, 10) || null,
    sizeBytes: parseInt(fmt.size, 10) || null,
    video,
    audio,
    raw,  // full ffprobe output preserved — Archivist can reach in for niche fields
  };
}

async function probeFile(filePath, options = {}) {
  const bin = findFfprobe(options);
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  const result = await runProbeProcess(spawn, bin, args, { stdio: ['ignore', 'pipe', 'pipe'] },
    { kind: 'ffprobe', ...METADATA_BUDGET }, options);
  if (!result.ok) {
    const error = new Error(result.reason === 'probe-spawn-failed'
      ? `ffprobe spawn failed (${bin}): ${result.error}` : result.error);
    Object.assign(error, processFailure(result));
    throw error;
  }
  if (result.code !== 0 || result.signal) {
    throw Object.assign(new Error(`ffprobe exit ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr.trim() || '(no stderr)'}`),
      { reason: 'probe-exit', closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true });
  }
  try { return digestProbeResult(JSON.parse(result.stdout), filePath); }
  catch (error) { throw Object.assign(new Error(`ffprobe output not JSON: ${error.message}`),
    { reason: 'probe-output-invalid', closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true }); }
}

// ffmpeg -vf idet analysis. Container metadata can lie about field order — a DV
// tape transcoded to ProRes/MOV often gets a progressive container flag while the
// pixels are still interlaced. idet does frame-content analysis instead of trusting
// the container, sampling 120 frames (≈4 s @ 30 fps) for confident classification.
function parseIdetOutput(stderr) {
  // [Parsed_idet_0 @ 0x...] Multi frame detection: TFF:   121 BFF:     0 Progressive:     0 Undetermined:     0
  // Two gotchas in current ffmpeg output, both of which broke the original parser:
  //   1. Counts are column-padded (`TFF:   121`) — allow whitespace after each colon.
  //   2. ffmpeg emits TWO summary blocks: an early all-zeros one, then the real
  //      final tally. Scan every occurrence and keep the last block with frames.
  const re = /Multi frame detection:\s*TFF:\s*(\d+)\s+BFF:\s*(\d+)\s+Progressive:\s*(\d+)\s+Undetermined:\s*(\d+)/g;
  let m = null;
  for (const candidate of stderr.matchAll(re)) {
    const sum = ['1', '2', '3', '4'].reduce((acc, i) => acc + parseInt(candidate[i], 10), 0);
    if (sum > 0) m = candidate;
  }
  if (!m) return null;
  const tff = parseInt(m[1], 10);
  const bff = parseInt(m[2], 10);
  const prog = parseInt(m[3], 10);
  const undet = parseInt(m[4], 10);
  const total = tff + bff + prog + undet;
  if (total === 0) return null;
  const counts = [
    { type: 'tt',           count: tff },
    { type: 'bb',           count: bff },
    { type: 'progressive',  count: prog },
    { type: 'undetermined', count: undet },
  ];
  counts.sort((a, b) => b.count - a.count);
  const winner = counts[0];
  return {
    detected: winner.type,
    confidence: winner.count / total,
    breakdown: { tff, bff, progressive: prog, undetermined: undet, total },
  };
}

async function analyzeFields(filePath, frameCount = 120, options = {}) {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return { ok: false, reason: 'probe-invalid-budget', error: 'frameCount must be a positive safe integer',
      closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true };
  }
  const bin = findFfmpeg();
  const args = ['-v', 'info', '-nostats', '-i', filePath, '-vf', 'idet',
    '-frames:v', String(frameCount), '-an', '-f', 'null', '-'];
  // 120 decoded frames are not a wall-time guarantee. This generous provisional
  // budget scales with explicitly larger samples; callers can raise it further.
  const result = await runProbeProcess(spawn, bin, args, { stdio: ['ignore', 'ignore', 'pipe'] },
    { kind: 'idet', timeoutMs: Math.max(120_000, frameCount * 1000), maxOutputBytes: 4 * 1024 * 1024 }, options);
  if (!result.ok) return processFailure(result);
  if (result.code !== 0 || result.signal) {
    return { ok: false, error: `ffmpeg exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`,
      stderrTail: result.stderr.slice(-400), closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true };
  }
  const parsed = parseIdetOutput(result.stderr);
  if (!parsed) return { ok: false, error: 'idet output not found', stderrTail: result.stderr.slice(-400), closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true };
  return { ok: true, ...parsed };
}

// MediaInfo analysis. ffprobe gives us `field_order` which mashes scan-type +
// scan-order into one token (tt = interlaced TFF, progressive = not interlaced).
// MediaInfo separates them — `ScanType` (Progressive|Interlaced|MBAFF|PAFF) and
// `ScanOrder` (TFF|BFF), which is what restoration tools care about. It also
// exposes `ScanType_Original` and `ScanOrder_Original` — provenance metadata that
// tells us what the source material was BEFORE any encoding (useful for archival).
//
// Optional: if mediainfo isn't installed, we skip silently and the UI just shows
// the ffprobe + idet layers.
async function analyzeMediaInfo(filePath, options = {}) {
  const bin = findMediaInfo();
  if (!bin) return { ok: false, error: 'mediainfo not installed', notInstalled: true };
  const result = await runProbeProcess(spawn, bin, ['--Output=JSON', filePath],
    { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: 'mediainfo', ...METADATA_BUDGET }, options);
  if (!result.ok) return processFailure(result);
  if (result.code !== 0 || result.signal) {
    return { ok: false, error: result.stderr || `mediainfo exit ${result.code}${result.signal ? ` (${result.signal})` : ''}`,
      reason: 'probe-exit', closed: true, cleanupUnconfirmed: false, noAutomaticReplay: true };
  }
  try {
    const j = JSON.parse(result.stdout);
    const tracks = j?.media?.track || [];
    const v = tracks.find(t => t['@type'] === 'Video');
    if (!v) return { ok: false, error: 'no video track in mediainfo output' };
    return { ok: true, scanType: v.ScanType || null, scanOrder: v.ScanOrder || null,
      scanTypeOriginal: v.ScanType_Original || null, scanOrderOriginal: v.ScanOrder_Original || null,
      format: v.Format || null, formatProfile: v.Format_Profile || null,
      codecId: v.CodecID || null, rawVideoTrack: v };
  } catch (error) { return { ok: false, error: `mediainfo JSON parse: ${error.message}` }; }
}

// Compute a fingerprint of the file that's fast to verify on every render but
// hard to fool with "replace the file with different content of the same name".
// We sha256-hash the first 1 MB + last 1 MB of the file — for any realistic
// source media (>2 MB), this samples both the container header (with codec /
// resolution / timing metadata) and the trailing index / packets, giving
// effective collision resistance for our use case without reading the whole
// file. Sub-100 ms on every source the user is likely to throw at it.
//
// HASH ALGORITHM CHOICE — sha256, not blake2b. Original plan called for
// blake2b512 (slightly faster, longer digest) but Electron's bundled
// BoringSSL build of OpenSSL omits BLAKE2 — `createHash('blake2b512')`
// throws "Digest method not supported" at runtime. Verified with:
//   ELECTRON_RUN_AS_NODE=1 electron -e "crypto.createHash('blake2b512')"
//   → FAIL: Digest method not supported
// The previous probe.js silently swallowed the error in a try/catch, so the
// fingerprint never made it to the metadata and the colorist never saw the
// hash chip. sha256 is universal across every Node/Electron build and the
// speed difference on 2 MB is irrelevant.
function hashFileChunks(filePath) {
  const CHUNK = 1024 * 1024;  // 1 MB
  const st = statSync(filePath);
  const size = st.size;
  const hash = crypto.createHash('sha256');
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    // Always hash the leading bytes
    const head = readSync(fd, buf, 0, Math.min(CHUNK, size), 0);
    hash.update(buf.subarray(0, head));
    // If the file is bigger than one chunk, hash the tail too. Otherwise the
    // leading hash already covers the whole file.
    if (size > CHUNK) {
      const tailOffset = Math.max(CHUNK, size - CHUNK);
      const tail = readSync(fd, buf, 0, Math.min(CHUNK, size - tailOffset), tailOffset);
      hash.update(buf.subarray(0, tail));
    }
    // Mix the size in too so a head/tail truncation flips the hash.
    hash.update(Buffer.from(`size=${size}`, 'utf8'));
    return {
      hash: hash.digest('hex'),
      size,
      mtimeMs: st.mtimeMs,
      algo: 'sha256',
    };
  } finally {
    closeSync(fd);
  }
}

module.exports = {
  findFfprobe, findFfmpeg, findMediaInfo,
  probeFile, analyzeFields, analyzeMediaInfo,
  hashFileChunks,
};
