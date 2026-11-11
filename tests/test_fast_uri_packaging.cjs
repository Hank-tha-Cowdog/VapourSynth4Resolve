// Offline fixture checks of the installed source copier; no packager/lifecycle.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.realpathSync(process.argv[2] || path.join(__dirname, '../companion-app/node_modules'));
const packageFile = fs.realpathSync(process.argv[3] || path.join(__dirname, '../companion-app/package.json'));
const configured = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const excludes = ['!**/node_modules/fast-uri/benchmark', '!**/node_modules/fast-uri/benchmark/**/*'];
for (const pattern of excludes) assert.equal(configured.build.files.filter(x => x === pattern).length, 1);
const oldPatterns = configured.build.files.filter(x => !excludes.includes(x));
const benchmark = ['benchmark.mjs', 'equal.mjs', 'non-simple-domain.mjs', 'package.json',
  'string-array-to-hex-stripped.mjs', 'ws-is-secure.mjs'].map(x => 'benchmark/' + x).sort();
const retained = ['package.json', 'index.js', 'lib/utils.js', 'lib/schemes.js', 'LICENSE'].sort();

// These exact unchanged CommonJS modules receive only their used dependency
// ports. Unknown imports fail before host resolution. This is a fixture harness,
// not a sandbox or a replacement claim for the complete electron-builder build.
function cjs(filename, ports) {
  const info = fs.lstatSync(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 65536);
  const body = fs.readFileSync(filename, 'utf8');
  const mod = { exports: {} };
  const entry = vm.runInThisContext('(function(exports, require, module, __filename, __dirname) {\n' + body + '\n})', { filename });
  entry(mod.exports, name => {
    assert.ok(Object.hasOwn(ports, name), 'unexpected fixture import: ' + name);
    return ports[name];
  }, mod, filename, path.dirname(filename));
  return mod.exports;
}
function library(name, ports = {}) { return cjs(path.join(source, name), ports); }
const balanced = library('balanced-match/dist/commonjs/index.js');
const braces = library('brace-expansion/dist/commonjs/index.js', { 'balanced-match': balanced });
const unescape = library('minimatch/dist/commonjs/unescape.js');
const ast = library('minimatch/dist/commonjs/ast.js', {
  './brace-expressions.js': library('minimatch/dist/commonjs/brace-expressions.js'), './unescape.js': unescape,
});
const minimatch = library('minimatch/dist/commonjs/index.js', {
  'brace-expansion': braces, './assert-valid-pattern.js': library('minimatch/dist/commonjs/assert-valid-pattern.js'),
  './ast.js': ast, './escape.js': library('minimatch/dist/commonjs/escape.js'), './unescape.js': unescape,
});
const builder = { asArray: value => value == null ? [] : Array.isArray(value) ? value : [value],
  CONCURRENCY: { concurrency: 8 } };
