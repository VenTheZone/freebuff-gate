#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { requestJson } = require('./mobile-connect-agent');

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
const LAUNCH_AGENT_LABEL = 'com.freebuff.mobile-connect';
const WINDOWS_TASK_NAME = 'Freebuff Mobile Connect';
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
      configFile: path.join(root, 'mobile-connect-desktop.json'),
      stateFile: path.join(root, 'mobile-connect-agent.json'),
      connectorCredentialFile: path.join(root, 'mobile-connect-connector.json'),
      binDir: path.join(root, 'bin'),
      autoStartFile: null,
    };
  }

  const autoStartFile = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
    : path.join(configHome, 'systemd', 'user', SYSTEMD_SERVICE_NAME);
  return {
    installDir: path.join(dataHome, 'freebuff', 'mobile-connect'),
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
  --help                  Show this help

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

function unixLauncherSource(nodePath, wrapperPath) {
  return `#!/bin/sh
# ${MANAGED_MARKER}
exec ${shellQuote(nodePath)} ${shellQuote(wrapperPath)} "$@"
`;
}

function windowsLauncherSource(nodePath, wrapperPath) {
  return `@echo off
rem ${MANAGED_MARKER}
"${nodePath}" "${wrapperPath}" %*
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

function systemdUnitSource(nodePath, wrapperPath) {
  return `# ${MANAGED_MARKER}
[Unit]
Description=Freebuff Desktop mobile-connect companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdEscape(nodePath)} ${systemdEscape(wrapperPath)} serve
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

function launchAgentPlistSource(nodePath, wrapperPath) {
  const argumentsXml = [nodePath, wrapperPath, 'serve']
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

function windowsTaskRun(nodePath, wrapperPath) {
  for (const value of [nodePath, wrapperPath]) {
    if (/["\r\n]/.test(String(value))) throw new Error('Windows auto-start paths cannot contain quotes or newlines');
  }
  return `"${nodePath}" "${wrapperPath}" serve`;
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

  if (registration.type === 'unsupported') {
    if (enabled) {
      throw new Error(`Auto-start is unsupported on ${registration.platform}; use Linux, macOS, or Windows`);
    }
    return { ...registration, enabled: false, changed: false };
  }

  if (registration.type === 'systemd-user') {
    if (enabled) {
      ensureManagedAutoStartFile(registration.file, options);
      writeAtomically(registration.file, systemdUnitSource(nodePath, wrapperPath), 0o644);
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
      writeAtomically(registration.file, launchAgentPlistSource(nodePath, wrapperPath), 0o644);
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
        '/TR', windowsTaskRun(nodePath, wrapperPath),
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

  const launcherSource = platform === 'win32'
    ? windowsLauncherSource(process.execPath, wrapperPath)
    : unixLauncherSource(process.execPath, wrapperPath);
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
  printInstallSummary(options, config, paths);
  return { changed: true, dryRun: false, config, paths, autoStart };
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
  if (options.purge) {
    for (const file of [paths.configFile, paths.stateFile, paths.connectorCredentialFile]) {
      try { fs.unlinkSync(file); changed = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  console.log(`${changed ? 'Removed' : 'Already absent'} Freebuff Desktop mobile-connect companion`);
  if (!options.purge) console.log(`Config, state, and connector credential preserved. Use --purge to remove them.`);
  return { changed, dryRun: false, paths };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return 0;
  if (options.command === 'uninstall') {
    uninstall(options);
  } else {
    await install(options);
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  AGENT_FILES,
  DEFAULT_AGENT_VERSION,
  DEFAULT_UPSTREAM_URL,
  LAUNCH_AGENT_LABEL,
  MANAGED_MARKER,
  SYSTEMD_SERVICE_NAME,
  WINDOWS_TASK_NAME,
  applyAutoStart,
  autoStartPaths,
  launchAgentPlistSource,
  normalizeAgentVersion,
  defaultPaths,
  deriveWsUrl,
  install,
  systemdUnitSource,
  main,
  normalizeHttpUrl,
  normalizeWsUrl,
  parseArgs,
  provisionConnector,
  uninstall,
  windowsTaskRun,
};
