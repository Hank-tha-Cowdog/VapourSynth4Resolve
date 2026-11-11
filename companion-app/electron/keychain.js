// macOS Keychain wrapper for per-provider API keys + a flat JSON file for endpoint URLs.
//
// API keys: stored in the system Keychain under service `com.vapoursynth.resolveofx`,
// keyed by providerId (account name). keytar is a Node native module that talks to the
// Security framework — properly secret-at-rest, not in plaintext on disk.
//
// Endpoint URLs are stored separately and must not contain credentials. API keys
// are entered in Settings and read only from Keychain, never from source, a
// plaintext legacy file, or inherited environment variables.

const keytar = require('keytar');
const path = require('path');
const fs = require('fs');
const os = require('os');
const providers = require('./llm/providers');

const KEYCHAIN_SERVICE = 'com.vapoursynth.resolveofx';
const SUPPORT_DIR = path.join(os.homedir(), 'Library/Application Support/VapourSynth-OFX');
const ENDPOINTS_FILE = path.join(SUPPORT_DIR, 'endpoints.json');

function checkProvider(providerId, needsKey = false) {
  if (typeof providerId !== 'string'
      || !Object.prototype.hasOwnProperty.call(providers, providerId)
      || (needsKey && !providers[providerId].needsApiKey)) {
    throw new Error('Unknown API-key provider');
  }
}

function ensureDir() {
  if (!fs.existsSync(SUPPORT_DIR)) fs.mkdirSync(SUPPORT_DIR, { recursive: true });
}

async function setApiKey(providerId, key) {
  checkProvider(providerId, true);
  if (typeof key !== 'string') throw new Error('API key must be text');
  key = key.trim();
  if (!key) {
    await keytar.deletePassword(KEYCHAIN_SERVICE, providerId);
    return;
  }
  await keytar.setPassword(KEYCHAIN_SERVICE, providerId, key);
}

async function getApiKey(providerId) {
  checkProvider(providerId);
  if (!providers[providerId].needsApiKey) return null;
  return (await keytar.getPassword(KEYCHAIN_SERVICE, providerId)) || null;
}

async function hasApiKey(providerId) {
  const k = await getApiKey(providerId);
  return { hasKey: !!k, masked: k ? '••••' : null };
}

async function listConfiguredProviders() {
  // Names only — no values. Used by Settings UI to render "✓ Configured" badges.
  try {
    const creds = await keytar.findCredentials(KEYCHAIN_SERVICE);
    return creds.map(c => c.account).filter(id =>
      Object.prototype.hasOwnProperty.call(providers, id));
  } catch {
    return [];
  }
}

function readEndpoints() {
  try {
    const value = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function writeEndpoints(obj) {
  ensureDir();
  fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
function validateEndpoint(value) {
  if (typeof value !== 'string') throw new Error('Endpoint URL must be text');
  const url = value.trim();
  if (!url) return '';
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enter a valid HTTP or HTTPS endpoint URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Endpoint must use HTTP or HTTPS');
  }
  // SECURITY (2026-11-05, security review #6): an API key rides on every
  // request to these endpoints, and chat prompts carry source paths and
  // chain code — plaintext http: would expose both on the wire. http: is
  // allowed ONLY for loopback / private-network hosts (local servers like
  // LM Studio or Ollama); everything else must be https:.
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === 'localhost'
      || host === '127.0.0.1' || host === '::1'
      || host.endsWith('.local')
      || /^127\./.test(host)
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
    if (!isLocal) {
      throw new Error('Remote endpoints must use HTTPS (http: is only allowed for localhost/LAN addresses — the API key and prompts would otherwise cross the network in plaintext)');
    }
  }
  // These settings are base URLs. Reject every query/fragment instead of trying
  // to enumerate the many names a provider might use for a secret.
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('Endpoint URLs cannot contain credentials, queries, or fragments; use the key field');
  }
  return url;
}
function setEndpoint(providerId, url) {
  checkProvider(providerId);
  const endpoint = validateEndpoint(url);
  const obj = readEndpoints();
  if (!endpoint) delete obj[providerId];
  else obj[providerId] = endpoint;
  writeEndpoints(obj);
}
function getEndpoint(providerId) {
  checkProvider(providerId);
  const value = readEndpoints()[providerId];
  return value ? validateEndpoint(value) : null;
}

module.exports = {
  setApiKey, getApiKey, hasApiKey, listConfiguredProviders,
  setEndpoint, getEndpoint,
};
