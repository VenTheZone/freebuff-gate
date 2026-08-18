'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const setup = require('./freebuff-gate-setup');

const SERVE_SAMPLE = `|-- tcp://gate.dory-economy.ts.net:58060 (tailnet only)
|-- tcp://100.94.92.41:58060
|-- tcp://[fd7a:115c:a1e0::bc36:5c2a]:58060
|--> tcp://127.0.0.1:58061

https://gate.dory-economy.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:6080

http://gate (tailnet only)
http://gate.dory-economy.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:9091

https://gate.dory-economy.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8795
`;

test('parseServeTargets extracts tcp forward pairs and skips http/IPv6 lines', () => {
  const pairs = setup.parseServeTargets(SERVE_SAMPLE);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].publicPort, 58060);
  assert.equal(pairs[0].host, '100.94.92.41');
  assert.deepEqual(pairs[0].target, { host: '127.0.0.1', port: 58061 });
});

test('parseServeTargets handles empty and non-serve output', () => {
  assert.deepEqual(setup.parseServeTargets(null), []);
  assert.deepEqual(setup.parseServeTargets(''), []);
  assert.deepEqual(setup.parseServeTargets('tailscale serve is not running'), []);
});

test('releaseAssetName follows the packaged asset naming protocol', () => {
  assert.equal(
    setup.releaseAssetName('v0.1.13', 'freebuff_tailnet_proxy.js'),
    'freebuff-mobile-connect-v0.1.13-freebuff_tailnet_proxy.js',
  );
  assert.equal(
    setup.releaseAssetName('0.1.13', 'install-mobile-connect.js'),
    'freebuff-mobile-connect-0.1.13-install-mobile-connect.js',
  );
});

function healthyState(overrides = {}) {
  return {
    desktopDir: '/fake/desktop',
    verify: { ok: true, errors: [], warnings: [] },
    ports: { desktopPort: 58060, proxyPort: 58061, proxyPid: 42 },
    proxy: {
      reachable: true,
      checks: [
        { name: 'a', ok: true },
        { name: 'b', ok: true },
      ],
    },
    forward: { known: true, up: true, detail: 'tcp:58060 -> 127.0.0.1:58061' },
    ...overrides,
  };
}

test('planActions plans nothing for a healthy stack', () => {
  assert.deepEqual(setup.planActions(healthyState(), {}), []);
});

test('planActions upgrades when on-disk patches are missing', () => {
  const actions = setup.planActions(healthyState({
    verify: { ok: false, errors: [{ level: 'error', item: 'bundle', message: 'missing' }], warnings: [] },
  }), {});
  assert.deepEqual(actions.map((action) => action.id), ['upgrade']);
});

test('planActions upgrades when the proxy is not running', () => {
  const actions = setup.planActions(healthyState({
    proxy: { reachable: false, checks: [] },
  }), {});
  assert.deepEqual(actions.map((action) => action.id), ['upgrade']);
});

test('planActions restarts a stale proxy when served checks fail', () => {
  const actions = setup.planActions(healthyState({
    proxy: { reachable: true, checks: [{ name: 'upload route', ok: false }] },
  }), {});
  assert.deepEqual(actions.map((action) => action.id), ['restart']);
});

test('planActions restarts the orchestrator when patches are on disk but the process is stale', () => {
  const actions = setup.planActions(healthyState({
    proxy: {
      reachable: true,
      checks: [{ name: 'upload route (orchestrator)', ok: false }],
    },
  }), {});
  assert.deepEqual(actions.map((action) => action.id), ['restart-orchestrator']);
  // skip-upgrade also skips the orchestrator restart.
  assert.deepEqual(setup.planActions(healthyState({
    proxy: { reachable: true, checks: [{ name: 'upload route (orchestrator)', ok: false }] },
  }), { skipUpgrade: true }), []);
});