// Promise.all preserves ordered result slots; fixture concurrency/performance is
// not claimed to reproduce Bluebird scheduling. No onNodeModuleFile hook exists.
const promises = { default: { map: async (items, fn, options) => {
  assert.deepEqual(options, { concurrency: 8 });
  const result = [];
  for (let start = 0; start < items.length; start += 8) result.push(...await Promise.all(items.slice(start, start + 8).map(fn)));
  return result;
} } };
let fixtureRoot = null;
let reads = [];
function privatePath(value) {
  const resolved = path.resolve(value);
  assert.ok(fixtureRoot && (resolved === fixtureRoot || resolved.startsWith(fixtureRoot + path.sep)));
  return resolved;
}
const fixtureFs = {
  readdir: async value => { const p = privatePath(value); reads.push(p); return fs.promises.readdir(p); },
  lstat: value => fs.promises.lstat(privatePath(value)),
  lstatSync: value => fs.lstatSync(privatePath(value)),
  readlink: () => { throw new Error('symlinks are outside this ordinary-file fixture'); },
  stat: () => { throw new Error('symlink targets are outside this ordinary-file fixture'); },
};
const filter = library('app-builder-lib/out/util/filter.js', {
  path, '../fileTransformer': { NODE_MODULES_PATTERN: path.sep + 'node_modules' + path.sep },
});
const matcher = library('app-builder-lib/out/fileMatcher.js', {
  'bluebird-lst': promises, 'builder-util': builder, 'fs/promises': {}, minimatch, path, './util/filter': filter,
});
const walker = library('app-builder-lib/out/util/AppFileWalker.js', { 'fs-extra': fixtureFs, path });
const copy = library('app-builder-lib/out/util/NodeModuleCopyHelper.js', {
  'bluebird-lst': promises, 'builder-util': builder, 'fs-extra': fixtureFs, path, '../fileMatcher': matcher,
  './AppFileWalker': walker, fs: { realpathSync: value => fs.realpathSync(privatePath(value)) },
  './resolve': { resolveFunction: async (_type, hook) => { assert.equal(hook, undefined); return undefined; } },
});
function write(relative, bytes = 'INERT\n') {
  const target = path.join(fixtureRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  return target;
}
function moduleFixture(relative) {
  const root = path.join(fixtureRoot, relative);
  for (const name of retained.concat(benchmark)) write(path.join(relative, name), fs.readFileSync(path.join(source, 'fast-uri', name)));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '3.1.5'); assert.equal(metadata.main, 'index.js'); assert.equal(metadata.type, 'commonjs');
  assert.equal(Object.hasOwn(metadata, 'exports'), false); assert.equal(Object.hasOwn(metadata, 'browser'), false);
  return root;
}
async function collect(moduleDir, patterns, name = 'fast-uri') {
  const m = matcher.getNodeModuleFileMatcher(fixtureRoot, path.join(fixtureRoot, 'out'), x => x, {},
    { config: { files: patterns }, debugLogger: { isEnabled: false } });
  const helper = new copy.NodeModuleCopyHelper(m, { config: {}, appInfo: { type: 'commonjs' } });
  reads = [];
  const files = await helper.collectNodeModules({ dir: moduleDir, name }, []);
  return { files, names: files.map(p => path.relative(moduleDir, p).split(path.sep).join('/')).sort(), reads: reads.slice() };
}
async function fixture(fn) {
  assert.equal(fixtureRoot, null);
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-fast-uri-packaging-'));
  try { await fn(); } finally { const owned = fixtureRoot; fixtureRoot = null; fs.rmSync(owned, { recursive: true }); }
}
function runtime(root) {
  const utils = cjs(path.join(root, 'lib/utils.js'), {});
  const schemes = cjs(path.join(root, 'lib/schemes.js'), { './utils': utils });
  return cjs(path.join(root, 'index.js'), { './lib/utils': utils, './lib/schemes': schemes });
}
function observations(uri) {
  assert.equal(uri.default, uri); assert.equal(uri.fastUri, uri);
  assert.deepEqual(Object.keys(uri.SCHEMES).sort(), ['http', 'https', 'urn', 'urn:uuid', 'ws', 'wss']);
  const parsed = uri.parse('https://example.com/a?b=c#d');
  assert.equal(parsed.host, 'example.com'); assert.equal(parsed.path, '/a'); assert.equal(parsed.query, 'b=c');
  assert.equal(uri.serialize({ scheme: 'https', host: 'example.com', port: 443, path: '/a' }), 'https://example.com/a');
  assert.equal(uri.normalize('http://example.com/a/../b'), 'http://example.com/b');
  assert.equal(uri.resolve('http://example.com/a/b', '../c'), 'http://example.com/c');
  // Preserve relative '..' in already-parsed components, as resolve() does.
  assert.equal(uri.serialize(uri.resolveComponent(uri.parse('http://example.com/a/b'), uri.parse('../c'), {}, true)), 'http://example.com/c');
  assert.equal(uri.equal('http://EXAMPLE.com:80/a', 'http://example.com/a'), true);
  assert.equal(uri.parse('wss://example.com/chat?q=x').resourceName, '/chat?q=x');
  assert.equal(uri.serialize({ scheme: 'ws', host: 'example.com', resourceName: '/chat?q=x', secure: true }), 'wss://example.com/chat?q=x');
  assert.equal(uri.parse('urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6').uuid, 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6');
  assert.equal(uri.parse('//[2001:db8::7]').host, '2001:db8::7');
  const invalid = 'http://good.example\\@evil.example/';
  assert.match(uri.parse(invalid).error, /literal backslash/);
  assert.equal(uri.equal(invalid, invalid), false); assert.throws(() => uri.resolve(invalid, 'x'));
  assert.equal(uri.parse('http://example.com:65536/a').error, 'URI port is malformed.');
  return [parsed, uri.parse('wss://example.com/chat?q=x'), uri.parse('//[2001:db8::7]'), uri.parse(invalid)];
}

test('root production dependency copier removes exactly six benchmark leaves before descent', { concurrency: false }, async () => fixture(async () => {
  const root = moduleFixture('node_modules/fast-uri');
  const before = await collect(root, oldPatterns); const after = await collect(root, configured.build.files);
  assert.deepEqual(before.names, retained.concat(benchmark).sort()); assert.deepEqual(after.names, retained);
  assert.ok(before.reads.includes(path.join(root, 'benchmark'))); assert.ok(!after.reads.includes(path.join(root, 'benchmark')));
}));
test('nested conflict dependency uses the same exact pruning rules', { concurrency: false }, async () => fixture(async () => {
  const root = moduleFixture('node_modules/parent/node_modules/fast-uri');
  const before = await collect(root, oldPatterns); const after = await collect(root, configured.build.files);
  assert.deepEqual(before.names, retained.concat(benchmark).sort()); assert.deepEqual(after.names, retained);
  assert.ok(!after.reads.includes(path.join(root, 'benchmark')));
}));
test('other packages benchmark and fast-uri neighboring names remain selected', { concurrency: false }, async () => fixture(async () => {
  const root = moduleFixture('node_modules/fast-uri'); write('node_modules/fast-uri/benchmarking/keep.js');
  const other = path.join(fixtureRoot, 'node_modules/fast-uri-extra'); write('node_modules/fast-uri-extra/benchmark/keep.js');
  const selected = await collect(root, configured.build.files);
  assert.deepEqual(selected.names, retained.concat(['benchmarking/keep.js']).sort());
  assert.deepEqual((await collect(other, configured.build.files, 'fast-uri-extra')).names, ['benchmark/keep.js']);
}));
test('retained source and public URI behavior are identical after actual copier selection', { concurrency: false }, async () => fixture(async () => {
  const root = moduleFixture('node_modules/fast-uri'); const selected = await collect(root, configured.build.files);
  const output = path.join(fixtureRoot, 'retained-fast-uri');
  for (const file of selected.files) {
    const relative = path.relative(root, file); assert.ok(!relative.startsWith('..'));
    write(path.join('retained-fast-uri', relative), fs.readFileSync(file));
    assert.deepEqual(fs.readFileSync(path.join(output, relative)), fs.readFileSync(file));
  }
  assert.equal(fs.existsSync(path.join(output, 'benchmark')), false);
  assert.deepEqual(observations(runtime(root)), observations(runtime(output)));
}));
