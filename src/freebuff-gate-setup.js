#!/usr/bin/env node
'use strict';

// Freebuff Gate setup wizard.
//
// Interactive companion to install-mobile-connect.js: detects the Freebuff
// Desktop install, reports the state of the whole stack (on-disk UI patches,
// tailnet proxy, served UI, tailnet forward), and offers to fix whatever is
// missing — install/upgrade the proxy + UI patches, re-apply the tailscale
// serve forward, restart a stale proxy. Every value is derived from the live
// system: ports come from the desktop unit's PORT env and the proxy's actual
// listen socket, never from literals.
//
//   node freebuff-gate-setup.js            interactive
//   node freebuff-gate-setup.js --yes      apply every needed fix without prompts
//   node freebuff-gate-setup.js --dry-run  report state + plan without changes
//   node freebuff-gate-setup.js --release v0.1.13   fetch release assets instead
//                                       of using sibling files (works standalone)
//
// The wizard ships in the toolchain release so it can run next to the other
// assets or fetch them itself.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');

// The installer is a sibling in the repo/staged layout but may be absent when
// the wizard runs as a bare release asset (version-prefixed siblings), so
// load it lazily and fall back to static file lists until it is resolved.
let localInstaller = null;
try {
  localInstaller = require('./install-mobile-connect');
} catch {
  localInstaller = null;
}

const PRODUCT_NAME = 'freebuff-mobile-connect';
const DESKTOP_SERVICE = 'freebuff-desktop.service';
const DEFAULT_REPOSITORY = 'VenTheZone/freebuff-gate';
// Files the wizard needs when it fetches/stages a release: the installer, its
// agent dependencies (installer requires mobile-connect-agent at load), and
// the proxy stack it deploys.
const STACK_FILES_FALLBACK = Object.freeze([
  'install-mobile-connect.js',
  'mobile-connect-agent.js',
  'mobile-connect-protocol.js',
  'mobile-connect-qr.js',
  'freebuff_tailnet_proxy.js',
  'mobile-ui.css',
  'mobile-ui.js',
  'perf-probe.js',
]);

function releaseNeeds() {
  if (localInstaller) {
    return [
      'install-mobile-connect.js',
      ...localInstaller.AGENT_FILES,
      ...localInstaller.PROXY_FILES,
    ];
  }
  return STACK_FILES_FALLBACK;
}

function proxyServiceName() {
  return (localInstaller && localInstaller.PROXY_SERVICE_NAME) || 'freebuff-tailnet-proxy.service';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function capture(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { ok: false, error: result.error.message, stdout: '', stderr: '' };
  }
  return { ok: result.status === 0, status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function releaseAssetName(version, logicalName) {
  // Same naming protocol as src/package-mobile-connect-release.js assetName().
  return `${PRODUCT_NAME}-${version}-${logicalName}`;
}

function unitEnvValue(unit, key) {
  const out = capture('systemctl', ['--user', 'show', unit, '-p', 'Environment', '--value']);
  if (!out.ok) return null;
  for (const part of out.stdout.split(/\s+/)) {
    if (part.startsWith(`${key}=`)) return part.slice(key.length + 1);
  }
  return null;
}

function unitMainPid(unit) {
  const out = capture('systemctl', ['--user', 'show', unit, '-p', 'MainPID', '--value']);
  if (!out.ok) return null;
  const pid = Number(String(out.stdout || '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function listenPortsOfPid(pid) {
  const out = capture('ss', ['-tlnp']);
  if (!out.ok) return [];
  const ports = [];
  for (const line of out.stdout.split('\n')) {
    if (!line.includes(`pid=${pid},`)) continue;
    const match = line.match(/127\.0\.0\.1:(\d+)/);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ ok: true, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ ok: false, error: error.message, status: 0, body: '' }));
  });
}

async function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.promises.readFile(file));
  return hash.digest('hex');
}

