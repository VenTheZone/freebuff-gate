'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CREATE_MARK,
  CLOSE_MARK1,
  CLOSE_MARK2,
  CLOSE_MARK3,
  CREATE_REUSE,
  SCROLL_MARK,
  SETSTATE_MARK,
} = require('./freebuff_tailnet_proxy');

const {
  LAUNCH_AGENT_LABEL,
  MANAGED_MARKER,
  PROXY_FILES,
  PROXY_SERVICE_NAME,
  SYSTEMD_SERVICE_NAME,
  WINDOWS_TASK_NAME,
  applyAutoStart,
  applyBundlePatch,
  applyIndexShim,
  applyOrchestratorPatches,
  autoStartPaths,
  defaultPaths,
  findFreebuffDesktop,
  install,
  installUiStack,
  launchAgentPlistSource,
  parseArgs,
  systemdUnitSource,
  uninstall,
  verifyUiStack,
  windowsTaskRun,
} = require('./install-mobile-connect');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mobile-installer-'));
}

function optionsFor(root, args = []) {
  return parseArgs([
    '--source-dir', path.resolve(__dirname),
    '--install-dir', path.join(root, 'agent'),
    '--config-file', path.join(root, 'config', 'desktop.json'),
    '--connector-credential-file', path.join(root, 'config', 'connector.json'),
    '--state-file', path.join(root, 'config', 'agent-state.json'),
    '--bin-dir', path.join(root, 'bin'),
    '--relay-http-url', 'https://relay.example.test',
    '--no-ui-patches',
    ...args,
  ], {
    platform: 'linux',
    home: root,
    env: { PATH: '' },
  });
}

