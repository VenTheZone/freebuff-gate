#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const setup = require('./freebuff-gate-setup');
const { createSetupController, createWizardServer } = require('./freebuff-setup-wizard');

const SETUP_VERSION = process.env.FREEBUFF_SETUP_VERSION || 'dev';

function parseBinaryArgs(argv = []) {
  let noBrowser = false;
  let advanced = false;
  let version = false;
  const setupArgs = [];
  for (const arg of argv) {
    if (arg === '--no-browser' || arg === '--terminal') noBrowser = true;
    else if (arg === '--advanced') advanced = true;
    else if (arg === '--version' || arg === '-v') version = true;
    else setupArgs.push(arg);
  }
  const result = { advanced, noBrowser, setupArgs };
  if (version) result.version = true;
  return result;
}

function defaultCacheRoot(options = {}) {
  if (options.cacheDir) return options.cacheDir;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  if (options.platform === 'win32' || process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Freebuff', 'cache');
  }
  if (options.platform === 'darwin' || process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'Freebuff');
  }
  return env.XDG_CACHE_HOME || path.join(home, '.cache');
}

async function resolveSetupContext(options, setupModule = setup) {
  const cacheRoot = defaultCacheRoot(options);
  if (options.release) {
    const sourceDir = await setupModule.ensureReleaseAssets(options.release, options.repository, cacheRoot);
    return {
      sourceDir,
      installerModule: require(path.join(sourceDir, 'install-mobile-connect.js')),
      options: { ...options, sourceDir, cacheDir: cacheRoot },
    };
  }
  const resolved = setupModule.resolveLocalStack(options.sourceDir, cacheRoot);
  return {
    sourceDir: resolved.sourceDir,
    installerModule: require(resolved.installerPath),
    options: { ...options, sourceDir: resolved.sourceDir, cacheDir: cacheRoot },
  };
}

function createLiveSetupController(options, setupModule = setup) {
  let contextPromise;
  let advancedMode = Boolean(options.advanced);
  const hostedAdapter = options.hostedAdapter || {
    async inspect() {
      return {
        status: 'unavailable',
        code: 'hosted_control_plane_unavailable',
        message: 'Freebuff-hosted relay onboarding is unavailable; use advanced setup.',
      };
    },
  };
  const context = () => {
    if (!contextPromise) contextPromise = resolveSetupContext(options, setupModule);
    return contextPromise;
  };

  return createSetupController({
    async inspect() {
      const resolved = await context();
      const report = await setupModule.collectState(resolved.options, resolved.installerModule);
      const actions = setupModule.planActions(report, resolved.options);
      if (report.verify?.errors?.some((problem) => problem.item === 'desktop')) {
        return {
          phase: 'desktop-missing',
          message: report.verify.errors[0].message,
          report,
          actions: [],
        };
      }
      const hosted = advancedMode
        ? { status: 'advanced', code: 'advanced_setup_selected', message: 'Advanced local setup selected.' }
        : await hostedAdapter.inspect(resolved.options);
      if (hosted.status === 'unavailable' && !actions.some((action) => action.id === 'advanced')) {
        actions.push({ id: 'advanced', description: 'Use advanced local setup' });
      }
      return {
        phase: hosted.status === 'unavailable' && actions.length === 1 ? 'hosted-unavailable' : undefined,
        message: hosted.status === 'unavailable' && actions.length === 1 ? hosted.message : undefined,
        report,
        hosted,
        actions,
      };
    },
    async execute(action, snapshot) {
      const resolved = await context();
      const optionsWithState = {
        ...resolved.options,
        desktopDir: snapshot.report.desktopDir,
        sourceDir: resolved.sourceDir,
      };
      if (action.id === 'upgrade') {
        return resolved.installerModule.installUiStack(optionsWithState);
      }
      if (action.id === 'advanced') {
        advancedMode = true;
        return { status: 'advanced' };
      }
      if (action.id === 'restart') {
        return setupModule.runRestartProxy(resolved.options);
      }
      if (action.id === 'restart-orchestrator') {
        return setupModule.runRestartOrchestrator(resolved.options);
      }
      if (action.id === 'tailscale') {
        const result = setupModule.applyTailscaleForward(
          snapshot.report.ports.desktopPort,
          snapshot.report.ports.proxyPort,
        );
        if (!result.ok) throw new Error(result.note);
        return result;
      }
      throw new Error(`unknown setup action: ${action.id}`);
    },
  });
}

function openBrowser(url, platform = process.platform, spawn = childProcess.spawn) {
  if (platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

async function startWizard({ controller, host = '127.0.0.1', port = 0, openBrowser: browserLauncher = openBrowser } = {}) {
  let closePromise = null;
  let closeServer = () => {
    if (!closePromise) {
      closePromise = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    return closePromise;
  };
  const server = createWizardServer({ controller, host, onClose: () => closeServer() });
  const address = await listen(server, host, port);
  const url = `http://${host}:${address.port}/`;
  await Promise.resolve(browserLauncher(url));
  return {
    controller,
    server,
    url,
    close: closeServer,
  };
}

function usage() {
  console.log(`Freebuff Setup

Usage:
  freebuff-setup [--no-browser] [setup options]

Options:
  --version               Print binary version
  --no-browser            Use existing terminal setup wizard
  --advanced              Select self-hosted/local transport path
  --help                  Show setup options
  --dry-run               Inspect and print planned changes

The browser wizard binds to loopback only. Existing setup options are passed
through to freebuff-gate-setup.js.`);
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseBinaryArgs(argv);
  if (parsed.version) {
    console.log(`freebuff-setup ${SETUP_VERSION}`);
    return 0;
  }
  if (parsed.setupArgs.includes('--help')) {
    usage();
    return setup.main(parsed.setupArgs);
  }
  if (parsed.noBrowser || parsed.setupArgs.includes('--dry-run')) {
    return setup.main(parsed.advanced ? [...parsed.setupArgs, '--advanced'] : parsed.setupArgs);
  }

  const options = setup.parseArgs(parsed.setupArgs);
  options.advanced = parsed.advanced;
  const controller = createLiveSetupController(options);
  await controller.refresh();
  const app = await startWizard({ controller });
  console.log(`Freebuff Setup wizard: ${app.url}`);
  console.log('Close browser tab or press Ctrl+C to stop.');
  return new Promise((resolve) => {
    const stop = () => app.close().finally(() => resolve(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  SETUP_VERSION,
  createLiveSetupController,
  defaultCacheRoot,
  listen,
  main,
  openBrowser,
  parseBinaryArgs,
  resolveSetupContext,
  startWizard,
};