// The wizard can run from three layouts:
//   1. repo/src or a staged release dir: sibling files with logical names
//      (install-mobile-connect.js, freebuff_tailnet_proxy.js, ...)
//   2. a raw release asset dir: version-prefixed names
//      (freebuff-mobile-connect-v0.1.13-install-mobile-connect.js, ...)
//   3. standalone, with --release: assets fetched into a cache dir
// Layout 2 is staged into the cache dir under logical names so sibling
// requires and the installer's sourceDir lookups keep working.
function resolveLocalStack(dir, cacheRoot) {
  const logicalPresent = releaseNeeds().every((name) => fs.existsSync(path.join(dir, name)));
  if (logicalPresent) {
    return { sourceDir: dir, installerPath: path.join(dir, 'install-mobile-connect.js'), staged: false };
  }

  const prefix = `${PRODUCT_NAME}-`;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const versions = new Set();
  for (const logical of releaseNeeds()) {
    const suffix = `-${logical}`;
    const match = entries.find((entry) => entry.startsWith(prefix) && entry.endsWith(suffix));
    if (!match) {
      throw new Error(
        `Cannot find ${logical} beside the wizard (looked for logical and ${prefix}<version>${suffix} names in ${dir}); ` +
        'run the bootstrap installer, pass --source-dir, or use --release',
      );
    }
    versions.add(match.slice(0, -suffix.length).slice(prefix.length));
  }
  if (versions.size !== 1) {
    throw new Error(`Mismatched release asset versions in ${dir}: ${[...versions].join(', ')}`);
  }
  const version = [...versions][0];
  const stagedDir = path.join(cacheRoot, 'freebuff-gate-setup', `local-${version}`);
  for (const logical of releaseNeeds()) {
    const source = path.join(dir, `${prefix}${version}-${logical}`);
    const target = path.join(stagedDir, logical);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.copyFileSync(source, target);
  }
  return {
    sourceDir: stagedDir,
    installerPath: path.join(stagedDir, 'install-mobile-connect.js'),
    staged: true,
    version,
  };
}

// ---------------------------------------------------------------------------
// State discovery (read-only)
// ---------------------------------------------------------------------------

function derivePorts(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'linux') {
    const readPort = (name, fallback) => {
      const value = Number(options[name] || env[name === 'desktopPort' ? 'FREEBUFF_DESKTOP_PORT' : 'FREEBUFF_PROXY_PORT'] || fallback);
      return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
    };
    return {
      desktopPort: readPort('desktopPort', 58060),
      proxyPort: readPort('proxyPort', 58061),
      proxyPid: null,
    };
  }
  // Orchestrator port: the desktop unit's PORT env; fall back to the desktop
  // process's loopback listen socket.
  let desktopPort = null;
  const envPort = unitEnvValue(DESKTOP_SERVICE, 'PORT');
  if (envPort && /^\d+$/.test(envPort)) {
    desktopPort = Number(envPort);
  } else {
    const pid = unitMainPid(DESKTOP_SERVICE);
    const ports = pid ? listenPortsOfPid(pid) : [];
    if (ports.length > 0) desktopPort = ports[0];
  }

  // Proxy port: the proxy's own loopback listen socket, like
  // restore-tailnet-forward.sh does.
  let proxyPort = null;
  const proxyPid = unitMainPid(proxyServiceName());
  const proxyPorts = proxyPid ? listenPortsOfPid(proxyPid) : [];
  if (proxyPorts.length > 0) proxyPort = proxyPorts[0];

  return { desktopPort, proxyPort, proxyPid };
}

function httpPost(url, body = '') {
  return new Promise((resolve) => {
    const request = http.request(url, { method: 'POST', timeout: 4000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ ok: true, status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ ok: false, error: error.message, status: 0, body: '' }));
    request.end(body);
  });
}

async function probeProxyHealth(proxyPort, desktopPort) {
  if (!proxyPort) return { reachable: false, checks: [] };
  const html = await httpGet(`http://127.0.0.1:${proxyPort}/`);
  if (!html.ok) return { reachable: false, checks: [] };
  const checks = [
    { name: 'serves dashboard HTML', ok: html.status === 200 },
    { name: 'shim tag (fb-desktop-shim)', ok: html.body.includes('fb-desktop-shim') },
    { name: 'mobile UI inject (fb-session-switch)', ok: html.body.includes('fb-session-switch') },
    { name: 'new-session button (fb-new-session)', ok: html.body.includes('fb-new-session') },
  ];
  const bundleMatch = html.body.match(/\/assets\/index-[A-Za-z0-9_.-]+\.js/);
  if (bundleMatch) {
    const bundle = await httpGet(`http://127.0.0.1:${proxyPort}${bundleMatch[0]}`);
    checks.push({
      name: `bundle patch (${path.basename(bundleMatch[0])})`,
      ok: bundle.ok && bundle.body.includes('__fbOpenThread'),
    });
  } else {
    checks.push({ name: 'bundle patch', ok: false });
  }
  // Upload route, checked with POST (the routes are POST handlers; a GET
  // probe 404s even when the route is present). The proxy handles uploads
  // locally, so probe both the proxy and the on-disk orchestrator directly.
  const proxyUpload = await httpPost(`http://127.0.0.1:${proxyPort}/api/fb/upload?name=probe.txt`, 'probe');
  checks.push({ name: 'upload route (proxy)', ok: proxyUpload.ok && proxyUpload.status === 200 });
  if (desktopPort) {
    const orchUpload = await httpPost(`http://127.0.0.1:${desktopPort}/api/fb/upload`, '');
    checks.push({ name: 'upload route (orchestrator)', ok: orchUpload.ok && orchUpload.status !== 404 && orchUpload.status < 500 });
  }
  return { reachable: true, checks };
}