test('installer writes companion files and never stores connector credentials', async () => {
  const root = tempRoot();
  try {
    const options = optionsFor(root, ['--agent-version', 'v2.3.4']);
    const result = await install(options);
    assert.equal(result.changed, true);
    assert.equal(result.config.relayHttpUrl, 'https://relay.example.test');
    assert.equal(result.config.agentVersion, 'v2.3.4');
    assert.equal(result.config.autoStart, false);
    assert.equal(result.config.relayWsUrl, 'wss://relay.example.test');
    assert.match(result.config.connectorId, /^c_/);

    const persisted = fs.readFileSync(result.paths.configFile, 'utf8');
    assert.equal(persisted.includes('connectorToken'), false);
    assert.equal(persisted.includes('provider'), false);
    assert.equal(fs.readFileSync(result.paths.launcher, 'utf8').includes(MANAGED_MARKER), true);
    assert.equal(fs.existsSync(path.join(result.paths.installDir, 'mobile-connect-agent.js')), true);
    assert.equal(fs.existsSync(path.join(result.paths.installDir, 'mobile-connect-protocol.js')), true);
    assert.equal(fs.existsSync(path.join(result.paths.installDir, 'mobile-connect-qr.js')), true);

    childProcess.execFileSync(process.execPath, ['--check', path.join(result.paths.installDir, 'freebuff-mobile-connect.js')]);
    const help = childProcess.execFileSync(result.paths.launcher, ['--help'], { encoding: 'utf8' });
    assert.match(help, /Freebuff mobile desktop relay agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer preserves existing upstream settings and derives relay WebSocket URL', async () => {
  const root = tempRoot();
  try {
    const first = await install(optionsFor(root, ['--upstream-url', 'http://127.0.0.1:59000']));
    const second = await install(optionsFor(root));
    assert.equal(second.config.upstreamUrl, 'http://127.0.0.1:59000');
    assert.equal(second.config.connectorId, first.config.connectorId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer provisions short-lived connector credentials into protected file', async () => {
  const root = tempRoot();
  try {
    const options = optionsFor(root, ['--enrollment-token', 'bootstrap-once']);
    options.requestJson = async (url, request) => {
      assert.equal(url, 'https://relay.example.test/v1/relay/enroll');
      assert.equal(request.headers.authorization, 'Bearer bootstrap-once');
      return {
        status: 201,
        data: {
          connectorId: request.body.connectorId,
          connectorToken: 'short-lived-token',
          connectorTokenExpiresAt: '2026-08-15T12:15:00.000Z',
          connectorRefreshToken: 'refresh-token',
          connectorRefreshTokenExpiresAt: '2026-11-13T12:00:00.000Z',
        },
      };
    };
    const result = await install(options);
    const credentials = JSON.parse(fs.readFileSync(result.config.connectorCredentialFile, 'utf8'));
    assert.equal(credentials.connectorToken, 'short-lived-token');
    assert.equal(credentials.connectorRefreshToken, 'refresh-token');
    assert.equal(fs.readFileSync(result.paths.configFile, 'utf8').includes('short-lived-token'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer rejects insecure non-loopback relay URLs before writing', async () => {
  const root = tempRoot();
  try {
    await assert.rejects(
      () => install(optionsFor(root, ['--relay-http-url', 'http://relay.example.test'])),
      /--relay-http-url must use HTTPS/,
    );
    assert.equal(fs.existsSync(path.join(root, 'agent')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run creates no files and uninstall preserves config unless purged', async () => {
  const root = tempRoot();
  try {
    const dryRun = await install({ ...optionsFor(root), dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(fs.existsSync(path.join(root, 'agent')), false);

    const installed = await install(optionsFor(root));
    const removed = uninstall({ ...optionsFor(root), command: 'uninstall' });
    assert.equal(removed.changed, true);
    assert.equal(fs.existsSync(installed.paths.configFile), true);
    assert.equal(fs.existsSync(installed.paths.installDir), false);

    uninstall({ ...optionsFor(root), command: 'uninstall', purge: true });
    assert.equal(fs.existsSync(installed.paths.configFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default paths keep Windows and Unix data separated', () => {
  const unix = defaultPaths({ platform: 'linux', home: '/home/tester', env: {} });
  const windows = defaultPaths({ platform: 'win32', home: 'C:\\Users\\tester', env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' } });
  assert.match(unix.installDir, /\.local[\\/]share[\\/]freebuff[\\/]mobile-connect$/);
  assert.match(windows.installDir, /Freebuff[\\/]mobile-connect$/);
  assert.notEqual(unix.configFile, windows.configFile);
});

test('auto-start definitions target per-user Linux, macOS, and Windows registrations', () => {
  const root = tempRoot();
  try {
    const parsed = parseArgs(['--auto-start'], { platform: 'linux', home: root, env: {} });
    assert.equal(parsed.autoStart, true);
    assert.equal(parsed.autoStartSpecified, true);
    const linux = autoStartPaths({ platform: 'linux', home: root, env: {} });
    assert.equal(linux.type, 'systemd-user');
    assert.equal(linux.name, SYSTEMD_SERVICE_NAME);
    assert.equal(linux.file, path.join(root, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME));
    const unit = systemdUnitSource('/usr/bin/node', path.join(root, 'with space', 'wrapper.js'));
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /ExecStart=.*with space.*wrapper\.js" serve/);

    const mac = autoStartPaths({ platform: 'darwin', home: root, env: {} });
    assert.equal(mac.type, 'launch-agent');
    assert.equal(mac.name, LAUNCH_AGENT_LABEL);
    assert.equal(mac.file, path.join(root, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`));
    const plist = launchAgentPlistSource('/usr/local/bin/node', '/Users/tester/Freebuff & wrapper.js');
    assert.match(plist, /RunAtLoad/);
    assert.match(plist, /Freebuff &amp; wrapper\.js/);

    const windows = autoStartPaths({ platform: 'win32', home: 'C:\\Users\\tester', env: {} });
    assert.equal(windows.type, 'task-scheduler');
    assert.equal(windows.name, WINDOWS_TASK_NAME);
    assert.equal(windows.file, null);
    assert.equal(
      windowsTaskRun('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\tester\\wrapper.js'),
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\wrapper.js" serve',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto-start refuses unmanaged file collisions', () => {
  const root = tempRoot();
  try {
    const registration = autoStartPaths({ platform: 'linux', home: root, env: {} });
    fs.mkdirSync(path.dirname(registration.file), { recursive: true });
    fs.writeFileSync(registration.file, '[Unit]\\nDescription=Someone else\\n');
    assert.throws(
      () => applyAutoStart({
        platform: 'linux', home: root, env: {}, autoStart: true,
        runPlatformCommand: () => {},
      }, path.join(root, 'wrapper.js')),
      /unmanaged auto-start registration/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- UI stack (steps 2-4): proxy deploy + on-disk patches ----------------------------------

function fakeDesktop(root) {
  const orchRoot = path.join(root, 'desktop', 'squashfs-root', 'resources', 'orchestrator');
  const uiDir = path.join(orchRoot, 'ui');
  const assets = path.join(uiDir, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const stockBundle = `const APP_BOOT=()=>{${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};};`;
  fs.writeFileSync(path.join(assets, 'index-ABC.js'), stockBundle);
  fs.writeFileSync(path.join(uiDir, 'index.html'), `<!doctype html><head><title>t</title></head><body></body></html>`);
  const stockOrch = [
    'let match12 = findRoute(routes, req.method, pathname);',
    'return json3({ error: "upgrade required" }, 426);',
    '      }',
    '      let match12 = findRoute(routes, req.method, pathname);',
    'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {',
    '  return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
  ].join('\n');
  fs.writeFileSync(path.join(orchRoot, 'orchestrator.js'), stockOrch);
  return { root: path.join(root, 'desktop'), orchRoot, uiDir };
}

function uiOptions(root, desktop, args = []) {
  return parseArgs([
    '--source-dir', path.resolve(__dirname),
    '--install-dir', path.join(root, 'agent'),
    '--config-file', path.join(root, 'config', 'desktop.json'),
    '--bin-dir', path.join(root, 'bin'),
    '--desktop-dir', desktop,
    '--relay-http-url', 'https://relay.example.test',
    ...args,
  ], {
    platform: 'linux',
    home: root,
    env: { PATH: '' },
  });
}

function recordingCommands() {
  const calls = [];
  const runPlatformCommand = (command, args, options) => {
    calls.push({ command, args, options });
  };
  return { calls, runPlatformCommand };
}

test('ui stack deploys proxy and patches bundle/shim/orchestrator, idempotently', async () => {
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    const options = uiOptions(root, fake.root);
    const { calls, runPlatformCommand } = recordingCommands();
    const first = installUiStack(options, {}, { runPlatformCommand });
    assert.equal(first.enabled, true);
    for (const file of PROXY_FILES) {
      assert.equal(fs.existsSync(path.join(first.proxy, file)), true, `proxy file ${file}`);
    }
    assert.match(first.applied.join(' '), /bundle:index-ABC\.js:patched/);
    assert.match(first.applied.join(' '), /shim:patched/);
    assert.match(first.applied.join(' '), /orchestrator:routes,perf-helper/);

    const bundle = fs.readFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'utf8');
    assert.equal(bundle.includes(CREATE_REUSE), true);
    const html = fs.readFileSync(path.join(fake.uiDir, 'index.html'), 'utf8');
    assert.equal(html.includes('fb-desktop-shim'), true);
    assert.match(html, /fb-desktop-shim[\s\S]*<\/script>[\s\S]*<\/head>/);
    const orch = fs.readFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'utf8');
    assert.equal(orch.includes('/api/fb/dirlist'), true);
    assert.equal(orch.includes('/api/fb/perf-report'), true);
    assert.equal(orch.includes('async function injectPerfProbe('), true);
    assert.equal(orch.includes('"cache-control": "no-store"'), true);
    assert.match(orch, /perf-report\.log/);
    assert.equal(calls.some((c) => c.command === 'systemctl' && c.args[1] === 'restart'), true);
    assert.equal(fs.existsSync(path.join(root, '.config', 'systemd', 'user', PROXY_SERVICE_NAME)), true);

    // Idempotent second run: nothing changes, outcomes report already-patched.
    const before = fs.readFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'utf8');
    const second = installUiStack(options, {}, { runPlatformCommand });
    assert.match(second.applied.join(' '), /bundle:index-ABC\.js:already-patched/);
    assert.match(second.applied.join(' '), /shim:already-patched/);
    assert.match(second.applied.join(' '), /orchestrator:already-patched/);
    assert.equal(fs.readFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui: missing patch anchors fail loudly instead of silently regressing', async () => {
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'const stock = 1;');
    const options = uiOptions(root, fake.root);
    const { runPlatformCommand } = recordingCommands();
    assert.throws(
      () => installUiStack(options, {}, { runPlatformCommand }),
      /did not match any patch anchor/,
    );

    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), `const x=${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};`);
    fs.writeFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'const m=42;');
    assert.throws(
      () => installUiStack(options, {}, { runPlatformCommand }),
      /route anchor not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify: reports healthy stack, then fails loudly on each wiped patch', async () => {
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    const options = uiOptions(root, fake.root);
    const { runPlatformCommand } = recordingCommands();
    installUiStack(options, {}, { runPlatformCommand });

    const healthy = verifyUiStack(options);
    assert.equal(healthy.ok, true, JSON.stringify(healthy.errors));
    assert.deepEqual(healthy.errors, []);

    // App update wipes the bundle: patch markers gone -> verify fails.
    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'const stock = 1;');
    let report = verifyUiStack(options);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item.startsWith('bundle:')), true);
    assert.match(report.errors[0].message, /CREATE_REUSE/);

    // Shim tag missing.
    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), `const x=${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};`);
    fs.writeFileSync(path.join(fake.uiDir, 'index.html'), '<!doctype html><head></head></html>');
    report = verifyUiStack(options);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item === 'shim'), true);

    // Orchestrator update wipes dirlist + perf routes.
    installUiStack(options, {}, { runPlatformCommand });
    fs.writeFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'const m=42;');
    report = verifyUiStack(options);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item === 'orchestrator.routes'), true);
    assert.equal(report.errors.some((e) => e.item === 'orchestrator.perf'), true);

    // Missing desktop dir itself fails.
    report = verifyUiStack({ ...options, desktopDir: path.join(root, 'nope') });
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item === 'desktop'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui: desktop discovery finds the squashfs layout and uninstall keeps on-disk patches', async () => {
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    assert.equal(findFreebuffDesktop({ candidates: [fake.root] }), fake.root);
    const options = uiOptions(root, fake.root);
    const { runPlatformCommand } = recordingCommands();
    installUiStack(options, {}, { runPlatformCommand });
    const orchBefore = fs.readFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'utf8');
    uninstall({ ...options, command: 'uninstall' });
    // Proxy unit + dir removed; on-disk patches intentionally preserved.
    assert.equal(fs.existsSync(path.join(root, '.config', 'systemd', 'user', PROXY_SERVICE_NAME)), false);
    const orchAfter = fs.readFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'utf8');
    assert.equal(orchAfter, orchBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto-start defaults and lifecycle is opt-in and command-injectable', () => {
  const root = tempRoot();
  try {
    const calls = [];
    const runPlatformCommand = (command, args, options) => {
      calls.push({ command, args, options });
    };
    const linuxOptions = {
      platform: 'linux',
      home: root,
      env: {},
      autoStart: true,
      nodePath: '/usr/bin/node',
      runPlatformCommand,
    };
    const enabled = applyAutoStart(linuxOptions, path.join(root, 'wrapper.js'));
    assert.equal(enabled.enabled, true);
    assert.equal(fs.existsSync(enabled.file), true);
    assert.match(fs.readFileSync(enabled.file, 'utf8'), /Managed by Freebuff/);
    assert.deepEqual(calls.map((call) => call.args[1]), ['daemon-reload', 'enable', 'restart']);

    calls.length = 0;
    const disabled = applyAutoStart({ ...linuxOptions, autoStart: false }, path.join(root, 'wrapper.js'), {
      previouslyEnabled: true,
    });
    assert.equal(disabled.enabled, false);
    assert.equal(fs.existsSync(enabled.file), false);
    assert.deepEqual(calls.map((call) => call.args[1]), ['stop', 'disable', 'daemon-reload']);

    const macCalls = [];
    const mac = applyAutoStart({
      platform: 'darwin',
      home: root,
      env: {},
      uid: '501',
      autoStart: true,
      runPlatformCommand: (command, args) => macCalls.push({ command, args }),
    }, path.join(root, 'mac-wrapper.js'));
    assert.equal(mac.enabled, true);
    assert.equal(macCalls[1].args[0], 'bootstrap');
    assert.equal(fs.readFileSync(mac.file, 'utf8').includes(LAUNCH_AGENT_LABEL), true);

    const windowsCalls = [];
    const windows = applyAutoStart({
      platform: 'win32',
      home: root,
      env: {},
      autoStart: true,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      runPlatformCommand: (command, args) => windowsCalls.push({ command, args }),
    }, 'C:\\Users\\tester\\wrapper.js');
    assert.equal(windows.enabled, true);
    assert.equal(windowsCalls[0].command, 'schtasks.exe');
    assert.equal(windowsCalls[0].args[0], '/Create');
    applyAutoStart({
      platform: 'win32',
      home: root,
      env: {},
      autoStart: false,
      runPlatformCommand: (command, args) => windowsCalls.push({ command, args }),
    }, 'C:\\Users\\tester\\wrapper.js', { previouslyEnabled: true });
    assert.equal(windowsCalls.at(-1).args[0], '/Delete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
