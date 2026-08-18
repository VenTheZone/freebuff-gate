#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const sea = require('node:sea');

const SEA_ASSETS = Object.freeze([
  'freebuff-setup.js',
  'freebuff-setup-wizard.js',
  'freebuff-gate-setup.js',
  'install-mobile-connect.js',
  'mobile-connect-agent.js',
  'mobile-connect-protocol.js',
  'mobile-connect-qr.js',
  'freebuff_tailnet_proxy.js',
  'mobile-ui.css',
  'mobile-ui.js',
  'perf-probe.js',
  'freebuff-setup.version',
]);

function assetRoot() {
  const env = process.env;
  const home = os.homedir();
  if (env.FREEBUFF_SETUP_ASSET_DIR) return path.resolve(env.FREEBUFF_SETUP_ASSET_DIR);
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Freebuff', 'cache', 'setup-assets');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'Freebuff', 'setup-assets');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'freebuff', 'setup-assets');
}

function writeIfChanged(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  try {
    const current = fs.readFileSync(file);
    if (crypto.timingSafeEqual(crypto.createHash('sha256').update(current).digest(), crypto.createHash('sha256').update(bytes).digest())) return;
  } catch {}
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function materializeAssets() {
  if (!sea.isSea()) return __dirname;
  const version = sea.getAsset('freebuff-setup.version', 'utf8').trim() || 'dev';
  const root = path.join(assetRoot(), version);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of SEA_ASSETS) {
    const target = path.join(root, name);
    if (path.dirname(target) !== root) throw new Error(`invalid embedded asset name: ${name}`);
    writeIfChanged(target, sea.getAsset(name));
    try { fs.chmodSync(target, 0o600); } catch {}
  }
  process.env.FREEBUFF_SETUP_VERSION = version;
  // Installed launchers and per-user service registrations use the same SEA
  // binary to host the companion agent and proxy. The runtime mode is
  // internal; normal setup CLI arguments never need to know about it.
  process.env.FREEBUFF_SETUP_RUNTIME = 'sea';
  process.env.FREEBUFF_SETUP_BINARY_PATH = process.execPath;
  return root;
}

function runAgent(wrapperPath, argv = []) {
  if (!wrapperPath) throw new Error('agent wrapper path is required');
  const target = path.resolve(wrapperPath);
  if (!fs.existsSync(target)) throw new Error(`agent wrapper not found: ${wrapperPath}`);
  const previousArgv = process.argv;
  process.argv = [process.execPath, target, ...argv];
  try {
    createRequire(target)(target);
  } finally {
    process.argv = previousArgv;
  }
  return 0;
}

async function runProxy(proxyPath) {
  if (!proxyPath) throw new Error('proxy script path is required');
  const target = path.resolve(proxyPath);
  if (!fs.existsSync(target)) throw new Error(`proxy script not found: ${proxyPath}`);
  const proxy = createRequire(target)(target);
  if (!proxy || typeof proxy.createProxyServer !== 'function') {
    throw new Error(`proxy script does not export createProxyServer: ${target}`);
  }
  const server = proxy.createProxyServer();
  const port = Number(process.env.FREEBUFF_PROXY_PORT || 58061);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const upstream = process.env.FREEBUFF_UPSTREAM || 'http://127.0.0.1:58060';
  console.log(`freebuff tailnet proxy on 127.0.0.1:${port} -> ${upstream}`);
  await new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function run(argv = process.argv.slice(2)) {
  const root = materializeAssets();
  if (argv[0] === '--run-agent') return runAgent(argv[1], argv.slice(2));
  if (argv[0] === '--run-proxy') return runProxy(argv[1]);
  const loadFromCache = createRequire(path.join(root, 'freebuff-setup-sea-entry.js'));
  const entry = loadFromCache('./freebuff-setup.js');
  return entry.main(argv);
}

if (require.main === module || sea.isSea()) {
  run().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  SEA_ASSETS,
  assetRoot,
  materializeAssets,
  runAgent,
  runProxy,
  run,
};
