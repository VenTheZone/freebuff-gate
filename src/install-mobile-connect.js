#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { requestJson } = require('./mobile-connect-agent');
const { syncPiAssets } = require('./sync-pi-assets');

const AGENT_FILES = Object.freeze([
  'mobile-connect-agent.js',
  'mobile-connect-protocol.js',
  'mobile-connect-qr.js',
]);
const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:58061';
const MANIFEST_NAME = '.freebuff-mobile-connect.json';
const WRAPPER_NAME = 'freebuff-mobile-connect.js';
const UNIX_LAUNCHER_NAME = 'freebuff-mobile-connect';
const WINDOWS_LAUNCHER_NAME = 'freebuff-mobile-connect.cmd';
const MANAGED_MARKER = 'Managed by Freebuff mobile-connect installer';
const DEFAULT_AGENT_VERSION = 'local';
const SYSTEMD_SERVICE_NAME = 'freebuff-mobile-connect.service';
const PROXY_SERVICE_NAME = 'freebuff-tailnet-proxy.service';
const PROXY_FILES = Object.freeze([
  'freebuff_tailnet_proxy.js',
  'pi-agent-bridge.js',
  'mobile-ui.css',
  'mobile-ui.js',
  'perf-probe.js',
]);
const PROXY_UI_FILES = Object.freeze(['mobile-ui.css', 'mobile-ui.js']);
// Sidecar written next to the deployed proxy: records the directory the UI
// files were deployed from. The running proxy reads it and serves the
// SOURCE copy of mobile-ui.css/js when the source file is newer than the
// deployed one, so repo edits apply on reload without re-running install.
const UI_SOURCE_SIDECAR = 'ui-source.json';
const LAUNCH_AGENT_LABEL = 'com.freebuff.mobile-connect';
const WINDOWS_TASK_NAME = 'Freebuff Mobile Connect';
const PROXY_LAUNCH_AGENT_LABEL = 'com.freebuff.tailnet-proxy';
const PROXY_WINDOWS_TASK_NAME = 'Freebuff Tailnet Proxy';
const RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)*$/;

function randomConnectorId() {
  return `c_${crypto.randomBytes(12).toString('base64url')}`;
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function normalizeHttpUrl(value, field, { allowLocalHttp = false } = {}) {
  if (value == null || value === '') return null;
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  const localHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  const allowed = parsed.protocol === 'https:' || (allowLocalHttp && localHttp);
  if (!allowed) {
    throw new Error(`${field} must use HTTPS${allowLocalHttp ? ' (HTTP is allowed only for localhost)' : ''}`);
  }
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain credentials`);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizeWsUrl(value, field) {
  if (value == null || value === '') return null;
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  const local = isLoopbackHostname(parsed.hostname);
  const allowed = parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && local);
  if (!allowed) throw new Error(`${field} must use WSS (WS is allowed only for localhost)`);
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain credentials`);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function deriveWsUrl(httpUrl) {
  if (!httpUrl) return null;
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return parsed.toString().replace(/\/$/, '');
}

function defaultPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const windows = platform === 'win32';
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  if (windows) {
    const root = path.join(localAppData, 'Freebuff');
    return {
      installDir: path.join(root, 'mobile-connect'),
      proxyDir: path.join(root, 'tailnet-proxy'),
      configFile: path.join(root, 'mobile-connect-desktop.json'),
      stateFile: path.join(root, 'mobile-connect-agent.json'),
      connectorCredentialFile: path.join(root, 'mobile-connect-connector.json'),
      binDir: path.join(root, 'bin'),
      autoStartFile: null,
    };
  }

  if (platform === 'darwin') {
    const dataRoot = path.join(home, 'Library', 'Application Support', 'Freebuff');
    const configRoot = path.join(home, 'Library', 'Preferences', 'Freebuff');
    return {
      installDir: path.join(dataRoot, 'mobile-connect'),
      proxyDir: path.join(dataRoot, 'tailnet-proxy'),
      configFile: path.join(configRoot, 'mobile-connect-desktop.json'),
      stateFile: path.join(configRoot, 'mobile-connect-agent.json'),
      connectorCredentialFile: path.join(configRoot, 'mobile-connect-connector.json'),
      binDir: path.join(dataRoot, 'bin'),
      autoStartFile: path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
    };
  }

  const autoStartFile = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
    : path.join(configHome, 'systemd', 'user', SYSTEMD_SERVICE_NAME);
  return {
    installDir: path.join(dataHome, 'freebuff', 'mobile-connect'),
    proxyDir: path.join(dataHome, 'freebuff', 'tailnet-proxy'),
    configFile: path.join(configHome, 'freebuff', 'mobile-connect-desktop.json'),
    stateFile: path.join(configHome, 'freebuff', 'mobile-connect-agent.json'),
    connectorCredentialFile: path.join(configHome, 'freebuff', 'mobile-connect-connector.json'),
    binDir: env.XDG_BIN_HOME || path.join(home, '.local', 'bin'),
    autoStartFile,
  };
}

function usage() {
  console.log(`Freebuff Desktop mobile-connect installer

Commands:
  install             Install companion agent and launcher (default)
  uninstall           Remove installed agent and launcher
  verify              Verify the on-disk UI patches after an app update (exit
                      non-zero when bundle/shim/orchestrator markers missing)

Options:
  --relay-http-url <url>  Managed relay HTTPS URL
  --relay-ws-url <url>    Managed relay WSS URL (derived when omitted)
  --upstream-url <url>    Desktop UI URL (default: ${DEFAULT_UPSTREAM_URL})
  --connector-id <id>     Stable connector id
  --agent-version <v>     Version of downloaded agent files
  --enrollment-token <t>  Relay bootstrap token for provisioning
  --connector-credential-file <path>  Protected provisioned token file
  --state-file <path>     Agent state path
  --install-dir <path>    Agent files destination
  --config-file <path>    Config destination
  --bin-dir <path>        Launcher destination
  --source-dir <path>     Source directory (default: this repository's src)
  --dry-run               Show changes without writing
  --force                 Replace only installer-managed files
  --purge                 With uninstall, remove config and agent state
  --auto-start            Enable and start companion at user login
  --no-auto-start         Disable and remove companion auto-start registration
  --install-ui-patches    Deploy the tailnet proxy (systemd unit) and apply the
                          on-disk UI bundle/shim/orchestrator patches (default)
  --no-ui-patches         Skip proxy deploy and on-disk UI patches
  --desktop-dir <path>    Freebuff Desktop install dir (auto-discovered when
                          omitted; the shell bootstrap exports DESKTOP_DIR)

Commands:
  install             Install companion agent and launcher (default)
  uninstall           Remove installed agent and launcher
  verify              Verify the on-disk UI patches after an app update (exit
                      non-zero when bundle/shim/orchestrator markers missing)

Runtime:
  Pass --enrollment-token to provision connector credentials, or set
  FB_MOBILE_RELAY_CONNECTOR_TOKEN for legacy shared-token mode.
  Installer never stores provider credentials; provisioned connector tokens
  live in a protected local credential file.`);
}