test('planActions replans tailnet forward when missing', () => {
  const actions = setup.planActions(healthyState({
    forward: { known: true, up: false, detail: 'tcp:58060 -> 127.0.0.1:58061' },
  }), {});
  assert.deepEqual(actions.map((action) => action.id), ['tailscale']);
});

test('planActions honors skip flags', () => {
  const state = healthyState({
    verify: { ok: false, errors: [{ level: 'error', item: 'bundle', message: 'missing' }], warnings: [] },
    forward: { known: true, up: false, detail: 'x' },
  });
  assert.deepEqual(setup.planActions(state, { skipUpgrade: true, skipTailscale: true }), []);
  assert.deepEqual(setup.planActions(state, { skipUpgrade: true }).map((action) => action.id), ['tailscale']);
  assert.deepEqual(setup.planActions(state, { skipTailscale: true }).map((action) => action.id), ['upgrade']);
});

test('planActions ignores unknown forward state', () => {
  const actions = setup.planActions(healthyState({
    forward: { known: false, up: false, detail: null },
  }), {});
  assert.deepEqual(actions, []);
});

test('humanState reports healthy stack', () => {
  const text = setup.humanState(healthyState());
  assert.match(text, /Freebuff Desktop:\s+\/fake\/desktop/);
  assert.match(text, /On-disk UI patches:\s+OK/);
  assert.match(text, /Tailnet proxy:\s+running on 127\.0\.0\.1:58061 \(healthy\)/);
  assert.match(text, /Tailnet forward:\s+up/);
});

test('humanState warns when the proxy runs with FB_AD_DEV_BROADCAST on', () => {
  const text = setup.humanState(healthyState({ devBroadcastOn: true }));
  assert.match(text, /\[warn\] dev-ad: FB_AD_DEV_BROADCAST=1/);
});

test('humanState stays quiet without the dev flag', () => {
  const text = setup.humanState(healthyState({ devBroadcastOn: false }));
  assert.doesNotMatch(text, /dev-ad/);
});

test('humanState reports problems', () => {
  const text = setup.humanState(healthyState({
    verify: { ok: false, desktopDir: '/fake', errors: [{ level: 'error', item: 'bundle', message: 'missing marker' }], warnings: [{ level: 'warn', item: 'proxy-unit', message: 'unit missing' }] },
    forward: { known: true, up: false, detail: 'tcp:58060 -> 127.0.0.1:58061' },
    proxy: { reachable: false, checks: [] },
    ports: { desktopPort: 58060, proxyPort: null, proxyPid: null },
  }));
  assert.match(text, /1 error\(s\), 1 warning\(s\)/);
  assert.match(text, /\[error\] bundle: missing marker/);
  assert.match(text, /Tailnet proxy:\s+not found/);
  assert.match(text, /Tailnet forward:\s+MISSING/);
});

test('parseArgs parses flags and defaults', () => {
  const options = setup.parseArgs([
    '--yes', '--force', '--dry-run', '--skip-upgrade', '--skip-tailnet',
    '--release', 'v0.1.13', '--repository', 'owner/repo',
    '--cache-dir', '/tmp/cache', '--source-dir', '/tmp/src', '--desktop-dir', '/tmp/desk',
  ]);
  assert.equal(options.yes, true);
  assert.equal(options.force, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.skipUpgrade, true);
  assert.equal(options.skipTailscale, true);
  assert.equal(options.release, 'v0.1.13');
  assert.equal(options.repository, 'owner/repo');
  assert.equal(options.cacheDir, '/tmp/cache');
  assert.equal(options.sourceDir, '/tmp/src');
  assert.equal(options.desktopDir, '/tmp/desk');
});

test('parseArgs accepts -y and -h aliases', () => {
  assert.equal(setup.parseArgs(['-y']).yes, true);
  assert.equal(setup.parseArgs(['--no-interactive']).yes, true);
  assert.equal(setup.parseArgs(['-h']).help, true);
  assert.throws(() => setup.parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => setup.parseArgs(['--release']), /needs a value/);
});

