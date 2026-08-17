'use strict';

// E2E regression for delete-on-close of empty home threads.
//
// Boots the REAL Freebuff Desktop orchestrator hermetically (bundled bun,
// temp state + project dirs), points the repo's tailnet proxy at it, then
// drives a headless Chrome through the served bundle: wait for the boot
// hook to mint the pinned home thread, click its .tab-close, and assert
// the thread row is physically deleted from the orchestrator's sqlite DB.
//
// Requires a Freebuff Desktop install (for orchestrator.js + bundled bun)
// and a Chrome binary; both are discovered and the test skips when absent,
// matching the mobile-ui-screenshot.test.js convention.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { findFreebuffDesktop, orchestratorDirOf } = require('./install-mobile-connect');
const { createProxyServer } = require('./freebuff_tailnet_proxy');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExecutable(file) {
  try {
    return fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findChrome() {
  const candidates = [
    process.env.FB_CHROME_BIN,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const root of [
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'playwright'),
  ]) {
    try {
      for (const entry of fs.readdirSync(root)) {
        if (!entry.toLowerCase().startsWith('chromium')) continue;
        candidates.push(
          path.join(root, entry, 'chrome-linux64', 'chrome'),
          path.join(root, entry, 'chrome-linux', 'chrome'),
        );
      }
    } catch {
      // Browser cache is optional; CI supplies Chrome explicitly.
    }
  }

  for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
    const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0 && result.stdout.trim()) {
      candidates.push(result.stdout.trim());
    }
  }

  return candidates.find(isExecutable) || '';
}

function findBun(desktopDir) {
  const candidates = [
    path.join(desktopDir, 'squashfs-root', 'resources', 'bun', 'bun'),
    path.join(desktopDir, 'resources', 'bun', 'bun'),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  const result = spawnSync('sh', ['-lc', 'command -v bun'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener('message', (event) => {
      const raw =
        typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }
      const listeners = this.events.get(message.method) || [];
      listeners.forEach((listener) => listener(message.params || {}));
    });
    socket.addEventListener('close', () => {
      const error = new Error('Chrome DevTools socket closed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.events.get(method) || [];
    listeners.push(listener);
    this.events.set(method, listeners);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Chrome cleanup is best effort after a test failure.
    }
  }
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Could not connect to Chrome DevTools')),
      { once: true },
    );
  });
  return new CdpClient(socket);
}