function parseArgs(argv, context = {}) {
  const env = context.env || process.env;
  const paths = defaultPaths({
    platform: context.platform || process.platform,
    env,
    home: context.home || os.homedir(),
  });
  const options = {
    command: 'install',
    platform: context.platform || process.platform,
    home: context.home || os.homedir(),
    env,
    relayHttpUrl: env.FB_MOBILE_RELAY_HTTP_URL || null,
    relayWsUrl: env.FB_MOBILE_RELAY_WS_URL || null,
    upstreamUrl: env.FB_MOBILE_UI_URL || null,
    connectorId: env.FB_MOBILE_CONNECTOR_ID || null,
    agentVersion: env.FB_MOBILE_CONNECT_VERSION || null,
    enrollmentToken: env.FB_MOBILE_RELAY_ENROLLMENT_TOKEN || null,
    connectorCredentialFile: paths.connectorCredentialFile,
    stateFile: null,
    sourceDir: path.resolve(__dirname),
    installDir: paths.installDir,
    configFile: paths.configFile,
    binDir: paths.binDir,
    dryRun: false,
    force: false,
    purge: false,
    autoStart: false,
    autoStartSpecified: false,
    uiPatches: true,
    uiPatchesSpecified: false,
    desktopDir: env.DESKTOP_DIR || env.FREEBUFF_DESKTOP_DIR || null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case 'install': options.command = 'install'; break;
      case 'uninstall':
      case '--uninstall': options.command = 'uninstall'; break;
      case 'verify':
      case '--verify': options.command = 'verify'; break;
      case '--relay-http-url': options.relayHttpUrl = next(); break;
      case '--relay-ws-url': options.relayWsUrl = next(); break;
      case '--upstream-url': options.upstreamUrl = next(); break;
      case '--connector-id': options.connectorId = next(); break;
      case '--agent-version': options.agentVersion = next(); break;
      case '--enrollment-token': options.enrollmentToken = next(); break;
      case '--connector-credential-file': options.connectorCredentialFile = path.resolve(next()); break;
      case '--state-file': options.stateFile = next(); break;
      case '--install-dir': options.installDir = path.resolve(next()); break;
      case '--config-file': options.configFile = path.resolve(next()); break;
      case '--bin-dir': options.binDir = path.resolve(next()); break;
      case '--source-dir': options.sourceDir = path.resolve(next()); break;
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.force = true; break;
      case '--purge': options.purge = true; break;
      case '--auto-start': options.autoStart = true; options.autoStartSpecified = true; break;
      case '--no-auto-start': options.autoStart = false; options.autoStartSpecified = true; break;
      case '--install-ui-patches': options.uiPatches = true; options.uiPatchesSpecified = true; break;
      case '--no-ui-patches': options.uiPatches = false; options.uiPatchesSpecified = true; break;
      case '--desktop-dir': options.desktopDir = path.resolve(next()); break;
      case '--help':
      case '-h':
        usage();
        return { ...options, help: true };
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function normalizeAgentVersion(value) {
  if (value == null || value === '') return DEFAULT_AGENT_VERSION;
  const version = String(value).trim();
  if (version === DEFAULT_AGENT_VERSION) return version;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error('--agent-version must look like v1.2.3 or be local');
  }
  return version;
}

function validateOptions(options) {
  options.relayHttpUrl = normalizeHttpUrl(options.relayHttpUrl, '--relay-http-url');
  options.relayWsUrl = normalizeWsUrl(options.relayWsUrl, '--relay-ws-url');
  if (options.upstreamUrl) {
    options.upstreamUrl = normalizeHttpUrl(
      options.upstreamUrl,
      '--upstream-url',
      { allowLocalHttp: true },
    );
  }
  options.stateFile = path.resolve(options.stateFile || path.join(path.dirname(options.configFile), 'mobile-connect-agent.json'));
  options.connectorCredentialFile = path.resolve(
    options.connectorCredentialFile || path.join(path.dirname(options.configFile), 'mobile-connect-connector.json'),
  );
  if (options.relayHttpUrl && !options.relayWsUrl) options.relayWsUrl = deriveWsUrl(options.relayHttpUrl);
  if (options.relayWsUrl && !options.relayHttpUrl) {
    const parsed = new URL(options.relayWsUrl);
    parsed.protocol = 'https:';
    options.relayHttpUrl = parsed.toString().replace(/\/$/, '');
  }
  options.agentVersion = normalizeAgentVersion(options.agentVersion);
  return options;
}

async function provisionConnector(options, connectorId, request = requestJson) {
  if (!options.enrollmentToken) return null;
  if (!options.relayHttpUrl) {
    throw new Error('--enrollment-token requires --relay-http-url or existing relay configuration');
  }
  const result = await request(`${options.relayHttpUrl}/v1/relay/enroll`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.enrollmentToken}` },
    body: { connectorId },
  });
  if (result.status >= 400) {
    throw new Error(result.data?.message || `Relay returned HTTP ${result.status}`);
  }
  const data = result.data || {};
  if (
    data.connectorId !== connectorId ||
    typeof data.connectorToken !== 'string' ||
    typeof data.connectorRefreshToken !== 'string' ||
    typeof data.connectorTokenExpiresAt !== 'string'
  ) {
    throw new Error('Relay returned incomplete connector enrollment credentials');
  }
  return data;
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

function writeAtomically(file, content, mode = 0o600, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: options.directoryMode || 0o755 });
  if (options.protectDirectory) {
    try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode });
    try { fs.chmodSync(temp, mode); } catch {}
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function isManagedFile(file, marker = MANAGED_MARKER) {
  try {
    return fs.readFileSync(file, 'utf8').includes(marker);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function ensureInstallDirectory(options) {
  if (!fs.existsSync(options.installDir)) return;
  const entries = fs.readdirSync(options.installDir);
  if (entries.length === 0) return;
  const manifestFile = path.join(options.installDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestFile) && !options.force) {
    throw new Error(`Refusing to use non-empty unmanaged install directory: ${options.installDir}`);
  }
  if (fs.existsSync(manifestFile)) {
    const manifest = readJsonIfPresent(manifestFile);
    if (manifest.managedBy !== MANAGED_MARKER && !options.force) {
      throw new Error(`Install directory is not managed by this installer: ${options.installDir}`);
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wrapperSource(configFile) {
  return `#!/usr/bin/env node
// ${MANAGED_MARKER}
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configFile = ${JSON.stringify(configFile)};
let config;
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (error) {
  console.error(\`Cannot read Freebuff mobile-connect config: \${error.message}\`);
  process.exit(1);
}

const values = {
  FB_MOBILE_RELAY_HTTP_URL: config.relayHttpUrl,
  FB_MOBILE_RELAY_WS_URL: config.relayWsUrl,
  FB_MOBILE_UI_URL: config.upstreamUrl,
  FB_MOBILE_CONNECTOR_ID: config.connectorId,
  FB_MOBILE_AGENT_STATE_FILE: config.stateFile,
  FB_MOBILE_RELAY_CONNECTOR_CREDENTIAL_FILE: config.connectorCredentialFile,
};
for (const [name, value] of Object.entries(values)) {
  if (value && !process.env[name]) process.env[name] = value;
}

const { runCli } = require(path.join(__dirname, 'mobile-connect-agent.js'));
runCli(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(\`Error: \${error.message}\`); process.exitCode = 1; },
);
`;
}

function unixLauncherSource(nodePath, wrapperPath, runtimeArgs = []) {
  const command = [nodePath, ...runtimeArgs, wrapperPath].map(shellQuote).join(' ');
  return `#!/bin/sh
# ${MANAGED_MARKER}
exec ${command} "$@"
`;
}

function windowsLauncherSource(nodePath, wrapperPath, runtimeArgs = []) {
  const command = [nodePath, ...runtimeArgs, wrapperPath].map((value) => `"${value}"`).join(' ');
  return `@echo off
rem ${MANAGED_MARKER}
${command} %*
exit /b %errorlevel%
`;
}

function autoStartPaths(options = {}) {
  const platform = options.platform || process.platform;
  const defaults = defaultPaths({
    platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
  });
  if (platform === 'linux') {
    return {
      platform,
      type: 'systemd-user',
      name: SYSTEMD_SERVICE_NAME,
      file: defaults.autoStartFile,
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      type: 'launch-agent',
      name: LAUNCH_AGENT_LABEL,
      file: defaults.autoStartFile,
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      type: 'task-scheduler',
      name: WINDOWS_TASK_NAME,
      file: null,
    };
  }
  return {
    platform,
    type: 'unsupported',
    name: null,
    file: null,
  };
}

function systemdEscape(value) {
  const text = String(value).replace(/[\r\n]/g, '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\\\])/g, '\\\\$1')}"`;
}

function systemdUnitSource(nodePath, wrapperPath, runtimeArgs = []) {
  const command = [nodePath, ...runtimeArgs, wrapperPath, 'serve'].map(systemdEscape).join(' ');
  return `# ${MANAGED_MARKER}
[Unit]
Description=Freebuff Desktop mobile-connect companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function launchAgentPlistSource(nodePath, wrapperPath, runtimeArgs = []) {
  const argumentsXml = [nodePath, ...runtimeArgs, wrapperPath, 'serve']
    .map((value) => `        <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ${MANAGED_MARKER} -->
    <key>Label</key>
    <string>${xmlEscape(LAUNCH_AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

function windowsTaskRun(nodePath, wrapperPath, runtimeArgs = []) {
  for (const value of [nodePath, ...runtimeArgs, wrapperPath]) {
    if (/["\r\n]/.test(String(value))) throw new Error('Windows auto-start paths cannot contain quotes or newlines');
  }
  return [nodePath, ...runtimeArgs, wrapperPath]
    .map((value) => `"${value}"`)
    .concat('serve')
    .join(' ');
}

function ensureManagedAutoStartFile(file, options) {
  if (!file || !fs.existsSync(file)) return;
  if (!isManagedFile(file) && !options.force) {
    throw new Error(`Refusing to overwrite unmanaged auto-start registration: ${file}`);
  }
}

function runPlatformCommand(command, args, { ignoreFailure = false } = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (ignoreFailure) return false;
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (ignoreFailure) return false;
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

// Stable alias for default-parameter fallbacks: a destructuring default that
// references its own binding (`{ fn = fn }`) throws a TDZ ReferenceError, so
// callers that omit the dependency object would crash. Default to this
// module-level function instead.
const DEFAULT_RUN_PLATFORM_COMMAND = runPlatformCommand;

function macGuiTarget(options) {
  const uid = options.uid || (typeof process.getuid === 'function' ? process.getuid() : null);
  if (uid == null) throw new Error('Cannot determine macOS GUI user id for auto-start');
  return `gui/${uid}`;
}

function applyAutoStart(options, wrapperPath, { previouslyEnabled = false } = {}) {
  const registration = autoStartPaths(options);
  const execute = options.runPlatformCommand || runPlatformCommand;
  const enabled = Boolean(options.autoStart);
  const exists = previouslyEnabled || Boolean(registration.file && fs.existsSync(registration.file));
  const nodePath = options.nodePath || process.execPath;
  const runtimeArgs = options.agentRuntimeArgs || [];

  if (registration.type === 'unsupported') {
    if (enabled) {
      throw new Error(`Auto-start is unsupported on ${registration.platform}; use Linux, macOS, or Windows`);
    }
    return { ...registration, enabled: false, changed: false };
  }

  if (registration.type === 'systemd-user') {
    if (enabled) {
      ensureManagedAutoStartFile(registration.file, options);
      writeAtomically(registration.file, systemdUnitSource(nodePath, wrapperPath, runtimeArgs), 0o644);
      execute('systemctl', ['--user', 'daemon-reload']);
      execute('systemctl', ['--user', 'enable', registration.name]);
      execute('systemctl', ['--user', 'restart', registration.name]);
      return { ...registration, enabled: true, changed: true };
    }
    if (!exists) return { ...registration, enabled: false, changed: false };
    ensureManagedAutoStartFile(registration.file, options);
    execute('systemctl', ['--user', 'stop', registration.name], { ignoreFailure: true });
    execute('systemctl', ['--user', 'disable', registration.name], { ignoreFailure: true });
    const changed = Boolean(registration.file && fs.existsSync(registration.file));
    if (changed) fs.unlinkSync(registration.file);
    execute('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
    return { ...registration, enabled: false, changed };
  }

  if (registration.type === 'launch-agent') {
    const target = macGuiTarget(options);
    if (enabled) {
      ensureManagedAutoStartFile(registration.file, options);
      writeAtomically(registration.file, launchAgentPlistSource(nodePath, wrapperPath, runtimeArgs), 0o644);
      execute('launchctl', ['bootout', `${target}/${registration.name}`], { ignoreFailure: true });
      execute('launchctl', ['bootstrap', target, registration.file]);
      execute('launchctl', ['kickstart', '-k', `${target}/${registration.name}`]);
      return { ...registration, enabled: true, changed: true };
    }
    if (!exists) return { ...registration, enabled: false, changed: false };
    ensureManagedAutoStartFile(registration.file, options);
    execute('launchctl', ['bootout', `${target}/${registration.name}`], { ignoreFailure: true });
    const changed = Boolean(registration.file && fs.existsSync(registration.file));
    if (changed) fs.unlinkSync(registration.file);
    return { ...registration, enabled: false, changed };
  }

  if (registration.type === 'task-scheduler') {
    if (enabled) {
      execute('schtasks.exe', [
        '/Create',
        '/TN', registration.name,
        '/SC', 'ONLOGON',
        '/TR', windowsTaskRun(nodePath, wrapperPath, runtimeArgs),
        '/RL', 'LIMITED',
        '/F',
      ]);
      return { ...registration, enabled: true, changed: true };
    }
    if (!exists) return { ...registration, enabled: false, changed: false };
    execute('schtasks.exe', ['/Delete', '/TN', registration.name, '/F']);
    return { ...registration, enabled: false, changed: true };
  }

  return { ...registration, enabled: false, changed: false };
}

function configForInstall(options, existing = {}) {
  const relayHttpUrl = normalizeHttpUrl(
    options.relayHttpUrl || existing.relayHttpUrl,
    '--relay-http-url',
  );
  const relayWsUrl = normalizeWsUrl(
    options.relayWsUrl || existing.relayWsUrl || deriveWsUrl(relayHttpUrl),
    '--relay-ws-url',
  );
  return {
    version: 1,
    relayHttpUrl,
    relayWsUrl,
    upstreamUrl: normalizeHttpUrl(
      options.upstreamUrl || existing.upstreamUrl || DEFAULT_UPSTREAM_URL,
      '--upstream-url',
      { allowLocalHttp: true },
    ),
    connectorId: options.connectorId || existing.connectorId || randomConnectorId(),
    agentVersion: options.agentVersion || existing.agentVersion || DEFAULT_AGENT_VERSION,
    autoStart: Boolean(options.autoStart),
    stateFile: options.stateFile || existing.stateFile,
    connectorCredentialFile: options.connectorCredentialFile || existing.connectorCredentialFile,
  };
}

function printInstallSummary(options, config, paths) {
  console.log('Install Freebuff Desktop mobile-connect companion');
  console.log(`Agent files: ${paths.installDir}`);
  console.log(`Config: ${paths.configFile}`);
  console.log(`Launcher: ${paths.launcher}`);
  console.log(`Connector id: ${config.connectorId}`);
  console.log(`Agent release: ${config.agentVersion}`);
  console.log(`Connector credential file: ${config.connectorCredentialFile}`);
  if (config.autoStart) {
    const location = paths.autoStartFile || paths.autoStartName;
    console.log(`Auto-start: enabled (${paths.autoStartType}, ${location})`);
  } else {
    console.log('Auto-start: disabled (use --auto-start to enable)');
  }
  if (!config.relayHttpUrl) {
    console.warn('Warning: relay URL is not configured. Set FB_MOBILE_RELAY_HTTP_URL or reinstall with --relay-http-url.');
  }
  console.log('Connector credential: provision with --enrollment-token or provide legacy FB_MOBILE_RELAY_CONNECTOR_TOKEN at runtime.');
  if (!(process.env.PATH || '').split(path.delimiter).includes(paths.binDir)) {
    console.log(`Add ${paths.binDir} to PATH, then run: freebuff-mobile-connect serve`);
  } else {
    console.log('Run: freebuff-mobile-connect serve');
  }
}

// ---------------------------------------------------------------------------
// Freebuff Desktop UI stack (steps 2-4 of the install guide): the tailnet
// proxy on 58061 with a systemd user unit, plus the on-disk bundle/shim/
// orchestrator patches so DIRECT 58060 clients get the same fixes the proxy
// applies at serve time. Every patch is idempotent and marker-checked: an
// already-patched file is left alone, and a patch that cannot find its
// anchors fails LOUDLY instead of silently shipping an unpatched UI.
// ---------------------------------------------------------------------------
const DESKTOP_CANDIDATES = [
  path.join(os.homedir(), '.local', 'share', 'freebuff-desktop'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'freebuff-desktop'),
  path.join(os.homedir(), 'AppData', 'Local', 'freebuff-desktop'),
  '/Applications/Freebuff Desktop.app/Contents/Resources',
  '/usr/local/share/freebuff-desktop',
  '/opt/freebuff-desktop',
];
const DESKTOP_MARKERS = [
  'squashfs-root/resources/orchestrator/orchestrator.js',
  'resources/orchestrator/orchestrator.js',
  'orchestrator.js',
];

// Path to the orchestrator's data dir (ui/, assets/ live there).
function desktopOrchestratorDir(desktopDir) {
  return path.join(desktopDir, 'squashfs-root', 'resources', 'orchestrator');
}

function findFreebuffDesktop(options = {}) {
  const explicit = options.desktopDir || process.env.DESKTOP_DIR || process.env.FREEBUFF_DESKTOP_DIR;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Freebuff Desktop directory does not exist: ${explicit}`);
    return explicit;
  }
  const candidates = [...(options.candidates || []), ...DESKTOP_CANDIDATES];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    for (const marker of DESKTOP_MARKERS) {
      if (fs.existsSync(path.join(candidate, marker))) return candidate;
    }
  }
  throw new Error('Freebuff Desktop install was not found; pass --desktop-dir or run the bootstrap installer shell script');
}

function orchestratorDirOf(desktopDir) {
  const candidate = path.join(desktopDir, 'squashfs-root', 'resources', 'orchestrator');
  if (fs.existsSync(path.join(candidate, 'orchestrator.js'))) return candidate;
  const flat = path.join(desktopDir, 'resources', 'orchestrator');
  if (fs.existsSync(path.join(flat, 'orchestrator.js'))) return flat;
  return candidate;
}

function systemdProxyUnitSource(nodePath, proxyDir, runtimeArgs = []) {
  const proxyPath = path.join(proxyDir, 'freebuff_tailnet_proxy.js');
  const command = [nodePath, ...runtimeArgs, proxyPath].map(systemdEscape).join(' ');
  return `# ${MANAGED_MARKER}
[Unit]
Description=Freebuff Desktop tailnet proxy (UI injection, bundle patch, shim)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function proxyAutoStartPaths(options = {}) {
  const platform = options.platform || process.platform;
  const defaults = defaultPaths({
    platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
  });
  if (platform === 'linux') return {
    platform,
    type: 'systemd-user',
    name: PROXY_SERVICE_NAME,
    file: path.join(
      (options.env || process.env).XDG_CONFIG_HOME || path.join(options.home || os.homedir(), '.config'),
      'systemd',
      'user',
      PROXY_SERVICE_NAME,
    ),
    proxyDir: defaults.proxyDir,
  };
  if (platform === 'darwin') return {
    platform,
    type: 'launch-agent',
    name: PROXY_LAUNCH_AGENT_LABEL,
    file: path.join(options.home || os.homedir(), 'Library', 'LaunchAgents', `${PROXY_LAUNCH_AGENT_LABEL}.plist`),
    proxyDir: defaults.proxyDir,
  };
  if (platform === 'win32') return {
    platform,
    type: 'task-scheduler',
    name: PROXY_WINDOWS_TASK_NAME,
    file: null,
    proxyDir: defaults.proxyDir,
  };
  return { platform, type: 'unsupported', name: null, file: null, proxyDir: defaults.proxyDir };
}

function proxyLaunchAgentPlistSource(nodePath, proxyPath, runtimeArgs = []) {
  const argumentsXml = [nodePath, ...runtimeArgs, proxyPath]
    .map((value) => `        <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ${MANAGED_MARKER} -->
    <key>Label</key>
    <string>${xmlEscape(PROXY_LAUNCH_AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

function proxyWindowsTaskRun(nodePath, proxyPath, runtimeArgs = []) {
  for (const value of [nodePath, ...runtimeArgs, proxyPath]) {
    if (/["\r\n]/.test(String(value))) throw new Error('Windows proxy paths cannot contain quotes or newlines');
  }
  return [nodePath, ...runtimeArgs, proxyPath]
    .map((value) => `"${value}"`)
    .join(' ');
}

function applyProxyAutoStart(options, proxyDir, { runPlatformCommand = DEFAULT_RUN_PLATFORM_COMMAND } = {}) {
  const registration = proxyAutoStartPaths(options);
  const execute = runPlatformCommand;
  const nodePath = options.nodePath || process.execPath;
  const runtimeArgs = options.proxyRuntimeArgs || [];
  const proxyPath = path.join(proxyDir, 'freebuff_tailnet_proxy.js');
  if (registration.type === 'unsupported') return { ...registration, enabled: false, changed: false };

  if (registration.type === 'systemd-user') {
    if (fs.existsSync(registration.file) && !isManagedFile(registration.file) && !options.force) {
      throw new Error(`Refusing to overwrite unmanaged proxy auto-start registration: ${registration.file}`);
    }
    writeAtomically(registration.file, systemdProxyUnitSource(nodePath, proxyDir, runtimeArgs), 0o644);
    execute('systemctl', ['--user', 'daemon-reload']);
    execute('systemctl', ['--user', 'enable', registration.name]);
    execute('systemctl', ['--user', 'restart', registration.name]);
    return { ...registration, enabled: true, changed: true };
  }

  if (registration.type === 'launch-agent') {
    const target = macGuiTarget(options);
    if (fs.existsSync(registration.file) && !isManagedFile(registration.file) && !options.force) {
      throw new Error(`Refusing to overwrite unmanaged proxy auto-start registration: ${registration.file}`);
    }
    writeAtomically(registration.file, proxyLaunchAgentPlistSource(nodePath, proxyPath, runtimeArgs), 0o644);
    execute('launchctl', ['bootout', `${target}/${registration.name}`], { ignoreFailure: true });
    execute('launchctl', ['bootstrap', target, registration.file]);
    execute('launchctl', ['kickstart', '-k', `${target}/${registration.name}`]);
    return { ...registration, enabled: true, changed: true };
  }

  if (registration.type === 'task-scheduler') {
    execute('schtasks.exe', [
      '/Create',
      '/TN', registration.name,
      '/SC', 'ONLOGON',
      '/TR', proxyWindowsTaskRun(nodePath, proxyPath, runtimeArgs),
      '/RL', 'LIMITED',
      '/F',
    ]);
    return { ...registration, enabled: true, changed: true };
  }
  return { ...registration, enabled: false, changed: false };
}

function deployProxy(options, { runPlatformCommand = DEFAULT_RUN_PLATFORM_COMMAND, dryRun = false } = {}) {
  const registration = proxyAutoStartPaths(options);
  if (registration.type === 'unsupported') {
    console.warn(`Warning: tailnet proxy auto-start is unsupported on ${registration.platform}; deploy the files and start the proxy manually.`);
  }
  const proxyDir = options.proxyDir || registration.proxyDir;
  const missing = PROXY_FILES.filter((file) => !fs.existsSync(path.join(options.sourceDir, file)));
  if (missing.length > 0) throw new Error(`Missing proxy source file(s) in --source-dir: ${missing.join(', ')}`);
  if (dryRun) {
    console.log(`Would deploy tailnet proxy to ${proxyDir}`);
    console.log(`Would record UI source dir ${path.resolve(options.sourceDir)} in ${path.join(proxyDir, UI_SOURCE_SIDECAR)}`);
    if (registration.type === 'systemd-user') console.log(`Would write and enable ${registration.file}`);
    return { changed: true, proxyDir, registration };
  }
  fs.mkdirSync(proxyDir, { recursive: true, mode: 0o755 });
  for (const file of PROXY_FILES) {
    fs.copyFileSync(path.join(options.sourceDir, file), path.join(proxyDir, file));
    try { fs.chmodSync(path.join(proxyDir, file), 0o644); } catch {}
  }
  // Record the deploy source so the running proxy can serve newer repo
  // versions of mobile-ui.css/js without waiting for the next install.
  writeAtomically(
    path.join(proxyDir, UI_SOURCE_SIDECAR),
    `${JSON.stringify({
      sourceDir: path.resolve(options.sourceDir),
      deployedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    0o644,
  );
  if (registration.type === 'systemd-user') {
    if (fs.existsSync(registration.file) && !isManagedFile(registration.file) && !options.force) {
      throw new Error(`Refusing to overwrite unmanaged auto-start registration: ${registration.file}`);
    }
    writeAtomically(
      registration.file,
      systemdProxyUnitSource(
        options.nodePath || process.execPath,
        proxyDir,
        options.proxyRuntimeArgs || [],
      ),
      0o644,
    );
    runPlatformCommand('systemctl', ['--user', 'daemon-reload']);
    runPlatformCommand('systemctl', ['--user', 'enable', registration.name]);
    runPlatformCommand('systemctl', ['--user', 'restart', registration.name]);
  }
  const autoStart = registration.type === 'systemd-user'
    ? { ...registration, enabled: true, changed: true }
    : applyProxyAutoStart({ ...options, proxyDir }, proxyDir, { runPlatformCommand });
  return { copied: true, proxyDir, registration, autoStart };
}

function applyBundlePatch(bundleFile) {
  const body = fs.readFileSync(bundleFile, 'utf8');
  const proxy = require(path.join(__dirname, 'freebuff_tailnet_proxy.js'));
  const fixed = [
    proxy.CREATE_REUSE,
    proxy.SETSTATE_FIX,
    proxy.SCROLL_FIX,
    proxy.CLOSE_FIX1,
    proxy.CLOSE_FIX2,
    proxy.CLOSE_FIX3,
    proxy.CLOSE_BTN_FIX,
    proxy.SKILL_ORIGIN_FIX,
  ];
  const names = ['CREATE_REUSE', 'SETSTATE_FIX', 'SCROLL_FIX', 'CLOSE_FIX1', 'CLOSE_FIX2', 'CLOSE_FIX3', 'CLOSE_BTN_FIX', 'SKILL_ORIGIN_FIX'];
  const already = fixed.every((mark) => body.includes(mark));
  if (already) return { file: bundleFile, outcome: 'already-patched' };
  const patched = proxy.patchBundle(body);
  if (patched === body) throw new Error(`bundle did not match any patch anchor: ${bundleFile} (app updated its bundle; update the patch anchors)`);
  const stillMissing = names.filter((mark, index) => !patched.includes(fixed[index]));
  if (stillMissing.length > 0) throw new Error(`bundle patch incomplete after apply; missing markers: ${stillMissing.join(', ')}`);
  writeAtomically(bundleFile, patched, 0o644);
  return { file: bundleFile, outcome: 'patched' };
}

function applyIndexShim(indexFile) {
  let html = fs.readFileSync(indexFile, 'utf8');
  const present = html.includes('fb-desktop-shim');
  const currentShimMarker = 'fb-connected-folder-grid-v2';
  const shimMatch = html.match(/<script id="fb-desktop-shim">[\s\S]*?<\/script>/);
  if (present && shimMatch && shimMatch[0].includes(currentShimMarker)) {
    return { file: indexFile, outcome: 'already-patched' };
  }
  if (!html.includes('</head>')) throw new Error(`index.html has no </head> to anchor the shim: ${indexFile}`);
  const { SHIM } = require('./freebuff_tailnet_proxy');
  html = html.replace(/<script id="fb-desktop-shim">[\s\S]*?<\/script>\s*/g, '');
  html = html.replace('</head>', `<script id="fb-desktop-shim">${SHIM}</script></head>`);
  if (!html.includes('fb-desktop-shim')) throw new Error(`shim injection failed for ${indexFile}`);
  writeAtomically(indexFile, html, 0o644);
  return { file: indexFile, outcome: 'patched' };
}

// Inserted route block: dirlist + perf-report + upload + read-file. These are
// additive inserts anchored after the terminal-upgrade route; they reuse the
// orchestrator's own json3/url2 helpers. configDir is where the perf log
// lands; uploadsDir is where browser-attached files are stored.
function orchestratorRouteBlock(configDir, uploadsDir) {
  return `      if (pathname === "/api/fb/dirlist") {
        let root = url2.searchParams.get("path") || "/";
        let entries = [];
        try {
          let { readdir } = await import("fs/promises");
          let items = await readdir(root, { withFileTypes: true });
          entries = items.map((it) => ({ name: it.name, dir: it.isDirectory() })).sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
        } catch (error47) {
          return json3({ error: error47 instanceof Error ? error47.message : String(error47) }, 400);
        }
        return json3({ path: root, entries });
      }
      if (pathname === "/api/fb/perf-report") {
        let body = "";
        try {
          body = await req.text();
        } catch {
          body = "";
        }
        let ua = req.headers.get("user-agent") || "";
        let client = /FreebuffMobile\\//.test(ua) ? "webview" : /Firefox\\//.test(ua) ? "firefox" : "browser";
        try {
          let parsed = {};
          try {
            parsed = JSON.parse(body || "{}");
          } catch {
          }
          let { appendFile, mkdir } = await import("fs/promises");
          let dir = ${JSON.stringify(configDir)};
          await mkdir(dir, { recursive: true });
          await appendFile(dir + "/perf-report.log", JSON.stringify({ ts: new Date().toISOString(), client, ...parsed }) + "\\n");
        } catch {
        }
        return json3({ ok: true });
      }
      if (pathname === "/api/fb/upload") {
        try {
          let name = (url2.searchParams.get("name") || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "upload";
          let bytes = new Uint8Array(await req.arrayBuffer());
          if (!bytes.length)
            return json3({ error: "empty upload" }, 400);
          let { mkdir, writeFile } = await import("fs/promises");
          let { join } = await import("path");
          let dir = ${JSON.stringify(uploadsDir)};
          await mkdir(dir, { recursive: true });
          let file = join(dir, Date.now() + "-" + Math.random().toString(36).slice(2, 10) + "-" + name);
          await writeFile(file, bytes);
          return json3({ path: file, name });
        } catch (error47) {
          return json3({ error: error47 instanceof Error ? error47.message : String(error47) }, 400);
        }
      }
      if (pathname === "/api/fb/read-file") {
        try {
          let p = url2.searchParams.get("path") || "";
          let { readFile } = await import("fs/promises");
          let { resolve } = await import("path");
          let dir = resolve(${JSON.stringify(uploadsDir)});
          let full = resolve(p);
          if (!full.startsWith(dir + "/"))
            return json3({ error: "forbidden path" }, 403);
          return new Response(await readFile(full), { headers: { "content-type": "application/octet-stream" } });
        } catch (error47) {
          return json3({ error: error47 instanceof Error ? error47.message : String(error47) }, 404);
        }
      }
`;
}

// Perf probe injection helper, inserted before serveSpa, reading the probe
// from the installed proxy directory (shipped next to the proxy).
function perfHelperSource(perfProbePath) {
  return `async function injectPerfProbe(html) {
  if (!html || html.includes("fb-perf-probe"))
    return html;
  try {
    let { readFile } = await import("fs/promises");
    let src2 = await readFile(${JSON.stringify(perfProbePath)}, "utf8");
    let tag = '<script id="fb-perf-probe">' + src2 + '</script>';
    return html.includes("</head>") ? html.replace("</head>", tag + "</head>") : tag + html;
  } catch {
    return html;
  }
}
`;
}

const ORCH_ROUTE_MARK = 'if (pathname === "/api/fb/dirlist")';
const ORCH_ROUTE_MARKS = [
  'if (pathname === "/api/fb/dirlist")',
  'if (pathname === "/api/fb/perf-report")',
  'if (pathname === "/api/fb/upload")',
  'if (pathname === "/api/fb/read-file")',
];
const ORCH_ROUTE_TAIL = 'let match12 = findRoute(routes, req.method, pathname);';
const ORCH_ROUTE_ANCHOR = `return json3({ error: "upgrade required" }, 426);\n      }\n      ${ORCH_ROUTE_TAIL}`;
const ORCH_HELPER_MARK = 'async function injectPerfProbe(';
const ORCH_HELPER_ANCHOR = 'async function serveSpa(pathname, { uiDir, reportMissingAsset, securityHeaders }) {';
// ---------------------------------------------------------------------------
// Pi-compatible skill discovery patch (orchestrator).
// ---------------------------------------------------------------------------
// Freebuff's native skill machinery (the `skill` tool catalog, `/skillname`
// activation, and SkillStore) only scanned `.claude`/`.agents` skill dirs, so
// skills installed for Pi (`~/.pi/agent/skills`, `<root>/.pi/skills`) were
// invisible to DIRECT 58060 clients. This patch adds the Pi locations to all
// three discovery points in the orchestrator: the SDK's getDefaultSkillsDirs,
// the agent-runtime skill handler's loadSkillFromDisk, and the SkillStore
// store config. Each insertion is marked so the patch is idempotent.
const PI_SKILLS_MARK = '/* freebuff-pi-skills */';

// ---------------------------------------------------------------------------
// Auto-run shadow detection (orchestrator request2).
// ---------------------------------------------------------------------------
// The auto-run decision agent's prompt is built by request2(). When a user
// skill shadows a built-in decision skill (simplify, review, ...), the
// prompt's SKILL_NOTES describe the MANAGED behavior while the queued run
// would execute the user skill. This patch makes request2 detect shadowed
// decision skills and append a NOTE so the decision agent flags the override
// before enqueuing. Marker = the patched function body; stock anchor = the
// original request2 function.
const SHADOW_DETECT_FIX_MARK = 'let shadowed = ctx.skills.filter((s) => BUILTIN_DECISION_SKILLS.has(s.name) && s.source !== "managed");';
const SHADOW_DETECT_STOCK =
  'function request2(ctx, segment) {\n  let extra = ctx.skills.map((s) => s.name).filter((name31) => name31 !== AUTORUN_SKILL_NAME && !BUILTIN_DECISION_SKILLS.has(name31));\n  return [\n    bones(segment, ctx.root) || "(no new agent output)",\n    extra.length ? `This project also has these skills: ${extra.join(", ")}.` : "",\n    "The tab is now idle and nothing is queued. What happens next?"\n  ].filter(Boolean).join(`\n\n`);\n}';
const SHADOW_DETECT_FIX =
  'function request2(ctx, segment) {\n  let extra = ctx.skills.map((s) => s.name).filter((name31) => name31 !== AUTORUN_SKILL_NAME && !BUILTIN_DECISION_SKILLS.has(name31));\n  let shadowed = ctx.skills.filter((s) => BUILTIN_DECISION_SKILLS.has(s.name) && s.source !== "managed");\n  let notes = [];\n  if (extra.length) notes.push(`This project also has these skills: ${extra.join(", ")}.`);\n  if (shadowed.length) notes.push(`NOTE: the decision skills ${shadowed.map((s) => s.name).join(", ")} are SHADOWED by user-installed skills (${shadowed.map((s) => `${s.name}=${s.source}`).join(", ")}). The descriptions in "Skills you may name" describe the MANAGED versions; if you enqueue one of these names, the USER skill runs instead of the managed pass. The user installed it deliberately; when naming the skill also mention this override to the user, or pick a custom prompt instead.`);\n  return [\n    bones(segment, ctx.root) || "(no new agent output)",\n    ...notes,\n    "The tab is now idle and nothing is queued. What happens next?"\n  ].filter(Boolean).join(`\n\n`);\n}';

// Second half of shadow detection: the request2 prompt note only reaches the
// decision agent. This patch also surfaces the override to the USER by
// appending a warning to the queue item's note (rendered as `.qnote` above
// the queued row in the Gate UI) when an enqueued decision skill is shadowed.
const SHADOW_NOTE_FIX_MARK = '/* freebuff-shadow-note */';
const SHADOW_NOTE_STOCK =
  'enqueueAutorunInputs(id2, decision) {\n    let thread = this.threads.get(id2), note = [\n      decision.why.trim(),\n      decision.declined.length ? `Declined: ${decision.declined.join("; ")}` : ""\n    ].filter(Boolean).join(`\n`), rejected = [], rows = [], position = this.queue.maxPosition(id2, "queued"), createdAt = Date.now();';
const SHADOW_NOTE_FIX =
  'enqueueAutorunInputs(id2, decision) {\n    let thread = this.threads.get(id2), note = [\n      decision.why.trim(),\n      decision.declined.length ? `Declined: ${decision.declined.join("; ")}` : ""\n    ].filter(Boolean).join(`\n`), rejected = [], rows = [], position = this.queue.maxPosition(id2, "queued"), createdAt = Date.now();\n    let shadowNote = /* freebuff-shadow-note */ decision.inputs.map((i) => i.skillName).filter(Boolean).filter((n) => BUILTIN_DECISION_SKILLS.has(n) && this.deps.skills.list(this.root).some((s) => s.name === n && s.source !== "managed"));\n    if (shadowNote.length) note = [note, `NOTE: ${shadowNote.join(", ")} is a user-installed skill that shadows the built-in ${shadowNote.length === 1 ? "decision skill" : "decision skills"}; the user version runs instead.`].filter(Boolean).join(`\n`);';

// Order encodes the conflict policy (docs/planning/pi-mode/skill-conflicts.md):
// `.pi` beats `.agents` at the same level, project beats home. The insertions
// land the Pi dirs BEFORE the `.agents` entries in each array.
const PI_SKILLS_PATCHES = [
  {
    // sdk getDefaultSkillsDirs
    anchor: 'path11.join(home, ".agents", SKILLS_DIR_NAME),',
    insert: [
      '/* freebuff-pi-skills */',
      '    path11.join(home, ".pi", "agent", SKILLS_DIR_NAME),',
      '    path11.join(cwd, ".pi", SKILLS_DIR_NAME),',
    ],
  },
  {
    // agent-runtime skill handler loadSkillFromDisk
    anchor: 'path7.join(home, ".agents", SKILLS_DIR_NAME),',
    insert: [
      '/* freebuff-pi-skills */',
      '    path7.join(home, ".pi", "agent", SKILLS_DIR_NAME),',
      '    path7.join(projectRoot, ".pi", SKILLS_DIR_NAME),',
    ],
  },
  {
    // SkillStore.store agentSkillsDirs. The orchestrator lays this array out
    // one entry per line with 10-space indentation, and merges the entries
    // with Object.assign — LATER dirs override earlier ones. So the Pi dirs
    // must go AFTER the `.agents` entries to outrank them. Anchor on the
    // closing entry (with its trailing close bracket — the bare entry would
    // also prefix-match the `createSkillsDir` line), splice in the Pi
    // entries + a comma, and leave the closing entry comma-less last.
    anchor: '          join25(root, ".agents", "skills")\n        ]',
    insert: [
      '          join25(root, ".agents", "skills"),',
      '          /* freebuff-pi-skills */',
      '          join25(homedir7(), ".pi", "agent", "skills"),',
      '          join25(root, ".pi", "skills"),',
    ],
    spliceBefore: true,
  },
];

// Inserts the Pi skill dirs into `out` at every anchor. Returns the updated
// string plus the number of anchors actually patched (0 when already marked).
function applyPiSkillsPatch(out) {
  if (out.includes(PI_SKILLS_MARK)) return { out, patched: 0 };
  let patched = 0;
  for (const patch of PI_SKILLS_PATCHES) {
    const insertText = patch.insert.join('\n');
    if (!out.includes(patch.anchor)) {
      throw new Error(`orchestrator pi-skills anchor not found; expected: ${patch.anchor.slice(0, 80)}…`);
    }
    if (patch.spliceBefore) {
      // The bare closing entry also prefix-matches the `createSkillsDir` line
      // earlier in the same block, so take the LAST occurrence, which is
      // always the final element of agentSkillsDirs. Splice the Pi entries in
      // front of it so its existing suffix (`,`, newline, close bracket)
      // stays attached and remains valid inside the array.
      const idx = out.lastIndexOf(patch.anchor);
      if (idx < 0) throw new Error(`orchestrator pi-skills anchor not found; expected: ${patch.anchor.slice(0, 80)}…`);
      out = `${out.slice(0, idx)}${insertText}\n${out.slice(idx)}`;
    } else {
      out = out.split(patch.anchor).join(`${patch.anchor}\n${insertText}`);
    }
    patched += 1;
  }
  return { out, patched };
}

// Best-effort serveSpa cache-header candidates (stock -> patched). The stock
// string may reorder across app versions; unmatched candidates become a loud
// warning, not a silent success.
const SERVE_SPA_CACHE_CANDIDATES = [
  [
    'return new Response(file2, { headers: { ...securityHeaders, "content-type": "text/html" } });',
    'let text = await file2.text();\n        return new Response(await injectPerfProbe(text), { headers: { ...securityHeaders, "cache-control": "no-store", "content-type": "text/html" } });',
  ],
  [
    'return new Response(file2, { headers: { "content-type": "text/html", ...securityHeaders } });',
    'let text = await file2.text();\n        return new Response(await injectPerfProbe(text), { headers: { "content-type": "text/html", "cache-control": "no-store", ...securityHeaders } });',
  ],
  [
    'return new Response(index, { headers: { "content-type": "text/html", ...securityHeaders } });',
    'let text = await index.text();\n    return new Response(await injectPerfProbe(text), { headers: { "content-type": "text/html", "cache-control": "no-store", ...securityHeaders } });',
  ],
  [
    'return new Response(index, { headers: { ...securityHeaders } });',
    'let text = await index.text();\n    return new Response(await injectPerfProbe(text), { headers: { ...securityHeaders, "cache-control": "no-store", "content-type": "text/html" } });',
  ],
];

function applyOrchestratorPatches(orchestratorFile, { configDir, uploadsDir, perfProbePath }) {
  const src = fs.readFileSync(orchestratorFile, 'utf8');
  const changes = [];
  let out = src;
  const performed = [];
  const routeMarksPresent = ORCH_ROUTE_MARKS.filter((mark) => out.includes(mark));
  if (routeMarksPresent.length < ORCH_ROUTE_MARKS.length) {
    const block = orchestratorRouteBlock(configDir, uploadsDir);
    if (routeMarksPresent.length === 0) {
      // Fresh insert: anchor on the stock upgrade-required route.
      if (!out.includes(ORCH_ROUTE_ANCHOR)) {
        throw new Error(`orchestrator route anchor not found (app update may have renamed helpers); expected: ${ORCH_ROUTE_ANCHOR.slice(0, 80)}…`);
      }
      out = out.split(ORCH_ROUTE_ANCHOR).join(`return json3({ error: "upgrade required" }, 426);\n      }\n${block}      ${ORCH_ROUTE_TAIL}`);
      performed.push('routes');
    } else {
      // Partial block: an older patch left dirlist/perf-report but predates
      // the upload/read-file routes. Replace the existing block span with
      // the full current block so the on-disk routes catch up.
      const start = out.indexOf(ORCH_ROUTE_MARK);
      const end = out.indexOf(ORCH_ROUTE_TAIL, start);
      if (start < 0 || end < 0) {
        throw new Error(`orchestrator stale route block cannot be located (app update may have moved it); expected: ${ORCH_ROUTE_MARK.slice(0, 60)}… → ${ORCH_ROUTE_TAIL.slice(0, 60)}…`);
      }
      out = `${out.slice(0, start)}${block}${out.slice(end)}`;
      performed.push('routes');
    }
  }
  if (!out.includes(ORCH_HELPER_MARK)) {
    if (!out.includes(ORCH_HELPER_ANCHOR)) {
      throw new Error(`orchestrator serveSpa anchor not found; expected: ${ORCH_HELPER_ANCHOR}`);
    }
    out = out.split(ORCH_HELPER_ANCHOR).join(perfHelperSource(perfProbePath) + ORCH_HELPER_ANCHOR);
    performed.push('perf-helper');
  }
  const bestEffort = [];
  for (const [stock, patched] of SERVE_SPA_CACHE_CANDIDATES) {
    if (out.includes(stock)) {
      out = out.split(stock).join(patched);
      bestEffort.push(`cache:${stock.slice(0, 60)}`);
    }
  }
  if (bestEffort.length > 0) performed.push('cache-headers');
  const piPatch = (() => {
    // ponytail: pi-skills anchors renamed in Desktop 0.0.71 — best-effort,
    // skip instead of failing the routes/shim patch (upgrade path: refresh
    // PI_SKILLS_PATCHES anchors for the new bundle).
    try { return applyPiSkillsPatch(out); }
    catch (e) { bestEffort.push('pi-skills:skipped (' + e.message.slice(0, 60) + ')'); return { out, patched: 0 }; }
  })();
  out = piPatch.out;
  if (piPatch.patched > 0) performed.push('pi-skills');
  if (!out.includes(SHADOW_DETECT_FIX_MARK)) {
    if (!out.includes(SHADOW_DETECT_STOCK)) {
      // ponytail: shadow-detect anchor renamed in 0.0.71 — best-effort skip.
      bestEffort.push('shadow-detect:skipped (anchor renamed)');
    } else {
      out = out.split(SHADOW_DETECT_STOCK).join(SHADOW_DETECT_FIX);
      performed.push('shadow-detect');
    }
  }
  if (!out.includes(SHADOW_NOTE_FIX_MARK)) {
    if (!out.includes(SHADOW_NOTE_STOCK) && !out.includes(`  ${SHADOW_NOTE_STOCK}`)) {
      // ponytail: shadow-note anchor renamed in 0.0.71 — best-effort skip.
      bestEffort.push('shadow-note:skipped (anchor renamed)');
    } else {
    // SHADOW_NOTE_STOCK is a PREFIX of SHADOW_NOTE_FIX, so split/join would
    // match inside the replacement and duplicate the block. Replace only the
    // first occurrence (the stock anchor in the real file), never inside the
    // freshly inserted fix. Match both the 2-space-indented real file and the
    // col-0 test fixture.
    const twoSpace = `  ${SHADOW_NOTE_STOCK}`;
    if (out.includes(twoSpace)) {
      out = out.replace(twoSpace, `  ${SHADOW_NOTE_FIX}`);
    } else if (out.includes(SHADOW_NOTE_STOCK)) {
      out = out.replace(SHADOW_NOTE_STOCK, SHADOW_NOTE_FIX);
    }
    performed.push('shadow-note');
    }
  }
  writeAtomically(orchestratorFile, out, 0o644);
  return { changes: performed, bestEffort };
}

async function install(options) {
  const existing = readJsonIfPresent(options.configFile);
  if (!options.relayHttpUrl) options.relayHttpUrl = existing.relayHttpUrl || null;
  if (!options.relayWsUrl) options.relayWsUrl = existing.relayWsUrl || null;
  if (!options.upstreamUrl) options.upstreamUrl = existing.upstreamUrl || null;
  if (!options.connectorId) options.connectorId = existing.connectorId || null;
  if (!options.agentVersion) options.agentVersion = existing.agentVersion || null;
  if (!options.connectorCredentialFile) options.connectorCredentialFile = existing.connectorCredentialFile || null;
  if (!options.autoStartSpecified) options.autoStart = existing.autoStart === true;
  options.previousAutoStart = existing.autoStart === true;
  validateOptions(options);
  options.connectorId = options.connectorId || existing.connectorId || randomConnectorId();
  const config = configForInstall(options, existing);
  const manifestFile = path.join(options.installDir, MANIFEST_NAME);
  const wrapperPath = path.join(options.installDir, WRAPPER_NAME);
  const platform = options.platform || process.platform;
  const launcher = platform === 'win32'
    ? path.join(options.binDir, WINDOWS_LAUNCHER_NAME)
    : path.join(options.binDir, UNIX_LAUNCHER_NAME);
  const autoStartRegistration = autoStartPaths(options);
  const paths = {
    installDir: options.installDir,
    proxyDir: options.proxyDir || autoStartRegistration.proxyDir,
    configFile: options.configFile,
    connectorCredentialFile: config.connectorCredentialFile,
    binDir: options.binDir,
    wrapper: wrapperPath,
    launcher,
    autoStartFile: autoStartRegistration.file,
    autoStartName: autoStartRegistration.name,
    autoStartType: autoStartRegistration.type,
  };

  if (options.dryRun) {
    printInstallSummary(options, config, paths);
    if (options.uiPatches) {
      try {
        const desktopDir = findFreebuffDesktop(options);
        // installUiStack derives the proxy dir from the PROXY auto-start
        // paths (paths.proxyDir above is the agent stack's), so resolve it
        // the same way here for an honest dry-run report.
        const proxyDir = options.proxyDir || proxyAutoStartPaths(options).proxyDir;
        console.log(`UI patches: would deploy proxy to ${proxyDir} and patch ${desktopOrchestratorDir(desktopDir)}`);
      } catch (error) {
        console.log(`UI patches: SKIPPED (${error.message})`);
      }
    }
    return { changed: false, dryRun: true, config, paths };
  }

  ensureInstallDirectory(options);
  if (fs.existsSync(launcher) && !isManagedFile(launcher) && !options.force) {
    throw new Error(`Refusing to overwrite unmanaged launcher: ${launcher}`);
  }
  const credentials = await provisionConnector(
    options,
    config.connectorId,
    options.requestJson || requestJson,
  );
  fs.mkdirSync(options.installDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(options.binDir, { recursive: true, mode: 0o755 });
  for (const file of AGENT_FILES) {
    const source = path.join(options.sourceDir, file);
    if (!fs.existsSync(source)) throw new Error(`Missing installer source file: ${source}`);
    const target = path.join(options.installDir, file);
    fs.copyFileSync(source, target);
    try { fs.chmodSync(target, 0o644); } catch {}
  }
  writeAtomically(wrapperPath, wrapperSource(options.configFile), 0o755);
  writeAtomically(options.configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600, {
    directoryMode: 0o700,
    protectDirectory: true,
  });
  if (credentials) {
    writeAtomically(config.connectorCredentialFile, `${JSON.stringify({
      version: 1,
      connectorId: credentials.connectorId,
      connectorToken: credentials.connectorToken,
      connectorRefreshToken: credentials.connectorRefreshToken,
      connectorTokenExpiresAt: credentials.connectorTokenExpiresAt,
      connectorRefreshTokenExpiresAt: credentials.connectorRefreshTokenExpiresAt,
    }, null, 2)}\n`, 0o600, {
      directoryMode: 0o700,
      protectDirectory: true,
    });
  }

  const launcherNodePath = options.nodePath || process.execPath;
  const launcherRuntimeArgs = options.agentRuntimeArgs || [];
  const launcherSource = platform === 'win32'
    ? windowsLauncherSource(launcherNodePath, wrapperPath, launcherRuntimeArgs)
    : unixLauncherSource(launcherNodePath, wrapperPath, launcherRuntimeArgs);
  writeAtomically(launcher, launcherSource, 0o755);
  writeAtomically(manifestFile, `${JSON.stringify({
    version: 1,
    agentVersion: config.agentVersion,
    autoStart: config.autoStart,
    autoStartPlatform: autoStartRegistration.platform,
    autoStartType: autoStartRegistration.type,
    autoStartName: autoStartRegistration.name,
    autoStartFile: autoStartRegistration.file,
    managedBy: MANAGED_MARKER,
    files: [...AGENT_FILES, WRAPPER_NAME, MANIFEST_NAME],
    launcher,
    configFile: options.configFile,
    stateFile: options.stateFile,
    connectorCredentialFile: config.connectorCredentialFile,
  }, null, 2)}\n`, 0o600);

  const autoStart = applyAutoStart(options, wrapperPath, {
    previouslyEnabled: options.previousAutoStart,
  });

  let piAssets = { enabled: false };
  const piAssetDir = path.resolve(options.sourceDir, '..', 'pi-assets');
  if (fs.existsSync(piAssetDir)) {
    const piAgentDir = options.piAgentDir || process.env.FB_PI_AGENT_DIR || path.join(options.home || os.homedir(), '.pi', 'agent');
    try {
      piAssets = { enabled: true, ...syncPiAssets({ agentDir: piAgentDir, assetDir: piAssetDir }) };
    } catch (error) {
      piAssets = { enabled: true, error: error.message };
      console.warn(`Warning: Pi asset sync failed: ${error.message}`);
    }
  }

  let uiStack = { enabled: false };
  if (options.uiPatches) {
    uiStack = installUiStack(options, paths, {
      runPlatformCommand,
      applyBundle: applyBundlePatch,
      applyShim: applyIndexShim,
      applyOrchestrator: applyOrchestratorPatches,
    });
    config.uiPatches = uiStack;
    try { fs.writeFileSync(options.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); } catch {}
  }
  printInstallSummary(options, config, paths);
  return { changed: true, dryRun: false, config, paths, autoStart, piAssets, uiStack };
}

// Deploys the tailnet proxy (install-guide step 2) and applies the on-disk
// UI patches (steps 3-4: bundle, index.html shim, orchestrator dirlist +
// perf-report routes + best-effort cache headers) so direct-58060 clients
// get the same fixes the proxy applies at serve time. Every patch is
// idempotent and marker-checked: already-patched files are left alone, and
// a patch whose anchors no longer match fails loudly instead of silently
// shipping a stock (regressed) UI after an app update.
function installUiStack(options, paths, { runPlatformCommand = DEFAULT_RUN_PLATFORM_COMMAND } = {}) {
  const desktopDir = findFreebuffDesktop(options);
  const registration = proxyAutoStartPaths(options);
  const proxyDeploy = deployProxy(options, { runPlatformCommand });
  const results = { proxy: proxyDeploy.proxyDir, applied: [], bestEffort: [] };

  const orchDir = orchestratorDirOf(desktopDir);
  const uiDir = path.join(orchDir, 'ui');
  const platformPaths = defaultPaths({
    platform: options.platform || process.platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
  });
  const configDir = path.dirname(platformPaths.configFile);
  const uploadsDir = path.join(path.dirname(platformPaths.installDir), 'uploads');
  const perfProbePath = path.join(proxyDeploy.proxyDir, 'perf-probe.js');

  const assetsDir = path.join(uiDir, 'assets');
  const bundles = fs.readdirSync(assetsDir).filter((name) => /^index-[^/]+\.js$/.test(name));
  if (bundles.length === 0) throw new Error(`no UI bundle found under ${assetsDir}`);
  for (const name of bundles) {
    results.applied.push(`bundle:${name}:${applyBundlePatch(path.join(assetsDir, name)).outcome}`);
  }
  const indexHtml = path.join(uiDir, 'index.html');
  if (!fs.existsSync(indexHtml)) throw new Error(`missing ${indexHtml}`);
  results.applied.push(`shim:${applyIndexShim(indexHtml).outcome}`);

  const orchFile = path.join(orchDir, 'orchestrator.js');
  if (!fs.existsSync(orchFile)) throw new Error(`missing ${orchFile}`);
  const orchResult = applyOrchestratorPatches(orchFile, { configDir, uploadsDir, perfProbePath });
  const changes = orchResult.changes;
  results.applied.push(`orchestrator:${changes.includes('routes') || changes.includes('perf-helper') || changes.includes('cache-headers') ? changes.join(',') : 'already-patched'}`);
  results.bestEffort = orchResult.bestEffort || [];
  return { enabled: true, desktopDir, configDir, uiDir, proxyUnit: registration.file, ...results };
}

// ---------------------------------------------------------------------------
// Verify: post-update regression check. Freebuff Desktop updates overwrite
// ui/index.html, ui/assets/index-*.js, and orchestrator.js, silently wiping
// every on-disk patch. verifyUiStack() scans patch markers and deployed UI
// asset parity, reporting each problem by file; main() exits non-zero when
// anything is missing or stale, so regressions are caught before users see
// them.
// ---------------------------------------------------------------------------

function collectProblems(desktopDir, options = {}) {
  const problems = [];
  const orchDir = orchestratorDirOf(desktopDir);
  const uiDir = path.join(orchDir, 'ui');
  const assetsDir = path.join(uiDir, 'assets');
  const proxy = require(path.join(__dirname, 'freebuff_tailnet_proxy.js'));
  const fixed = [
    proxy.CREATE_REUSE,
    proxy.SETSTATE_FIX,
    proxy.SCROLL_FIX,
    proxy.CLOSE_FIX1,
    proxy.CLOSE_FIX2,
    proxy.CLOSE_FIX3,
    proxy.CLOSE_BTN_FIX,
    proxy.SKILL_ORIGIN_FIX,
  ];
  const names = ['CREATE_REUSE', 'SETSTATE_FIX', 'SCROLL_FIX', 'CLOSE_FIX1', 'CLOSE_FIX2', 'CLOSE_FIX3', 'CLOSE_BTN_FIX', 'SKILL_ORIGIN_FIX'];

  let bundles = [];
  try {
    bundles = fs.readdirSync(assetsDir)
      .filter((name) => /^index-[^/]+\.js$/.test(name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      problems.push({ level: 'error', item: 'bundle', message: `UI assets dir missing (app update removed it?): ${assetsDir}` });
    } else {
      throw error;
    }
  }
  if (bundles.length === 0) {
    problems.push({ level: 'error', item: 'bundle', message: `no UI bundle found under ${assetsDir}` });
  }
  for (const name of bundles) {
    let body;
    try {
      body = fs.readFileSync(path.join(assetsDir, name), 'utf8');
    } catch (error) {
      problems.push({ level: 'error', item: `bundle:${name}`, message: `unreadable: ${error.message}` });
      continue;
    }
    const raw = body;
    // The proxy patches the bundle at serve time, so the on-disk file won't
    // carry the markers. Run it through patchBundle() to see what's actually
    // served, and treat obsolete markers (removed upstream in a new app
    // version, e.g. 0.0.71) as non-errors.
    const patched = proxy.patchBundle(body);
    body = patched.body;
    const obsolete = patched.obsolete || [];
    const missing = names.filter((mark, index) => !body.includes(fixed[index]) && !obsolete.includes(names[index]));
    if (missing.length > 0) {
      problems.push({
        level: 'error',
        item: `bundle:${name}`,
        message: `missing patch marker(s): ${missing.join(', ')} (app update likely replaced the bundle; re-run install)`,
      });
    } else if (obsolete.length > 0) {
      problems.push({
        level: 'warn',
        item: `bundle:${name}`,
        message: `${obsolete.length} patch(es) obsolete for this app version (skipped): ${obsolete.join(', ')}`,
      });
    }
    void raw;
  }

  const indexHtml = path.join(uiDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    problems.push({ level: 'error', item: 'shim', message: `missing index.html: ${indexHtml}` });
  } else {
    const html = fs.readFileSync(indexHtml, 'utf8');
    if (!/<script id="fb-desktop-shim">[\s\S]*?<\/script>/.test(html)) {
      problems.push({ level: 'error', item: 'shim', message: `fb-desktop-shim script missing from ${indexHtml}` });
    }
  }

  const orchFile = path.join(orchDir, 'orchestrator.js');
  if (!fs.existsSync(orchFile)) {
    problems.push({ level: 'error', item: 'orchestrator', message: `missing orchestrator.js: ${orchFile}` });
  } else {
    const src = fs.readFileSync(orchFile, 'utf8');
    if (!src.includes('/api/fb/dirlist')) {
      problems.push({ level: 'error', item: 'orchestrator.routes', message: 'dirlist route missing (app update replaced orchestrator.js; re-run install)' });
    }
    if (!src.includes('/api/fb/perf-report')) {
      problems.push({ level: 'error', item: 'orchestrator.routes', message: 'perf-report route missing (app update replaced orchestrator.js; re-run install)' });
    }
    if (!src.includes('/api/fb/upload')) {
      problems.push({ level: 'error', item: 'orchestrator.routes', message: 'upload route missing (app update replaced orchestrator.js; re-run install)' });
    }
    if (!src.includes('async function injectPerfProbe(')) {
      problems.push({ level: 'error', item: 'orchestrator.perf', message: 'injectPerfProbe helper missing (app update replaced orchestrator.js; re-run install)' });
    }
    if (!src.includes('"cache-control": "no-store"')) {
      problems.push({ level: 'warn', item: 'orchestrator.cache', message: 'serveSpa no-store cache header missing (best-effort patch; re-run install to retry)' });
    }
    if (!src.includes('"public, max-age=31536000, immutable"')) {
      problems.push({ level: 'warn', item: 'orchestrator.cache', message: 'serveSpa immutable asset header missing (best-effort patch; re-run install to retry)' });
    }
    if (!src.includes('/* freebuff-pi-skills */')) {
      problems.push({ level: 'warn', item: 'orchestrator.pi-skills', message: 'Pi skill dirs not discovered by orchestrator (re-run install to apply)' });
    }
  }

  // Missing proxy deployment files are warnings; stale injected UI is an
  // error because the running proxy can otherwise serve a visibly regressed UI.
  const registration = proxyAutoStartPaths(options);
  const proxyDir = options.proxyDir || (registration.proxyDir || '');
  if (proxyDir && !fs.existsSync(proxyDir)) {
    problems.push({ level: 'warn', item: 'proxy-deploy', message: `proxy directory missing: ${proxyDir}` });
  } else if (proxyDir) {
    const missingFiles = PROXY_FILES.filter((file) => !fs.existsSync(path.join(proxyDir, file)));
    if (missingFiles.length > 0) {
      problems.push({ level: 'warn', item: 'proxy-deploy', message: `proxy files missing in ${proxyDir}: ${missingFiles.join(', ')}` });
    }
    const sourceDir = options.sourceDir || __dirname;
    const staleUiFiles = PROXY_UI_FILES.filter((file) => {
      const source = path.join(sourceDir, file);
      const deployed = path.join(proxyDir, file);
      if (!fs.existsSync(source) || !fs.existsSync(deployed)) return false;
      return !fs.readFileSync(source).equals(fs.readFileSync(deployed));
    });
    if (staleUiFiles.length > 0) {
      // With the ui-source.json sidecar the running proxy serves the newer
      // SOURCE copy itself, so staleness of the deployed snapshot is a
      // tidiness warning, not a live regression. Without the sidecar (older
      // installs) the deployed copy is what gets served, so it stays an
      // error that demands a re-run.
      const hasSourceSidecar = fs.existsSync(path.join(proxyDir, UI_SOURCE_SIDECAR));
      problems.push({
        level: hasSourceSidecar ? 'warn' : 'error',
        item: 'proxy-ui',
        message: hasSourceSidecar
          ? `deployed UI asset(s) stale in ${proxyDir}: ${staleUiFiles.join(', ')} (proxy serves the newer source copy; re-run install to refresh the deployed snapshot)`
          : `deployed UI asset(s) stale in ${proxyDir}: ${staleUiFiles.join(', ')} (re-run install)`,
      });
    }
  }
  if (registration.type === 'systemd-user' && registration.file && !fs.existsSync(registration.file)) {
    problems.push({ level: 'warn', item: 'proxy-unit', message: `proxy systemd unit missing: ${registration.file}` });
  }
  return problems;
}

function verifyUiStack(options = {}) {
  let desktopDir;
  try {
    desktopDir = findFreebuffDesktop(options);
  } catch (error) {
    return {
      ok: false,
      desktopDir: null,
      errors: [{ level: 'error', item: 'desktop', message: error.message }],
      warnings: [],
    };
  }
  const problems = collectProblems(desktopDir, options);
  return {
    ok: problems.every((problem) => problem.level !== 'error'),
    desktopDir,
    errors: problems.filter((problem) => problem.level === 'error'),
    warnings: problems.filter((problem) => problem.level === 'warn'),
  };
}

function printVerifyReport(report) {
  if (report.desktopDir) console.log(`Freebuff Desktop: ${report.desktopDir}`);
  for (const problem of [...report.errors, ...report.warnings]) {
    console.log(`  [${problem.level}] ${problem.item}: ${problem.message}`);
  }
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log('All UI patches present. Gate stack looks healthy.');
  } else if (report.errors.length === 0) {
    console.log('No errors: all required patches present.');
  }
  return report.ok;
}

function removeFileIfManaged(file, marker = MANAGED_MARKER) {
  if (!fs.existsSync(file)) return false;
  if (!isManagedFile(file, marker)) return false;
  fs.unlinkSync(file);
  return true;
}

function uninstall(options) {
  validateOptions(options);
  const manifestFile = path.join(options.installDir, MANIFEST_NAME);
  const manifest = fs.existsSync(manifestFile) ? readJsonIfPresent(manifestFile) : null;
  const files = manifest?.files || [...AGENT_FILES, WRAPPER_NAME, MANIFEST_NAME];
  const platform = manifest?.autoStartPlatform || options.platform || process.platform;
  const launcher = manifest?.launcher || path.join(
    options.binDir,
    platform === 'win32' ? WINDOWS_LAUNCHER_NAME : UNIX_LAUNCHER_NAME,
  );
  const autoStartRegistration = autoStartPaths({ ...options, platform });
  const autoStartEnabled = manifest?.autoStart === true || Boolean(
    autoStartRegistration.file && fs.existsSync(autoStartRegistration.file),
  );
  const paths = {
    installDir: options.installDir,
    configFile: manifest?.configFile || options.configFile,
    stateFile: manifest?.stateFile || options.stateFile,
    connectorCredentialFile: manifest?.connectorCredentialFile || options.connectorCredentialFile,
    launcher,
    autoStartFile: autoStartRegistration.file,
    autoStartName: autoStartRegistration.name,
    autoStartType: autoStartRegistration.type,
  };

  if (options.dryRun) {
    console.log(`Would remove Freebuff mobile-connect files from ${paths.installDir}`);
    if (autoStartEnabled) console.log(`Would disable auto-start: ${paths.autoStartFile || paths.autoStartName}`);
    if (options.purge)    console.log(`Would purge config and state: ${paths.configFile}, ${paths.stateFile}, ${paths.connectorCredentialFile}`);

    return { changed: false, dryRun: true, paths };
  }

  let changed = false;
  if (autoStartEnabled) {
    const autoStart = applyAutoStart({
      ...options,
      platform,
      autoStart: false,
    }, path.join(options.installDir, WRAPPER_NAME), {
      previouslyEnabled: manifest?.autoStart === true,
    });
    changed = autoStart.changed;
  }
  changed = removeFileIfManaged(paths.launcher) || changed;
  for (const file of files) {
    const target = path.join(options.installDir, file);
    if (file === MANIFEST_NAME) continue;
    if (fs.existsSync(target)) {
      if (!manifest && !isManagedFile(target) && !options.force) {
        throw new Error(`Refusing to remove unmanaged file: ${target}`);
      }
      fs.unlinkSync(target);
      changed = true;
    }
  }
  if (fs.existsSync(manifestFile)) {
    fs.unlinkSync(manifestFile);
    changed = true;
  }
  try { fs.rmdirSync(options.installDir); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
  // Tailnet proxy stack: managed proxy dir + systemd unit are removed when
  // present. The on-disk UI patches are intentionally NOT reverted (they are
  // harmless, and reverting them would require trusting app-update anchors);
  // tell the user instead.
  let proxyChanged = false;
  let proxyLeftRunning = false;
  const proxyRegistration = proxyAutoStartPaths({ ...options, platform });
  if (proxyRegistration.type === 'systemd-user') {
    const proxyUnit = proxyRegistration.file;
    const execute = options.runPlatformCommand || runPlatformCommand;
    const proxyActive = execute('systemctl', ['--user', 'is-active', PROXY_SERVICE_NAME], { ignoreFailure: true });
    if (proxyActive) {
      // Leave a live proxy alone: it is serving the tailnet UI right now.
      // Removing its unit/files would take the port down mid-session.
      proxyLeftRunning = true;
    } else if (fs.existsSync(proxyUnit) && isManagedFile(proxyUnit)) {
      execute('systemctl', ['--user', 'stop', PROXY_SERVICE_NAME], { ignoreFailure: true });
      execute('systemctl', ['--user', 'disable', PROXY_SERVICE_NAME], { ignoreFailure: true });
      fs.unlinkSync(proxyUnit);
      execute('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
      proxyChanged = true;
    }
  }
  const proxyDir = manifest?.proxyDir || options.proxyDir || (() => defaultPaths({
    platform,
    env: options.env || process.env,
    home: options.home || os.homedir(),
  }).proxyDir)();
  if (proxyLeftRunning) {
    console.log(`Tailnet proxy ${PROXY_SERVICE_NAME} is still running; left unit and files in place.`);
  } else {
    // Drop the deploy-source sidecar (managed state for this install); the
    // rest of the proxy dir is intentionally preserved for the next install.
    try { fs.unlinkSync(path.join(proxyDir, UI_SOURCE_SIDECAR)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try { fs.rmdirSync(proxyDir); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  if (options.purge) {
    for (const file of [paths.configFile, paths.stateFile, paths.connectorCredentialFile]) {
      try { fs.unlinkSync(file); changed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  console.log(`${changed ? 'Removed' : 'Already absent'} Freebuff Desktop mobile-connect companion`);
  if (proxyChanged) console.log('Removed the tailnet proxy service and files.');
  if (!options.purge) console.log(`Config, state, and connector credential preserved. Use --purge to remove them.`);
  console.log('On-disk UI patches kept (bundle, shim, orchestrator routes); re-run install when the app updates to re-apply cleanly.');
  return { changed: changed || proxyChanged, dryRun: false, paths };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return 0;
  if (options.command === 'uninstall') {
    uninstall(options);
    return 0;
  }
  if (options.command === 'verify') {
    const report = verifyUiStack(options);
    printVerifyReport(report);
    return report.ok ? 0 : 1;
  }
  await install(options);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  SHADOW_NOTE_FIX,
  SHADOW_NOTE_FIX_MARK,
  SHADOW_NOTE_STOCK,
  AGENT_FILES,
  DEFAULT_AGENT_VERSION,
  DEFAULT_UPSTREAM_URL,
  LAUNCH_AGENT_LABEL,
  MANAGED_MARKER,
  PROXY_LAUNCH_AGENT_LABEL,
  PROXY_FILES,
  PROXY_SERVICE_NAME,
  PROXY_WINDOWS_TASK_NAME,
  SYSTEMD_SERVICE_NAME,
  UI_SOURCE_SIDECAR,
  WINDOWS_TASK_NAME,
  applyAutoStart,
  applyBundlePatch,
  applyIndexShim,
  applyOrchestratorPatches,
  applyProxyAutoStart,
  autoStartPaths,
  deployProxy,
  defaultPaths,
  deriveWsUrl,
  DESKTOP_CANDIDATES,
  desktopOrchestratorDir,
  findFreebuffDesktop,
  install,
  installUiStack,
  launchAgentPlistSource,
  normalizeAgentVersion,
  orchestratorDirOf,
  printVerifyReport,
  orchestratorRouteBlock,
  parseArgs,
  perfHelperSource,
  proxyAutoStartPaths,
  proxyLaunchAgentPlistSource,
  proxyWindowsTaskRun,
  provisionConnector,
  systemdProxyUnitSource,
  systemdUnitSource,
  main,
  normalizeHttpUrl,
  normalizeWsUrl,
  uninstall,
  verifyUiStack,
  windowsTaskRun,
};
