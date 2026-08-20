'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLOSE_BTN_MARK,
  CREATE_MARK,
  CLOSE_MARK1,
  CLOSE_MARK2,
  CLOSE_MARK3,
  CREATE_REUSE,
  SCROLL_MARK,
  SETSTATE_MARK,
  SKILL_ORIGIN_MARK,
} = require('./freebuff_tailnet_proxy');

// Stock request2() from the orchestrator bundle: the auto-run prompt
// builder the shadow-detect patch rewrites.
const STOCK_REQUEST2 = [
  'function request2(ctx, segment) {',
  '  let extra = ctx.skills.map((s) => s.name).filter((name31) => name31 !== AUTORUN_SKILL_NAME && !BUILTIN_DECISION_SKILLS.has(name31));',
  '  return [',
  '    bones(segment, ctx.root) || "(no new agent output)",',
  '    extra.length ? `This project also has these skills: ${extra.join(", ")}.` : "",',
  '    "The tab is now idle and nothing is queued. What happens next?"',
  '  ].filter(Boolean).join(`\n\n`);',
  '}',
].join('\n');

// Stock enqueueAutorunInputs() head: the queue-item note builder the
// shadow-note patch rewrites so the override warning reaches the UI.
const STOCK_ENQUEUE_AUTORUN = [
  '  enqueueAutorunInputs(id2, decision) {',
  '    let thread = this.threads.get(id2), note = [',
  '      decision.why.trim(),',
  '      decision.declined.length ? `Declined: ${decision.declined.join("; ")}` : ""',
  '    ].filter(Boolean).join(`\n`), rejected = [], rows = [], position = this.queue.maxPosition(id2, "queued"), createdAt = Date.now();',
].join('\n');