async function launchChrome(chromePath) {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-e2e-chrome-'));
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--remote-allow-origins=*',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });

  try {
    let targets = [];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(
          `Chrome exited before DevTools started${stderr ? `: ${stderr}` : ''}`,
        );
      }
      try {
        targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        if (targets.some((target) => target.type === 'page')) break;
      } catch {
        // Chrome needs a short moment to bind its DevTools endpoint.
      }
      await delay(50);
    }
    const target = targets.find((entry) => entry.type === 'page');
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(
        `Chrome DevTools page target unavailable${stderr ? `: ${stderr}` : ''}`,
      );
    }
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    return { cdp, child, userDataDir };
  } catch (error) {
    child.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`Browser evaluation failed: ${expression}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function closeChrome(browser) {
  if (!browser) return;
  browser.cdp.close();
  if (browser.child.exitCode === null) browser.child.kill('SIGTERM');
  await delay(100);
  if (browser.child.exitCode === null) browser.child.kill('SIGKILL');
  fs.rmSync(browser.userDataDir, { recursive: true, force: true });
}

// Queries the orchestrator's sqlite DB with the bundled bun (node has no
// builtin sqlite in this runtime). Returns thread rows as plain objects.
function readThreads(bunPath, dbPath) {
  const script = `
const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
const rows = db.query('SELECT id, title, status, created_at FROM threads ORDER BY created_at').all();
console.log(JSON.stringify(rows));
`;
  const result = spawnSync(bunPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0) {
    throw new Error(`sqlite probe failed: ${result.stderr || result.stdout}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

async function waitForThreads(bunPath, dbPath, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rows;
    try {
      rows = readThreads(bunPath, dbPath);
    } catch {
      rows = [];
    }
    if (predicate(rows)) return rows;
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for DB condition (${dbPath}); last rows: ${JSON.stringify(
      readThreads(bunPath, dbPath),
    )}`,
  );
}

function stopOrchestrator(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const grace = Date.now() + 3000;
  const timer = setInterval(() => {
    if (child.exitCode !== null || Date.now() > grace) {
      clearInterval(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 100);
}

test('closing an empty home thread deletes its row from the orchestrator DB', async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    if (process.env.CI) {
      assert.fail('Chrome executable not found; thread-delete E2E cannot run');
    }
    t.skip('Chrome executable not found; set FB_CHROME_BIN to run locally');
    return;
  }

  let desktopDir;
  try {
    desktopDir = findFreebuffDesktop();
  } catch (error) {
    if (process.env.CI) {
      assert.fail(`Freebuff Desktop install not found: ${error.message}`);
    }
    t.skip(`Freebuff Desktop install not found (${error.message}); set FREEBUFF_DESKTOP_DIR to run locally`);
    return;
  }
  const orchestratorDir = orchestratorDirOf(desktopDir);
  const orchestratorPath = path.join(orchestratorDir, 'orchestrator.js');
  const uiDir = path.join(orchestratorDir, 'ui');
  const bunPath = findBun(desktopDir);
  if (!bunPath || !fs.existsSync(orchestratorPath) || !fs.existsSync(uiDir)) {
    if (process.env.CI) {
      assert.fail(`Orchestrator (${orchestratorPath}) or bun not found`);
    }
    t.skip('Orchestrator or bundled bun not found in the Freebuff Desktop install');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-thread-delete-e2e-'));
  const stateDir = path.join(tmpRoot, 'state');
  const projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      workspace: {
        tabs: [{ id: '11111111-1111-1111-1111-111111111111', projectPath: projDir }],
        activeId: '11111111-1111-1111-1111-111111111111',
        windows: [],
      },
      recentProjects: [projDir],
      analyticsId: `anon_e2e_${Date.now()}`,
    }),
  );
  const dbPath = path.join(projDir, '.freebuff', 'desktop-v2.db');

  const orchestratorPort = await freePort();
  const orchestrator = spawn(bunPath, [orchestratorPath], {
    cwd: orchestratorDir,
    env: {
      ...process.env,
      PORT: String(orchestratorPort),
      FREEBUFF_UI_DIR: uiDir,
      FREEBUFF_DESKTOP_STATE_PATH: stateFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let orchStderr = '';
  orchestrator.stderr.on('data', (chunk) => {
    orchStderr += chunk.toString();
    if (orchStderr.length > 2000) orchStderr = orchStderr.slice(-2000);
  });

  let proxy;
  let browser;
  try {
    // Wait for the orchestrator HTTP port to answer.
    const orchDeadline = Date.now() + 20000;
    while (Date.now() < orchDeadline) {
      if (orchestrator.exitCode !== null) {
        throw new Error(`orchestrator exited early: ${orchStderr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${orchestratorPort}/api/projects`);
        if (res.ok) break;
      } catch {
        // Not up yet.
      }
      await delay(200);
    }

    proxy = createProxyServer({ upstream: `http://127.0.0.1:${orchestratorPort}` });
    const proxyPort = await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port));
    });

    browser = await launchChrome(chromePath);
    const { cdp } = browser;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${proxyPort}/` });

    // Boot hook must mint the pinned home thread, and its tab must render
    // a close button (empty home tabs are closable only with the CLOSE_BTN
    // patch).
    await waitFor(
      cdp,
      `document.readyState === 'complete' && !!document.querySelector('.tab-close')`,
      30000,
    );
    const threads = await waitForThreads(
      bunPath,
      dbPath,
      (rows) => rows.length >= 1,
    );
    const homeThread = threads.find((row) => row.status === 'open') || threads[0];
    assert.ok(homeThread, 'boot hook created a home thread row');

    // Click the only tab's close button.
    await evaluate(cdp, `document.querySelector('.tab-close').click()`);

    // The row must be physically deleted, not just marked closed.
    await waitForThreads(
      bunPath,
      dbPath,
      (rows) => !rows.some((row) => row.id === homeThread.id),
      15000,
    );
    const after = readThreads(bunPath, dbPath);
    assert.ok(
      !after.some((row) => row.id === homeThread.id),
      `thread ${homeThread.id} is deleted from the DB`,
    );
  } finally {
    if (browser) await closeChrome(browser);
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    stopOrchestrator(orchestrator);
    await delay(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
