'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LAUNCH_AGENT_LABEL,
  MANAGED_MARKER,
  SYSTEMD_SERVICE_NAME,
  WINDOWS_TASK_NAME,
  applyAutoStart,
  autoStartPaths,
  defaultPaths,
  install,
  launchAgentPlistSource,
  parseArgs,
  systemdUnitSource,
  uninstall,
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

test('auto-start enable and disable lifecycle is opt-in and command-injectable', () => {
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