const {
  LAUNCH_AGENT_LABEL,
  MANAGED_MARKER,
  PROXY_FILES,
  PROXY_LAUNCH_AGENT_LABEL,
  PROXY_SERVICE_NAME,
  PROXY_WINDOWS_TASK_NAME,
  SYSTEMD_SERVICE_NAME,
  UI_SOURCE_SIDECAR,
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
  proxyAutoStartPaths,
  proxyLaunchAgentPlistSource,
  proxyWindowsTaskRun,
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
  const mac = defaultPaths({ platform: 'darwin', home: '/Users/tester', env: {} });
  const windows = defaultPaths({ platform: 'win32', home: 'C:\\Users\\tester', env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' } });
  assert.match(unix.installDir, /\.local[\\/]share[\\/]freebuff[\\/]mobile-connect$/);
  assert.equal(mac.installDir, path.join('/Users/tester', 'Library', 'Application Support', 'Freebuff', 'mobile-connect'));
  assert.equal(mac.configFile, path.join('/Users/tester', 'Library', 'Preferences', 'Freebuff', 'mobile-connect-desktop.json'));
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
    const seaUnit = systemdUnitSource(
      '/opt/Freebuff/freebuff-setup',
      path.join(root, 'with space', 'wrapper.js'),
      ['--run-agent'],
    );
    assert.match(seaUnit, /ExecStart=.*freebuff-setup.*--run-agent.*with space.*wrapper\.js" serve/);

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

test('proxy auto-start definitions cover Linux, macOS, and Windows', () => {
  const root = tempRoot();
  try {
    const linux = proxyAutoStartPaths({ platform: 'linux', home: root, env: {} });
    assert.equal(linux.type, 'systemd-user');
    assert.equal(linux.name, PROXY_SERVICE_NAME);

    const mac = proxyAutoStartPaths({ platform: 'darwin', home: root, env: {} });
    assert.equal(mac.type, 'launch-agent');
    assert.equal(mac.name, PROXY_LAUNCH_AGENT_LABEL);
    assert.equal(mac.file, path.join(root, 'Library', 'LaunchAgents', `${PROXY_LAUNCH_AGENT_LABEL}.plist`));
    const plist = proxyLaunchAgentPlistSource('/usr/local/bin/node', '/Users/tester/proxy.js');
    assert.match(plist, new RegExp(PROXY_LAUNCH_AGENT_LABEL));
    assert.match(plist, /proxy\.js/);
    const seaPlist = proxyLaunchAgentPlistSource(
      '/Applications/Freebuff/freebuff-setup',
      '/Users/tester/proxy.js',
      ['--run-proxy'],
    );
    assert.match(seaPlist, /freebuff-setup[\s\S]*--run-proxy[\s\S]*proxy\.js/);

    const windows = proxyAutoStartPaths({ platform: 'win32', home: 'C:\\Users\\tester', env: {} });
    assert.equal(windows.type, 'task-scheduler');
    assert.equal(windows.name, PROXY_WINDOWS_TASK_NAME);
    assert.equal(
      proxyWindowsTaskRun('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\tester\\proxy.js'),
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\proxy.js"',
    );
    assert.equal(
      proxyWindowsTaskRun(
        'C:\\Program Files\\Freebuff\\freebuff-setup.exe',
        'C:\\Users\\tester\\proxy.js',
        ['--run-proxy'],
      ),
      '"C:\\Program Files\\Freebuff\\freebuff-setup.exe" "--run-proxy" "C:\\Users\\tester\\proxy.js"',
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
  const stockBundle = `const APP_BOOT=()=>{${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};${CLOSE_BTN_MARK};${SKILL_ORIGIN_MARK};};`;
  fs.writeFileSync(path.join(assets, 'index-ABC.js'), stockBundle);
  fs.writeFileSync(path.join(uiDir, 'index.html'), `<!doctype html><head><title>t</title></head><body></body></html>`);
  const stockOrch = [
    'let match12 = findRoute(routes, req.method, pathname);',
    'return json3({ error: "upgrade required" }, 426);',
    '      }',
    '      let match12 = findRoute(routes, req.method, pathname);',
    'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {',
    '  return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
    STOCK_REQUEST2,
    STOCK_ENQUEUE_AUTORUN,
    'function getDefaultSkillsDirs(cwd) {',
    '  let home = os5.homedir();',
    '  return [',
    '    path11.join(home, ".claude", SKILLS_DIR_NAME),',
    '    path11.join(home, ".agents", SKILLS_DIR_NAME),',
    '    path11.join(cwd, ".claude", SKILLS_DIR_NAME),',
    '    path11.join(cwd, ".agents", SKILLS_DIR_NAME)',
    '  ];',
    '}',
    'async function loadSkillFromDisk(projectRoot, skillName) {',
    '  let home = os2.homedir(), skillsDirs = [',
    '    path7.join(projectRoot, ".agents", SKILLS_DIR_NAME),',
    '    path7.join(home, ".agents", SKILLS_DIR_NAME),',
    '  ];',
    '}',
    'agentSkillsDirs: [',
    '          join25(homedir7(), ".claude", "skills"),',
    '          join25(homedir7(), ".agents", "skills"),',
    '          join25(root, ".claude", "skills"),',
    '          join25(root, ".agents", "skills")',
    '        ]',
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

test('installUiStack resolves the default command runner when deps are omitted', () => {
  // Regression: the destructuring default used to reference its own binding
  // (`{ runPlatformCommand = runPlatformCommand }`), which throws a TDZ
  // ReferenceError the moment a caller passes {} as the deps argument.
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    const options = uiOptions(root, fake.root);
    // A missing desktop dir makes findFreebuffDesktop throw before any
    // platform command can run, proving the parameter resolves cleanly.
    options.desktopDir = path.join(root, 'no-such-desktop');
    assert.throws(
      () => installUiStack(options, {}, {}),
      /Freebuff Desktop directory does not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui stack registers proxy auto-start on macOS and Windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const root = tempRoot();
    try {
      const fake = fakeDesktop(root);
      const env = platform === 'win32'
        ? { LOCALAPPDATA: path.join(root, 'AppData', 'Local'), PATH: '' }
        : { PATH: '' };
      const options = parseArgs([
        '--source-dir', path.resolve(__dirname),
        '--install-dir', path.join(root, 'agent'),
        '--config-file', path.join(root, 'config', 'desktop.json'),
        '--bin-dir', path.join(root, 'bin'),
        '--desktop-dir', fake.root,
        '--relay-http-url', 'https://relay.example.test',
      ], { platform, home: root, env });
      options.nodePath = platform === 'win32'
        ? 'C:\\Program Files\\Freebuff\\freebuff-setup.exe'
        : '/Applications/Freebuff/freebuff-setup';
      options.proxyRuntimeArgs = ['--run-proxy'];
      const recording = recordingCommands();
      installUiStack(options, {}, recording);
      const names = recording.calls.map((call) => call.command);
      assert.ok(platform === 'darwin' ? names.includes('launchctl') : names.includes('schtasks.exe'));
      if (platform === 'darwin') {
        const registration = proxyAutoStartPaths(options);
        assert.match(fs.readFileSync(registration.file, 'utf8'), /--run-proxy/);
      } else {
        const task = recording.calls.find((call) => call.command === 'schtasks.exe' && call.args.includes('/TR'));
        assert.match(task.args[task.args.indexOf('/TR') + 1], /--run-proxy/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('applyOrchestratorPatches upgrades a stale partial route block', () => {
  // Regression: an older patch left dirlist+perf-report but predates the
  // upload/read-file routes. The marker check (dirlist present) used to skip
  // the re-patch, so upload/read-file were never added on-disk. The patcher
  // must replace the stale block with the full current one.
  const root = tempRoot();
  try {
    const orchFile = path.join(root, 'orchestrator.js');
    const legacyBlock = [
      '      if (pathname === "/api/fb/dirlist") {',
      '        let entries = [];',
      '        return json3({ path: root, entries });',
      '      }',
      '      if (pathname === "/api/fb/perf-report") {',
      '        return json3({ ok: true });',
      '      }',
    ].join('\n');
    const legacyOrch = [
      'let match12 = findRoute(routes, req.method, pathname);',
      'return json3({ error: "upgrade required" }, 426);',
      '      }',
      legacyBlock,
      '      let match12 = findRoute(routes, req.method, pathname);',
      'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {',
      '  return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
      STOCK_REQUEST2,
      STOCK_ENQUEUE_AUTORUN,
      'function getDefaultSkillsDirs(cwd) {',
      '  let home = os5.homedir();',
      '  return [',
      '    path11.join(home, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(home, ".agents", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".agents", SKILLS_DIR_NAME)',
      '  ];',
      '}',
      'async function loadSkillFromDisk(projectRoot, skillName) {',
      '  let home = os2.homedir(), skillsDirs = [',
      '    path7.join(projectRoot, ".agents", SKILLS_DIR_NAME),',
      '    path7.join(home, ".agents", SKILLS_DIR_NAME),',
      '  ];',
      '}',
      'agentSkillsDirs: [',
      '          join25(homedir7(), ".claude", "skills"),',
      '          join25(homedir7(), ".agents", "skills"),',
      '          join25(root, ".claude", "skills"),',
      '          join25(root, ".agents", "skills")',
      '        ]',
    ].join('\n');
    fs.writeFileSync(orchFile, legacyOrch);

    applyOrchestratorPatches(orchFile, {
      configDir: path.join(root, 'config'),
      uploadsDir: path.join(root, 'uploads'),
      perfProbePath: path.join(root, 'perf-probe.js'),
    });

    const out = fs.readFileSync(orchFile, 'utf8');
    for (const mark of ['/api/fb/dirlist', '/api/fb/perf-report', '/api/fb/upload', '/api/fb/read-file']) {
      assert.equal(out.includes(mark), true, `${mark} present after upgrade`);
    }
    assert.equal(out.split('/api/fb/dirlist').length - 1, 1, 'dirlist not duplicated');
    assert.equal(out.split('let match12 = findRoute(routes, req.method, pathname);').length - 1, 2, 'route tail intact');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    // Deploy-source sidecar lets the running proxy serve newer repo UI files.
    const sidecarPath = path.join(first.proxy, UI_SOURCE_SIDECAR);
    assert.equal(fs.existsSync(sidecarPath), true, 'ui-source.json sidecar written');
    assert.equal(
      JSON.parse(fs.readFileSync(sidecarPath, 'utf8')).sourceDir,
      path.resolve(options.sourceDir),
      'sidecar records the deploy source dir',
    );
    assert.match(first.applied.join(' '), /bundle:index-ABC\.js:patched/);
    assert.match(first.applied.join(' '), /shim:patched/);
    assert.match(first.applied.join(' '), /orchestrator:routes,perf-helper/);

    const bundle = fs.readFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'utf8');
    assert.equal(bundle.includes(CREATE_REUSE), true);
    const html = fs.readFileSync(path.join(fake.uiDir, 'index.html'), 'utf8');
    assert.equal(html.includes('fb-desktop-shim'), true);
    assert.equal(html.includes('fb-connected-folder-grid-v2'), true);
    assert.match(html, /fb-desktop-shim[\s\S]*<\/script>[\s\S]*<\/head>/);
    const orch = fs.readFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'utf8');
    assert.equal(orch.includes('/api/fb/dirlist'), true);
    assert.equal(orch.includes('/api/fb/perf-report'), true);
    assert.equal(orch.includes('/api/fb/upload'), true);
    assert.equal(orch.includes('/api/fb/read-file'), true);
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

    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), `const x=${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};${CLOSE_BTN_MARK};${SKILL_ORIGIN_MARK};`);
    fs.writeFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'const m=42;');
    assert.throws(
      () => installUiStack(options, {}, { runPlatformCommand }),
      /route anchor not found/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyOrchestratorPatches adds Pi skill dirs to all orchestrator discovery points, idempotently', () => {
  const root = tempRoot();
  try {
    const orchFile = path.join(root, 'orchestrator.js');
    const stock = [
      'let match12 = findRoute(routes, req.method, pathname);',
      'return json3({ error: "upgrade required" }, 426);',
      '      }',
      '      let match12 = findRoute(routes, req.method, pathname);',
      'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {',
      '  return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
      STOCK_REQUEST2,
      STOCK_ENQUEUE_AUTORUN,
      'function getDefaultSkillsDirs(cwd) {',
      '  let home = os5.homedir();',
      '  return [',
      '    path11.join(home, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(home, ".agents", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".agents", SKILLS_DIR_NAME)',
      '  ];',
      '}',
      'async function loadSkillFromDisk(projectRoot, skillName) {',
      '  let home = os2.homedir(), skillsDirs = [',
      '    path7.join(projectRoot, ".agents", SKILLS_DIR_NAME),',
      '    path7.join(home, ".agents", SKILLS_DIR_NAME),',
      '  ];',
      '}',
      'agentSkillsDirs: [',
      '          join25(homedir7(), ".claude", "skills"),',
      '          join25(homedir7(), ".agents", "skills"),',
      '          join25(root, ".claude", "skills"),',
      '          join25(root, ".agents", "skills")',
      '        ]',
    ].join('\n');
    fs.writeFileSync(orchFile, stock);

    applyOrchestratorPatches(orchFile, {
      configDir: path.join(root, 'config'),
      uploadsDir: path.join(root, 'uploads'),
      perfProbePath: path.join(root, 'perf-probe.js'),
    });

    const out = fs.readFileSync(orchFile, 'utf8');
    // The SkillStore splice keeps the closing entry (comma-less, last)
    // structurally intact after the new Pi entries.
    assert.equal(out.includes('          join25(root, ".pi", "skills"),\n          join25(root, ".agents", "skills")\n        ]'), true, 'pi root entry sits before the closing agentSkillsDirs entry');
    // Pi entries appear in all three discovery points.
    assert.equal(out.includes('path11.join(home, ".pi", "agent", SKILLS_DIR_NAME)'), true, 'home pi dir in getDefaultSkillsDirs');
    assert.equal(out.includes('path11.join(cwd, ".pi", SKILLS_DIR_NAME)'), true, 'cwd pi dir in getDefaultSkillsDirs');
    assert.equal(out.includes('path7.join(home, ".pi", "agent", SKILLS_DIR_NAME)'), true, 'home pi dir in loadSkillFromDisk');
    assert.equal(out.includes('path7.join(projectRoot, ".pi", SKILLS_DIR_NAME)'), true, 'project pi dir in loadSkillFromDisk');
    assert.equal(out.includes('join25(homedir7(), ".pi", "agent", "skills")'), true, 'home pi dir in SkillStore');
    assert.equal(out.includes('join25(root, ".pi", "skills")'), true, 'root pi dir in SkillStore');
    // Marked once each, no duplicates on a second run.
    assert.equal(out.split('/* freebuff-pi-skills */').length - 1, 3, 'three insertion markers');
    assert.equal(out.split('path11.join(home, ".agents", SKILLS_DIR_NAME)').length - 1, 1, 'agents home dir not duplicated');

    applyOrchestratorPatches(orchFile, {
      configDir: path.join(root, 'config'),
      uploadsDir: path.join(root, 'uploads'),
      perfProbePath: path.join(root, 'perf-probe.js'),
    });
    const second = fs.readFileSync(orchFile, 'utf8');
    assert.equal(second, out, 'idempotent: no changes on re-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyOrchestratorPatches adds shadowed-skill detection to auto-run request2', () => {
  const root = tempRoot();
  try {
    const orchFile = path.join(root, 'orchestrator.js');
    const stock = [
      'let match12 = findRoute(routes, req.method, pathname);',
      'return json3({ error: "upgrade required" }, 426);',
      '      }',
      '      let match12 = findRoute(routes, req.method, pathname);',
      'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {',
      '  return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
      STOCK_REQUEST2,
      STOCK_ENQUEUE_AUTORUN,
      'function getDefaultSkillsDirs(cwd) {',
      '  let home = os5.homedir();',
      '  return [',
      '    path11.join(home, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(home, ".agents", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".claude", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".agents", SKILLS_DIR_NAME)',
      '  ];',
      '}',
      'async function loadSkillFromDisk(projectRoot, skillName) {',
      '  let home = os2.homedir(), skillsDirs = [',
      '    path7.join(projectRoot, ".agents", SKILLS_DIR_NAME),',
      '    path7.join(home, ".agents", SKILLS_DIR_NAME),',
      '  ];',
      '}',
      'agentSkillsDirs: [',
      '          join25(homedir7(), ".claude", "skills"),',
      '          join25(homedir7(), ".agents", "skills"),',
      '          join25(root, ".claude", "skills"),',
      '          join25(root, ".agents", "skills")',
      '        ]',
    ].join('\n');
    fs.writeFileSync(orchFile, stock);

    applyOrchestratorPatches(orchFile, {
      configDir: path.join(root, 'config'),
      uploadsDir: path.join(root, 'uploads'),
      perfProbePath: path.join(root, 'perf-probe.js'),
    });

    const out = fs.readFileSync(orchFile, 'utf8');
    assert.equal(
      out.includes('let shadowed = ctx.skills.filter((s) => BUILTIN_DECISION_SKILLS.has(s.name) && s.source !== "managed");'),
      true,
      'shadow detection present',
    );
    assert.equal(
      out.includes('are SHADOWED by user-installed skills'),
      true,
      'prompt note present',
    );
    assert.equal(out.includes('...notes,'), true, 'notes spread into prompt');
    assert.equal(out.includes(STOCK_REQUEST2), false, 'stock request2 replaced');
    assert.equal(
      out.includes('/* freebuff-shadow-note */'),
      true,
      'shadow-note marker present',
    );
    assert.equal(
      out.includes('this.deps.skills.list(this.root).some((s) => s.name === n && s.source !== "managed")'),
      true,
      'queue note shadow warning present',
    );
    assert.equal(
      (out.match(/\/\* freebuff-shadow-note \*\//g) || []).length,
      1,
      'exactly one shadow-note block',
    );

    // Idempotent second run: no duplicate shadow block.
    applyOrchestratorPatches(orchFile, {
      configDir: path.join(root, 'config'),
      uploadsDir: path.join(root, 'uploads'),
      perfProbePath: path.join(root, 'perf-probe.js'),
    });
    const second = fs.readFileSync(orchFile, 'utf8');
    assert.equal(
      (second.match(/let shadowed = ctx.skills/g) || []).length,
      1,
      'shadow block not duplicated',
    );
    assert.equal(
      (second.match(/\/\* freebuff-shadow-note \*\//g) || []).length,
      1,
      'shadow-note block not duplicated',
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
    const installed = installUiStack(options, {}, { runPlatformCommand });

    const healthy = verifyUiStack(options);
    assert.equal(healthy.ok, true, JSON.stringify(healthy.errors));
    assert.deepEqual(healthy.errors, []);

    // A proxy can keep serving stale injected assets even when all Desktop
    // bundle patch markers remain present. With the ui-source.json sidecar
    // the proxy self-heals by serving the newer SOURCE copy, so drift is a
    // warning; without the sidecar (older installs) the stale copy is what
    // gets served, so it stays an error that demands a re-run.
    fs.appendFileSync(path.join(installed.proxy, 'mobile-ui.js'), '\n// stale deployed asset\n');
    fs.appendFileSync(path.join(installed.proxy, 'mobile-ui.css'), '\n/* stale deployed asset */\n');
    let report = verifyUiStack(options);
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.warnings.some((e) => e.item === 'proxy-ui'), true);
    assert.match(
      report.warnings.find((e) => e.item === 'proxy-ui').message,
      /mobile-ui\.css, mobile-ui\.js/,
    );
    fs.unlinkSync(path.join(installed.proxy, UI_SOURCE_SIDECAR));
    report = verifyUiStack(options);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item === 'proxy-ui'), true);
    assert.match(report.errors.find((e) => e.item === 'proxy-ui').message, /mobile-ui\.css, mobile-ui\.js/);

    // App update wipes the bundle: patch markers gone -> verify fails.
    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), 'const stock = 1;');
    report = verifyUiStack(options);
    assert.equal(report.ok, false);
    assert.equal(report.errors.some((e) => e.item.startsWith('bundle:')), true);
    assert.match(report.errors[0].message, /CREATE_REUSE/);

    // Shim tag missing.
    fs.writeFileSync(path.join(fake.uiDir, 'assets', 'index-ABC.js'), `const x=${CREATE_MARK};${SETSTATE_MARK};${SCROLL_MARK};${CLOSE_MARK1};${CLOSE_MARK2};${CLOSE_MARK3};${CLOSE_BTN_MARK};${SKILL_ORIGIN_MARK};`);
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
    uninstall({ ...options, command: 'uninstall', runPlatformCommand });
    // Proxy unit + dir removed; on-disk patches intentionally preserved.
    assert.equal(fs.existsSync(path.join(root, '.config', 'systemd', 'user', PROXY_SERVICE_NAME)), false);
    const orchAfter = fs.readFileSync(path.join(fake.orchRoot, 'orchestrator.js'), 'utf8');
    assert.equal(orchAfter, orchBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ui: uninstall leaves a running tailnet proxy unit and files in place', () => {
  const root = tempRoot();
  try {
    const fake = fakeDesktop(root);
    const options = uiOptions(root, fake.root);
    const { calls, runPlatformCommand } = recordingCommands();
    const activeCommands = (command, args, opts) => {
      calls.push({ command, args, opts });
      // Only the proxy unit is "active"; everything else reports stopped.
      return args.includes('is-active') ? true : undefined;
    };
    installUiStack(options, {}, { runPlatformCommand: activeCommands });
    const proxyUnit = path.join(root, '.config', 'systemd', 'user', PROXY_SERVICE_NAME);
    assert.equal(fs.existsSync(proxyUnit), true);
    uninstall({ ...options, command: 'uninstall', runPlatformCommand: activeCommands });
    // Live proxy survives uninstall: unit kept, no stop/disable calls.
    assert.equal(fs.existsSync(proxyUnit), true);
    const proxyCalls = calls.filter((c) => c.args.includes(PROXY_SERVICE_NAME));
    assert.equal(proxyCalls.some((c) => c.args.includes('stop')), false);
    assert.equal(proxyCalls.some((c) => c.args.includes('disable')), false);
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

test('standalone runtime mode is carried into companion launcher and service', async () => {
  const root = tempRoot();
  try {
    const options = optionsFor(root, ['--auto-start']);
    const calls = [];
    Object.assign(options, {
      nodePath: '/opt/Freebuff/freebuff-setup',
      agentRuntimeArgs: ['--run-agent'],
      runPlatformCommand: (command, args) => calls.push({ command, args }),
    });
    const result = await install(options);
    const launcher = fs.readFileSync(result.paths.launcher, 'utf8');
    const unit = fs.readFileSync(result.paths.autoStartFile, 'utf8');
    assert.match(launcher, /freebuff-setup.*--run-agent/);
    assert.match(unit, /freebuff-setup.*--run-agent/);
    assert.equal(calls.some((call) => call.args.includes('restart')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