function tailscaleServeStatus() {
  const out = capture('tailscale', ['serve', 'status']);
  return out.ok ? out.stdout : null;
}

// Parse `tailscale serve status` into forward pairs:
//   |-- tcp://host:58060 (tailnet only)
//   |--> tcp://127.0.0.1:58061
function parseServeTargets(output) {
  if (!output) return [];
  const pairs = [];
  let current = null;
  for (const raw of output.split('\n')) {
    if (!raw.includes('tcp:') || raw.includes('[')) continue;
    const line = raw.trim();
    let match = line.match(/^\|--\s+tcp:\/\/([^:/]+):(\d+)/);
    if (match) {
      current = { publicPort: Number(match[2]), host: match[1] };
      continue;
    }
    match = line.match(/^\|-->\s+tcp:\/\/([^:/]+):(\d+)/);
    if (match && current) {
      current.target = { host: match[1], port: Number(match[2]) };
      pairs.push(current);
      current = null;
    }
  }
  return pairs;
}

async function collectState(options, installerModule) {
  const mod = installerModule || installer;
  let desktopDir = null;
  let verify = null;
  try {
    desktopDir = mod.findFreebuffDesktop({
      desktopDir: options.desktopDir,
      home: options.home,
      env: options.env,
      platform: options.platform,
    });
    verify = mod.verifyUiStack({
      desktopDir,
      home: options.home,
      env: options.env,
      platform: options.platform,
    });
  } catch (error) {
    verify = {
      ok: false,
      desktopDir: null,
      errors: [{ level: 'error', item: 'desktop', message: error.message }],
      warnings: [],
    };
  }
  const ports = derivePorts(options);
  const proxy = await probeProxyHealth(ports.proxyPort, ports.desktopPort);
  // Leftover dev flag on the proxy masks real ad fills with the placeholder.
  // Read it from the live process env (drop-ins set it outside the unit file).
  let devBroadcastOn = false;
  if ((options.platform || process.platform) === 'linux' && ports.proxyPid) {
    try {
      const environ = fs.readFileSync(`/proc/${ports.proxyPid}/environ`, 'utf8');
      devBroadcastOn = environ.split('\0').includes('FB_AD_DEV_BROADCAST=1');
    } catch {
      devBroadcastOn = false;
    }
  }
  const serveOutput = tailscaleServeStatus();
  const targets = parseServeTargets(serveOutput);
  let forward = { known: false, up: false, detail: null };
  if (ports.desktopPort && ports.proxyPort) {
    const match = targets.find((target) => (
      target.publicPort === ports.desktopPort && target.target && target.target.port === ports.proxyPort
    ));
    forward = {
      known: true,
      up: Boolean(match),
      detail: `tcp:${ports.desktopPort} -> 127.0.0.1:${ports.proxyPort}`,
    };
  }
  return { desktopDir, verify, ports, proxy, devBroadcastOn, forward };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function runRestartProxy(options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.capture || capture;
  let command;
  let args;
  if (platform === 'darwin') {
    const uid = options.uid || (typeof process.getuid === 'function' ? process.getuid() : null);
    if (uid == null) throw new Error('Cannot determine macOS GUI user id for proxy restart');
    command = 'launchctl';
    args = ['kickstart', '-k', `gui/${uid}/com.freebuff.tailnet-proxy`];
  } else if (platform === 'win32') {
    command = 'schtasks.exe';
    args = ['/Run', '/TN', 'Freebuff Tailnet Proxy'];
  } else {
    command = 'systemctl';
    args = ['--user', 'restart', proxyServiceName()];
  }
  const result = execute(command, args);
  if (!result.ok) {
    throw new Error(`restarting Freebuff tailnet proxy failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function runRestartOrchestrator(options = {}) {
  if ((options.platform || process.platform) !== 'linux') {
    throw new Error('Restart Freebuff Desktop from its app menu, then refresh setup');
  }
  // The on-disk orchestrator patch only activates after the orchestrator
  // (the Desktop app's Bun server) reloads its file.
  const result = capture('systemctl', ['--user', 'restart', DESKTOP_SERVICE]);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`restarting ${DESKTOP_SERVICE} failed${detail ? `: ${detail}` : ''}`);
  }
}

function applyTailscaleForward(desktopPort, proxyPort) {
  const result = capture('tailscale', ['serve', '--bg', '--tcp', String(desktopPort), `tcp://127.0.0.1:${proxyPort}`]);
  if (result.ok) return { ok: true, note: null };
  const detail = (result.stderr || result.stdout || '').trim();
  const denied = /denied|permission/i.test(detail);
  return {
    ok: false,
    note: denied
      ? `tailscaled denied the serve write. Run once to enable non-root automation:\n  sudo tailscale set --operator=${(process.env.USER || (() => { try { return os.userInfo().username; } catch { return 'user'; } })())}`
      : `tailscale serve failed: ${detail}`,
  };
}

function planActions(state, options) {
  const actions = [];
  const orchUpload = state.proxy.checks.find((check) => check.name === 'upload route (orchestrator)');
  const orchUploadFailing = Boolean(orchUpload && !orchUpload.ok);
  const staleServe = state.proxy.checks.some((check) => !check.ok);
  if (!options.skipUpgrade) {
    if (!state.verify.ok) {
      // On-disk patches missing (bundle/shim/orchestrator markers) — the
      // installer re-applies them.
      actions.push({ id: 'upgrade', description: 'Configure tailnet proxy + apply on-disk UI patches' });
    } else if (!state.proxy.reachable) {
      actions.push({ id: 'upgrade', description: 'Configure tailnet proxy (not running)' });
    } else if (staleServe && !orchUploadFailing) {
      // Served checks stale while on-disk patches are healthy — restart.
      actions.push({ id: 'restart', description: 'Restart tailnet proxy (served UI checks stale)' });
    }
  }
  if ((!options.platform || options.platform === 'linux') && !options.skipUpgrade && state.verify.ok && orchUploadFailing) {
    // Patches are on disk but the running orchestrator predates them: the
    // Desktop Bun server must reload the patched file to serve the routes.
    actions.push({ id: 'restart-orchestrator', description: `Restart ${DESKTOP_SERVICE} to load the patched orchestrator` });
  }
  if (!options.skipTailscale && state.forward.known && !state.forward.up) {
    actions.push({ id: 'tailscale', description: `Re-apply tailnet forward ${state.forward.detail}` });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Reporting + prompting
// ---------------------------------------------------------------------------

function humanState(state) {
  const lines = [];
  lines.push(`Freebuff Desktop:   ${state.desktopDir || 'NOT FOUND'}`);
  if (state.verify) {
    const { errors, warnings } = state.verify;
    const summary = errors.length === 0 && warnings.length === 0
      ? 'OK (bundle, shim, orchestrator patches present)'
      : `${errors.length} error(s), ${warnings.length} warning(s)`;
    lines.push(`On-disk UI patches:  ${summary}`);
    for (const problem of [...(errors || []), ...(warnings || [])]) {
      lines.push(`  [${problem.level}] ${problem.item}: ${problem.message}`);
    }
  }
  if (state.ports.proxyPort) {
    const healthy = state.proxy.reachable && state.proxy.checks.every((check) => check.ok);
    lines.push(`Tailnet proxy:       running on 127.0.0.1:${state.ports.proxyPort} (${healthy ? 'healthy' : 'health checks failing'})`);
    if (state.proxy.reachable) {
      for (const check of state.proxy.checks) lines.push(`  ${check.ok ? 'ok   ' : 'FAIL '} ${check.name}`);
    }
  } else {
    lines.push('Tailnet proxy:       not found (is the service installed and running?)');
  }
  if (state.forward.known) {
    lines.push(`Tailnet forward:     ${state.forward.up ? 'up    ' : 'MISSING'} ${state.forward.detail}`);
  } else {
    lines.push('Tailnet forward:     unknown (tailscale serve status unavailable)');
  }
  if (state.devBroadcastOn) {
    lines.push('  [warn] dev-ad: FB_AD_DEV_BROADCAST=1 is set on the running proxy — placeholder ads mask real fills; remove the drop-in/env and restart');
  }
  return lines.join('\n');
}

async function confirmYesNo(question, defaultYes = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? ' [Y/n]' : ' [y/N]';
    const answer = await rl.question(`${question}${suffix} `);
    const text = answer.trim().toLowerCase();
    if (text === '') return defaultYes;
    return /^y(es)?$/.test(text);
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Release asset fetch (standalone mode)
// ---------------------------------------------------------------------------

async function fetchToFile(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status}): ${url}`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function ensureReleaseAssets(release, repository, cacheRoot) {
  const version = release.startsWith('v') ? release : `v${release}`;
  const base = `https://github.com/${repository || DEFAULT_REPOSITORY}/releases/download/${version}`;
  const dir = path.join(cacheRoot, 'freebuff-gate-setup', version);
  await fs.promises.mkdir(dir, { recursive: true });

  let sums = null;
  const sumsName = releaseAssetName(version, 'SHA256SUMS');
  try {
    const response = await fetch(`${base}/${sumsName}`, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const text = await response.text();
      sums = new Map(text.split('\n').filter(Boolean).map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name, hash];
      }));
    }
  } catch {
    sums = null;
  }

  for (const logicalName of releaseNeeds()) {
    const name = releaseAssetName(version, logicalName);
    const target = path.join(dir, logicalName);
    let existing = null;
    try {
      existing = await sha256OfFile(target);
    } catch {
      existing = null;
    }
    const expected = sums ? sums.get(name) : null;
    if (existing && (!expected || existing === expected)) continue;
    await fetchToFile(`${base}/${name}`, target);
    if (sums && expected) {
      const actual = await sha256OfFile(target);
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
      }
    }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Freebuff Gate setup wizard

Usage:
  node freebuff-gate-setup.js [options]

Options:
  --yes                    Apply every needed fix without prompting
  --force                  Overwrite unmanaged proxy unit/auto-start files
  --dry-run                Report state + planned actions, change nothing
  --advanced               Select self-hosted/local transport path
  --skip-upgrade           Do not install/upgrade the proxy or UI patches
  --skip-tailnet           Do not touch the tailscale serve forward
  --source-dir <dir>       Take proxy/installer files from <dir> (default: this file's dir)
  --desktop-dir <path>     Freebuff Desktop install dir (auto-detected when omitted)
  --release <vX.Y.Z>       Fetch installer + proxy assets from a GitHub release
  --repository <owner/repo>  Release repository (default: VenTheZone/freebuff-gate)
  --cache-dir <dir>        Download cache (default: XDG_CACHE_HOME or ~/.cache)
  --help                   Show this help

Examples:
  node freebuff-gate-setup.js                        interactive setup
  node freebuff-gate-setup.js --dry-run              inspect only
  node freebuff-gate-setup.js --no-interactive       apply everything needed without prompts

Exits 0 when the stack is healthy, non-zero when fixes failed or remain.`);
}

function parseArgs(argv) {
  const standaloneRuntime = process.env.FREEBUFF_SETUP_RUNTIME === 'sea';
  const options = {
    yes: false,
    force: false,
    dryRun: false,
    skipUpgrade: false,
    skipTailscale: false,
    advanced: false,
    sourceDir: path.resolve(__dirname),
    desktopDir: process.env.FREEBUFF_DESKTOP_DIR || null,
    release: null,
    repository: DEFAULT_REPOSITORY,
    cacheDir: null,
    nodePath: standaloneRuntime ? (process.env.FREEBUFF_SETUP_BINARY_PATH || process.execPath) : null,
    agentRuntimeArgs: standaloneRuntime ? ['--run-agent'] : [],
    proxyRuntimeArgs: standaloneRuntime ? ['--run-proxy'] : [],
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--yes':
      case '-y':
      case '--no-interactive':
        options.yes = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-upgrade':
        options.skipUpgrade = true;
        break;
      case '--skip-tailnet':
        options.skipTailscale = true;
        break;
      case '--advanced':
        options.advanced = true;
        break;
      case '--source-dir':
        options.sourceDir = path.resolve(next());
        break;
      case '--desktop-dir':
        options.desktopDir = path.resolve(next());
        break;
      case '--release':
        options.release = next();
        break;
      case '--repository':
        options.repository = next();
        break;
      case '--cache-dir':
        options.cacheDir = path.resolve(next());
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  console.log('Freebuff Gate setup');
  console.log(''.padEnd(40, '-'));

  const cacheRoot = options.cacheDir || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');

  // Resolve installer/source: local sibling files (logical or versioned
  // names), or a downloaded release.
  let sourceDir = options.sourceDir;
  let installerModule = localInstaller;
  if (options.release) {
    const releaseDir = await ensureReleaseAssets(options.release, options.repository, cacheRoot);
    installerModule = require(path.join(releaseDir, 'install-mobile-connect.js'));
    sourceDir = releaseDir;
    console.log(`Using release assets from ${releaseDir}`);
  } else {
    const resolved = resolveLocalStack(options.sourceDir, cacheRoot);
    sourceDir = resolved.sourceDir;
    installerModule = require(resolved.installerPath);
    if (resolved.staged) {
      console.log(`Staged release assets from ${options.sourceDir} into ${resolved.sourceDir}`);
    }
  }

  const state = await collectState(options, installerModule);
  console.log();
  console.log('--- Current state ---');
  console.log(humanState(state));

  const actions = planActions(state, options);
  if (options.dryRun) {
    console.log();
    if (actions.length === 0) {
      console.log('Plan: no changes needed. Stack healthy.');
    } else {
      console.log('Plan (dry run, nothing applied):');
      for (const action of actions) console.log(`  ${action.description}`);
    }
    return state.verify && !state.verify.ok ? 1 : 0;
  }

  if (actions.length === 0) {
    console.log('\nNo changes needed — stack healthy.');
    return 0;
  }

  for (const action of actions) {
    let proceed = options.yes;
    if (!proceed) {
      proceed = await confirmYesNo(`\n${action.description}?`, action.id !== 'restart');
      if (!proceed) {
        console.log('  skipped.');
        continue;
      }
    }
    try {
      if (action.id === 'upgrade') {
        const stack = installerModule.installUiStack({ ...options, desktopDir: state.desktopDir, sourceDir });
        console.log(`  applied: ${stack.applied.join(', ')}`);
        if (stack.bestEffort && stack.bestEffort.length > 0) {
          console.log(`  best-effort cache-header patch: ${stack.bestEffort.join(', ')}`);
        }
      } else if (action.id === 'restart') {
        runRestartProxy(options);
        console.log('  applied: proxy restarted.');
      } else if (action.id === 'restart-orchestrator') {
        runRestartOrchestrator(options);
        console.log('  applied: orchestrator restarted.');
      } else if (action.id === 'tailscale') {
        const result = applyTailscaleForward(state.ports.desktopPort, state.ports.proxyPort);
        if (!result.ok) {
          console.error(`  FAILED: ${result.note}`);
          return 1;
        }
        console.log(`  applied: tailscale serve tcp:${state.ports.desktopPort} -> 127.0.0.1:${state.ports.proxyPort}`);
      }
    } catch (error) {
      console.error(`  FAILED: ${error.message}`);
      return 1;
    }
  }

  console.log('\n--- Post-setup status ---');
  const final = await collectState(options, installerModule);
  console.log(humanState(final));
  const healthy = final.verify.ok && final.forward.up && final.proxy.reachable && final.proxy.checks.every((c) => c.ok);
  console.log(healthy ? '\nSetup healthy.' : '\nSome checks still failing — see report above.');
  return final.verify.ok && final.forward.up && final.proxy.reachable ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  DEFAULT_REPOSITORY,
  STACK_FILES_FALLBACK,
  applyTailscaleForward,
  capture,
  collectState,
  derivePorts,
  ensureReleaseAssets,
  humanState,
  main,
  parseArgs,
  parseServeTargets,
  planActions,
  probeProxyHealth,
  releaseAssetName,
  releaseNeeds,
  resolveLocalStack,
  runRestartOrchestrator,
  runRestartProxy,
  sha256OfFile,
  unitEnvValue,
  unitMainPid,
};
