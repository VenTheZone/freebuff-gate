'use strict';

// E2E regression for cross-surface thread convergence (CREATE_REUSE V6).
//
// Boots the REAL Freebuff Desktop orchestrator hermetically (bundled bun,
// temp state + project dirs), points the repo's tailnet proxy at it, seeds a
// last-message thread (real create endpoint + sqlite message rows) plus a
// newer-but-empty decoy thread, then drives TWO headless Chrome contexts
// (separate user-data dirs = separate localStorage, standing in for Gate
// Desktop and Gate Mobile) through the served bundle. Asserts BOTH contexts
// open the seeded last-message thread and that NO new thread row appears in
// the orchestrator DB (the old per-context pin behavior stacked an empty
// "New thread" per surface).
//
// Requires a Freebuff Desktop install (for orchestrator.js + bundled bun)
// and a Chrome binary; both are discovered and the test skips when absent,
// matching the thread-delete-e2e.test.js convention.

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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-converge-chrome-'));
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

async function waitFor(cdp, expression, timeoutMs = 30000) {
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

// The tab element's DOM id is `thread-tab-<threadId>` (the home tab renders
// the home glyph instead of the title, so the id is the reliable signal). A
// V6 boot must open the seeded last-message thread — any freshly created
// "New thread" would carry a different id.
function activeTabIdExpression() {
  return `(() => {
    const active = document.querySelector('.tab-select[aria-selected="true"]')
      || document.querySelector('.tab-select');
    return active ? active.id : '';
  })()`;
}

// Reads thread rows straight from the orchestrator sqlite DB (bundled bun;
// node has no builtin sqlite in this runtime).
function readThreads(bunPath, dbPath) {
  const script = `
const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
const rows = db.query('SELECT id, title, status, created_at, last_prompt_at FROM threads ORDER BY created_at').all();
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

async function waitForThreadCount(bunPath, dbPath, count, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let rows;
    try {
      rows = readThreads(bunPath, dbPath);
    } catch {
      rows = [];
    }
    if (rows.length >= count) return rows;
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for >= ${count} thread rows (${dbPath}); last: ${JSON.stringify(
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

test('desktop and mobile contexts both open the last-message thread instead of stacking', async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    if (process.env.CI) {
      assert.fail('Chrome executable not found; thread-converge E2E cannot run');
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

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-converge-e2e-'));
  const stateDir = path.join(tmpRoot, 'state');
  const projDir = path.join(tmpRoot, 'proj');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      workspace: {
        tabs: [{ id: '22222222-2222-2222-2222-222222222222', projectPath: projDir }],
        activeId: '22222222-2222-2222-2222-222222222222',
        windows: [],
      },
      recentProjects: [projDir],
      analyticsId: `anon_converge_${Date.now()}`,
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
  let browser1;
  let browser2;
  try {
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

    // Seed: thread A = the last-message thread, thread B = a newer empty
    // decoy. Both via the real create endpoint; A gets messages + activity
    // timestamps straight into sqlite so the wire Thread carries
    // lastPromptAt (the signal CREATE_REUSE V6 ranks by).
    const createThread = () =>
      fetchJson(`http://127.0.0.1:${orchestratorPort}/api/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    const threadA = await createThread();
    const threadB = await createThread();
    assert.ok(threadA && threadA.id, 'thread A created');
    assert.ok(threadB && threadB.id, 'thread B created');

    const seedScript = `
const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(dbPath)});
const now = Date.now();
db.query('UPDATE threads SET title = ?, last_prompt_at = ?, updated_at = ? WHERE id = ?')
  .run('Resume me', now, now, ${JSON.stringify(threadA.id)});
const ins = db.query('INSERT INTO messages (thread_id, role, parts_json, attachments_json, metrics_json, ts) VALUES (?, ?, ?, ?, ?, ?)');
ins.run(${JSON.stringify(threadA.id)}, 'user', '[]', '[]', '{}', now - 2000);
ins.run(${JSON.stringify(threadA.id)}, 'assistant', '[]', '[]', '{}', now - 1000);
console.log('seeded');
`;
    const seedResult = spawnSync(bunPath, ['-e', seedScript], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(
      seedResult.status,
      0,
      `seed failed: ${seedResult.stderr || seedResult.stdout}`,
    );

    // Both seeded rows must belong to the opened project or V6's
    // projectPath filter would ignore them and a new thread would be created.
    const seededRows = readThreads(bunPath, dbPath);
    assert.equal(seededRows.length, 2, 'exactly two seeded thread rows');
    const pathScript = `
const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
console.log(JSON.stringify(db.query('SELECT id, project_path FROM threads').all()));
`;
    const pathResult = spawnSync(bunPath, ['-e', pathScript], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const withPaths = JSON.parse(pathResult.stdout.trim());
    for (const row of withPaths) {
      assert.equal(row.project_path, projDir, 'seeded thread belongs to the opened project');
    }

    proxy = createProxyServer({ upstream: `http://127.0.0.1:${orchestratorPort}` });
    const proxyPort = await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port));
    });

    // Serve the bundle and confirm V6 is what both contexts will run.
    const served = await (
      await fetch(`http://127.0.0.1:${proxyPort}/assets/index-BC09OLJz.js`)
    ).text();
    assert.ok(served.includes('lastPromptAt'), 'served bundle carries the V7 last-message ranking');
    assert.ok(served.includes('Object.keys(G.getState().threads).length)return create'), 'served bundle carries the V7 settle-then-create hydration wait');

    // Context 1 = Gate Desktop, context 2 = Gate Mobile: fresh user-data dirs
    // (separate localStorage) so no pin is shared between them.
    for (const [name, holder] of [
      ['desktop', 'browser1'],
      ['mobile', 'browser2'],
    ]) {
      const browser = await launchChrome(chromePath);
      if (holder === 'browser1') browser1 = browser;
      else browser2 = browser;
      const { cdp } = browser;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${proxyPort}/` });

      // V6 must open the seeded last-message thread: the active tab's DOM id
      // is thread-tab-<threadId>. A freshly created "New thread" would carry
      // a different id and fail this wait.
      const expectedTabId = `thread-tab-${threadA.id}`;
      try {
        await waitFor(
          cdp,
          `document.readyState === 'complete' && (${activeTabIdExpression()}) === ${JSON.stringify(expectedTabId)}`,
          30000,
        );
      } catch (error) {
        const dump = await evaluate(
          cdp,
          `(() => { const act = document.querySelector('.tab-select[aria-selected="true"]') || document.querySelector('.tab-select'); return JSON.stringify({ readyState: document.readyState, activeTabId: act ? act.id : null, tabCount: document.querySelectorAll('.tab-select').length, bodyText: (document.body ? document.body.innerText : '').slice(0, 150) }); })()`,
        );
        const dbRows = readThreads(bunPath, dbPath);
        console.error(`[converge-e2e] ${name} page dump: ${dump}`);
        console.error(`[converge-e2e] ${name} db rows: ${JSON.stringify(dbRows)}`);
        throw error;
      }
      const actualTabId = await evaluate(cdp, activeTabIdExpression());
      assert.equal(
        actualTabId,
        expectedTabId,
        `${name} context landed on the last-message thread (got: ${JSON.stringify(actualTabId)})`,
      );
    }

    // The stacking regression: neither context may have created a NEW thread
    // row. Exactly the two seeded rows must remain.
    await delay(1500); // let any (wrong) boot-hook create settle before counting
    const finalRows = readThreads(bunPath, dbPath);
    assert.equal(
      finalRows.length,
      2,
      `no new thread rows after both contexts boot (got ${finalRows.length}: ${JSON.stringify(finalRows)})`,
    );
    assert.ok(
      finalRows.some((row) => row.id === threadA.id),
      'last-message thread still present',
    );
    assert.ok(
      finalRows.some((row) => row.id === threadB.id),
      'decoy thread still present',
    );
  } finally {
    if (browser1) await closeChrome(browser1);
    if (browser2) await closeChrome(browser2);
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    stopOrchestrator(orchestrator);
    await delay(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
