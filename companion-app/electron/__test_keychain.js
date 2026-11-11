// Exercise the actual keychain module with isolated in-memory dependencies.
// No native keytar, real credential file, user Keychain, provider, or network call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'keychain.js'), 'utf8');
const providers = require('./llm/providers');

function harness({ endpointText = '{}', deleteError = false } = {}) {
  const entries = new Map();
  const calls = [];
  let stored = endpointText;
  const keytar = {
    getPassword: async (service, account) => {
      calls.push(['get', service, account]);
      return entries.get(account) || null;
    },
    setPassword: async (service, account, value) => {
      calls.push(['set', service, account]); entries.set(account, value);
    },
    deletePassword: async (service, account) => {
      calls.push(['delete', service, account]);
      if (deleteError) throw new Error('Keychain operation failed');
      return entries.delete(account);
    },
    findCredentials: async () => [...entries].map(([account, password]) => ({ account, password })),
  };
  const fakeFs = {
    existsSync: () => true,
    mkdirSync: () => { throw new Error('Unexpected directory mutation'); },
    readFileSync: (file) => {
      assert.equal(path.basename(file), 'endpoints.json', 'must never read legacy credentials');
      calls.push(['read-endpoints']); return stored;
    },
    writeFileSync: (file, content, options) => {
      assert.equal(path.basename(file), 'endpoints.json');
      assert.equal(options.mode, 0o600);
      calls.push(['write-endpoints']); stored = content;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, URL,
    process: { env: { ANTHROPIC_API_KEY: 'environment fixture should be ignored' } },
    require: (name) => {
      if (name === 'keytar') return keytar;
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'os') return { homedir: () => '/isolated-test-home' };
      if (name === './llm/providers') return providers;
      throw new Error('Unexpected dependency: ' + name);
    },
  }, { filename: 'keychain.js', timeout: 1000 });
  return { api: module.exports, entries, calls, endpointText: () => stored };
}

test('Settings key save uses Keychain and trims accidental whitespace', async () => {
  const h = harness();
  await h.api.setApiKey('anthropic', '  entered test value  ');
  assert.equal(await h.api.getApiKey('anthropic'), 'entered test value');
  assert.equal(h.calls.filter(x => x[0] === 'write-endpoints').length, 0);
});

test('key status exposes no key value or suffix', async () => {
  const h = harness();
  await h.api.setApiKey('anthropic', 'entered test value');
  const status = await h.api.hasApiKey('anthropic');
  assert.equal(status.hasKey, true);
  assert.equal(status.masked, '••••');
  assert.ok(!JSON.stringify(status).includes('test value'));
});

test('Forget key stays forgotten despite inherited environment and legacy file presence', async () => {
  const h = harness();
  await h.api.setApiKey('anthropic', 'entered test value');
  await h.api.setApiKey('anthropic', '');
  assert.equal(await h.api.getApiKey('anthropic'), null);
  assert.equal((await h.api.hasApiKey('anthropic')).hasKey, false);
  assert.equal(h.calls.filter(x => x[0] === 'set').length, 1);
});

test('opening Settings with no key never imports plaintext or environment credentials', async () => {
  const h = harness();
  assert.equal((await h.api.hasApiKey('anthropic')).hasKey, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'get');
});

test('unknown and prototype provider ids cannot touch storage', async () => {
  const h = harness();
  for (const provider of ['unknown', '__proto__', 'constructor', null]) {
    await assert.rejects(h.api.setApiKey(provider, 'entered test value'), /provider/);
    assert.throws(() => h.api.setEndpoint(provider, 'http://localhost:1234/v1'), /provider/);
  }
  assert.equal(h.calls.length, 0);
});

test('local providers do not read Keychain and cannot receive API keys', async () => {
  const h = harness();
  assert.equal(await h.api.getApiKey('lmstudio'), null);
  await assert.rejects(h.api.setApiKey('lmstudio', 'entered test value'), /provider/);
  assert.equal(h.calls.length, 0);
});

test('valid endpoint settings permit loopback base URLs', () => {
  const h = harness();
  const endpoint = 'http://localhost:1234/v1';
  h.api.setEndpoint('lmstudio', endpoint);
  assert.equal(h.api.getEndpoint('lmstudio'), endpoint);
  assert.ok(!h.endpointText().includes('entered test value'));
  h.api.setEndpoint('lmstudio', '');
  assert.equal(h.api.getEndpoint('lmstudio'), null);
});

test('credential-bearing endpoint URLs are rejected before any disk write', () => {
  const h = harness();
  for (const endpoint of [
    'https://user:password@example.invalid/v1',
    'https://example.invalid/v1?api_key=fixture',
    'https://example.invalid/v1?API-KEY=fixture',
    'https://example.invalid/v1?x-api-key=fixture',
    'https://example.invalid/v1?access_token=fixture',
    'https://example.invalid/v1?authorization=fixture',
    'https://example.invalid/v1?client_secret=fixture',
    'https://example.invalid/v1?refresh_token=fixture',
    'https://example.invalid/v1?session_token=fixture',
    'https://example.invalid/v1?api-version=2026-01-01',
    'https://example.invalid/v1#fixture',
    'file:///isolated-test-home/file',
  ]) assert.throws(() => h.api.setEndpoint('openai', endpoint));
  assert.equal(h.calls.length, 0);
});

test('legacy credential-bearing endpoint is not returned to the renderer', () => {
  const h = harness({ endpointText: '{"openai":"https://example.invalid/v1?token=fixture"}' });
  assert.throws(() => h.api.getEndpoint('openai'), /cannot contain credentials/);
});

test('SECURITY (security review #6, 2026-11-05): remote http: endpoints are refused; local ones pass', () => {
  const h = harness();
  // Remote plaintext hosts must be refused — the API key and chat prompts
  // (which carry source paths + chain code) would cross the wire unencrypted.
  for (const endpoint of [
    'http://api.example.com/v1',
    'http://example.invalid/v1',
    'http://93.184.216.34/v1',
    'http://[2606:2800:220:1::1]/v1',
  ]) assert.throws(() => h.api.setEndpoint('openai', endpoint), /HTTPS/);
  // Local/private servers (LM Studio, Ollama on the LAN) stay usable.
  for (const endpoint of [
    'http://localhost:1234/v1',
    'http://127.0.0.1:1234/v1',
    'http://192.168.1.10:11434/v1',
    'http://10.0.0.5:11434/v1',
    'http://172.16.0.2:11434/v1',
    'http://myserver.local:11434/v1',
  ]) assert.doesNotThrow(() => h.api.setEndpoint('lmstudio', endpoint));
  // Each accepted setEndpoint reads the store then writes it; only the six
  // accepted local endpoints may produce writes.
  assert.equal(h.calls.filter(c => c[0] === 'write-endpoints').length, 6,
      'only the accepted local writes touched the (fake) store');
});

test('malformed endpoint state does not corrupt later valid settings', () => {
  const h = harness({ endpointText: '[]' });
  h.api.setEndpoint('openai', 'https://example.invalid/v1');
  assert.equal(h.api.getEndpoint('openai'), 'https://example.invalid/v1');
});

test('failed key deletion propagates an error and does not claim success', async () => {
  const h = harness({ deleteError: true });
  await h.api.setApiKey('anthropic', 'entered test value');
  await assert.rejects(h.api.setApiKey('anthropic', ''), /Keychain operation failed/);
  assert.equal((await h.api.hasApiKey('anthropic')).hasKey, true);
});