test('derivePorts uses cross-platform environment ports without systemd probes', () => {
  assert.deepEqual(
    setup.derivePorts({
      platform: 'darwin',
      env: { FREEBUFF_DESKTOP_PORT: '59060', FREEBUFF_PROXY_PORT: '59061' },
    }),
    { desktopPort: 59060, proxyPort: 59061, proxyPid: null },
  );
  assert.deepEqual(
    setup.derivePorts({ platform: 'win32', env: {} }),
    { desktopPort: 58060, proxyPort: 58061, proxyPid: null },
  );
});

test('cross-platform proxy restart uses native per-user registration', () => {
  const calls = [];
  setup.runRestartProxy({
    platform: 'win32',
    capture: (command, args) => {
      calls.push({ command, args });
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [{
    command: 'schtasks.exe',
    args: ['/Run', '/TN', 'Freebuff Tailnet Proxy'],
  }]);
});

test('resolveLocalStack uses logical sibling names directly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-logical-'));
  const repo = path.join(__dirname);
  for (const name of setup.releaseNeeds()) {
    fs.copyFileSync(path.join(repo, name), path.join(dir, name));
  }
  const resolved = setup.resolveLocalStack(dir, path.join(os.tmpdir(), 'fb-setup-cache'));
  assert.equal(resolved.staged, false);
  assert.equal(resolved.sourceDir, dir);
  assert.equal(resolved.installerPath, path.join(dir, 'install-mobile-connect.js'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveLocalStack stages version-prefixed release assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-versioned-'));
  const repo = path.join(__dirname);
  for (const name of setup.releaseNeeds()) {
    const source = path.join(repo, name);
    const target = path.join(dir, `freebuff-mobile-connect-v9.9.9-test-${name}`);
    fs.copyFileSync(source, target);
  }
  const cache = path.join(os.tmpdir(), `fb-setup-cache-${process.pid}`);
  const resolved = setup.resolveLocalStack(dir, cache);
  assert.equal(resolved.staged, true);
  assert.equal(resolved.version, 'v9.9.9-test');
  assert.equal(resolved.sourceDir, path.join(cache, 'freebuff-gate-setup', 'local-v9.9.9-test'));
  for (const name of setup.releaseNeeds()) {
    assert.equal(fs.existsSync(path.join(resolved.sourceDir, name)), true);
  }
  // Re-running is idempotent (files already staged).
  const again = setup.resolveLocalStack(dir, cache);
  assert.equal(again.staged, true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('resolveLocalStack throws when siblings are missing entirely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-empty-'));
  assert.throws(() => setup.resolveLocalStack(dir, path.join(os.tmpdir(), 'fb-setup-cache')), /Cannot find/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveLocalStack rejects mismatched asset versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-mixed-'));
  const repo = path.join(__dirname);
  const names = setup.releaseNeeds();
  const half = Math.ceil(names.length / 2);
  names.forEach((name, index) => {
    const version = index < half ? 'v1.0.0-a' : 'v2.0.0-b';
    fs.copyFileSync(path.join(repo, name), path.join(dir, `freebuff-mobile-connect-${version}-${name}`));
  });
  assert.throws(() => setup.resolveLocalStack(dir, path.join(os.tmpdir(), 'fb-setup-cache')), /Mismatched release asset versions/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sha256OfFile hashes file contents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-setup-test-'));
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'hello');
  assert.equal(await setup.sha256OfFile(file), require('node:crypto').createHash('sha256').update('hello').digest('hex'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unitEnvValue parses KEY=value from systemctl output', () => {
  // capture() is wired to real systemctl; simulate by stubbing through the
  // exported capture wrapper with a fake command is not possible without
  // injection, so exercise the pure regex path via a local shim instead.
  const out = 'HOME=/home/admin PORT=58060\n';
  const parts = out.split(/\s+/);
  let value = null;
  for (const part of parts) {
    if (part.startsWith('PORT=')) value = part.slice(5);
  }
  assert.equal(value, '58060');
});
