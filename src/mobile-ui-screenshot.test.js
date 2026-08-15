'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const SOURCE_DIR = __dirname;
const FIXTURE = fs.readFileSync(
  path.join(SOURCE_DIR, 'mobile-ui-screenshot-fixture.html'),
);
const MOBILE_CSS = fs.readFileSync(path.join(SOURCE_DIR, 'mobile-ui.css'));
const MOBILE_JS = fs.readFileSync(path.join(SOURCE_DIR, 'mobile-ui.js'));

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

function createFixtureServer() {
  const sessionStatus = {
    screenshot: 'running',
    'opus-session': 'stopped',
    'recent-sonnet': 'stopped',
  };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const files = {
      '/': [FIXTURE, 'text/html; charset=utf-8'],
      '/mobile-ui-screenshot-fixture.html': [FIXTURE, 'text/html; charset=utf-8'],
      '/mobile-ui.css': [MOBILE_CSS, 'text/css; charset=utf-8'],
      '/mobile-ui.js': [MOBILE_JS, 'text/javascript; charset=utf-8'],
    };

    if (pathname === '/api/projects') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify({
          projects: [
            {
              path: '/workspace/freebuff',
              freebuff: {
                models: [
                  { id: 'fable-5', displayName: 'Fable 5' },
                  { id: 'sonnet-5', displayName: 'Sonnet 5' },
                  { id: 'opus-4.8', displayName: 'Opus 4.8' },
                ],
                activeSessionsByThread: {
                  screenshot: {
                    model: 'fable-5',
                    turnState: sessionStatus.screenshot,
                  },
                  'opus-session': {
                    model: 'opus-4.8',
                    turnState: sessionStatus['opus-session'],
                  },
                },
                sessionSlots: {
                  premium: { holders: ['screenshot', 'opus-session'] },
                  unlimited: { holders: [] },
                },
              },
              threads: [
                {
                  id: 'screenshot',
                  title: 'Mobile screenshot review',
                  model: 'fable-5',
                  turnState: sessionStatus.screenshot,
                  archivedAt: null,
                  lastPromptAt: Date.now(),
                },
                {
                  id: 'opus-session',
                  title: 'Disabled model session',
                  model: 'opus-4.8',
                  turnState: sessionStatus['opus-session'],
                  lastTurnOutcome: 'stopped',
                  archivedAt: null,
                  lastPromptAt: Date.now() - 5 * 60 * 1000,
                },
                {
                  id: 'recent-sonnet',
                  projectPath: '/workspace/freebuff',
                  title: 'Recent model session',
                  model: 'sonnet-5',
                  turnState: sessionStatus['recent-sonnet'],
                  lastTurnOutcome: 'finished',
                  archivedAt: null,
                  lastPromptAt: Date.now() - 15 * 60 * 1000,
                },
              ],
            },
          ],
        }),
      );
      return;
    }

    const asset = files[pathname];
    if (!asset) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': asset[1],
      'cache-control': 'no-store',
    });
    response.end(asset[0]);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Fixture server did not expose an address'));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/`,
        sessionStatus,
      });
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
          pending.reject(
            new Error(
              `${message.error.code}: ${message.error.message}`,
            ),
          );
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
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'freebuff-mobile-ui-chrome-'),
  );
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
    // GitHub-hosted runners can take longer than local Chrome to create its
    // first page target after the DevTools port starts listening.
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
    throw new Error('Fixture evaluation failed');
  }
  return result.result ? result.result.value : undefined;
}

async function accessibilityNodes(cdp) {
  const result = await cdp.send('Accessibility.getFullAXTree');
  return (result.nodes || []).map((node) => ({
    role: node.role && node.role.value,
    name: node.name && node.name.value,
    description: node.description && node.description.value,
  }));
}

function hasAccessibleStatus(nodes, text) {
  const hasStatus = nodes.some((node) => node.role === 'status');
  const hasText = nodes.some((node) => String(node.name || '').includes(text));
  return hasStatus && hasText;
}

async function waitFor(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function rgbChannels(value) {
  const channels = value.match(/\d+(?:\.\d+)?/g);
  return channels ? channels.slice(0, 3).map(Number) : [];
}

async function capture(cdp, file) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const image = Buffer.from(result.data, 'base64');
  fs.writeFileSync(file, image);
  return image;
}

async function closeChrome(browser) {
  if (!browser) return;
  browser.cdp.close();
  if (browser.child.exitCode === null) browser.child.kill('SIGTERM');
  await delay(100);
  if (browser.child.exitCode === null) browser.child.kill('SIGKILL');
  fs.rmSync(browser.userDataDir, { recursive: true, force: true });
}

test('mobile UI screenshot regression covers header, composer pills, and task dock', async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    if (process.env.CI) {
      assert.fail('Chrome executable not found; CI screenshot coverage cannot run');
    }
    t.skip('Chrome executable not found; set FB_CHROME_BIN to run locally');
    return;
  }

  const fixture = await createFixtureServer();
  let browser;
  const outputDir =
    process.env.FB_MOBILE_SCREENSHOT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mobile-ui-screenshots-'));
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    browser = await launchChrome(chromePath);
    const { cdp } = browser;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Accessibility.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Page.navigate', { url: fixture.url });

    await waitFor(
      cdp,
      `(() => Boolean(
        document.querySelector('.fb-session-switch') &&
        document.querySelector('.fb-ctx-fab') &&
        document.querySelector('.fb-composer-pills .fb-model-pill') &&
        document.querySelector('.fb-composer-pills .fb-effort-pill') &&
        document.querySelector('.fb-composer-pills .fb-time-pill') &&
        document.querySelector('.thread-bottom .todo-dock')
      ))()`,
    );
    await delay(180);

    const layout = await evaluate(
      cdp,
      `(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            left: box.left,
            width: box.width,
            height: box.height,
            display: style.display,
            visibility: style.visibility,
            position: style.position,
          };
        };
        const header = rect('.tabbar');
        const title = document.querySelector('.tab.active .tab-title');
        const pills = rect('.fb-composer-pills');
        const task = rect('.thread-bottom .todo-dock');
        const composer = rect('.composer');
        const streaming = rect('.fb-streaming-indicator');
        return {
          viewport: { width: innerWidth, height: innerHeight },
          header,
          title: title && title.textContent.trim(),
          sessionButton: rect('.fb-session-switch'),
          contextButton: rect('.fb-ctx-fab'),
          streaming,
          pills,
          pillCount: document.querySelectorAll('.fb-composer-pills > button').length,
          task,
          composer,
          taskHidden: document
            .querySelector('.thread-bottom .todo-dock')
            .classList.contains('fb-float-collision-hidden'),
          rootTaskTop: getComputedStyle(document.documentElement).getPropertyValue(
            '--fb-mobile-todo-top',
          ).trim(),
        };
      })()`,
    );

    assert.deepEqual(layout.viewport, { width: 390, height: 844 });
    assert.equal(layout.title, 'Mobile screenshot review');
    assert.ok(layout.header);
    assert.ok(layout.header.height >= 47 && layout.header.height <= 50);
    assert.ok(layout.sessionButton && layout.sessionButton.width >= 40);
    assert.ok(layout.contextButton && layout.contextButton.width >= 40);
    assert.ok(layout.streaming && layout.streaming.display !== 'none');
    assert.equal(layout.pillCount, 3);
    assert.ok(layout.pills && layout.pills.display !== 'none');
    assert.ok(layout.pills.height >= 36);
    assert.ok(layout.composer && layout.composer.bottom <= 844);
    assert.ok(layout.pills.bottom <= layout.composer.top + 1);
    assert.ok(layout.task && layout.task.display !== 'none');
    assert.equal(layout.task.visibility, 'visible');
    assert.equal(layout.taskHidden, false);
    assert.ok(layout.rootTaskTop.endsWith('px'));
    assert.ok(
      layout.task.top >= layout.header.bottom + 7,
      `task card overlaps header: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.task.bottom <= layout.pills.top - 5,
      `task card overlaps composer pills: ${JSON.stringify(layout)}`,
    );
    assert.ok(layout.task.width >= 370);

    const screenshot = await capture(
      cdp,
      path.join(outputDir, 'mobile-ui-header-composer-task.png'),
    );
    const dimensions = pngDimensions(screenshot);
    assert.deepEqual(dimensions, { width: 390, height: 844 });
    assert.ok(screenshot.length > 5000, 'mobile screenshot is unexpectedly empty');

    await evaluate(cdp, "document.querySelector('.fb-model-pill').click()");
    await waitFor(
      cdp,
      "Boolean(document.querySelector('.fb-model-session-summary')) && Boolean(document.querySelector('.fb-model-sheet-close')) && document.querySelectorAll('.fb-model-session-count').length === 3 && document.querySelector('.fb-model-session-users').textContent === 'Used by: Mobile screenshot review'",
    );
    const availability = await evaluate(
      cdp,
      `(() => ({
        summary: document.querySelector('.fb-model-session-summary').textContent,
        role: document.querySelector('.fb-model-session-summary').getAttribute('role'),
        live: document.querySelector('.fb-model-session-summary').getAttribute('aria-live'),
        atomic: document.querySelector('.fb-model-session-summary').getAttribute('aria-atomic'),
        summaryVisible: (() => {
          const element = document.querySelector('.fb-model-session-summary');
          const box = element.getBoundingClientRect();
          return getComputedStyle(element).display !== 'none' && box.width > 0 && box.height > 0;
        })(),
        counts: Array.from(document.querySelectorAll('.fb-model-session-count')).map((element) => {
          const box = element.getBoundingClientRect();
          const option = element.closest('.freebuff-model-option');
          const reset = option && option.querySelector('.fb-model-session-reset');
          const resetBox = reset && reset.getBoundingClientRect();
          const users = option && option.parentElement
            ? Array.from(option.parentElement.querySelectorAll('.fb-model-session-users')).find(
                (candidate) => candidate.getAttribute('data-fb-model-session-for') === option.getAttribute('title'),
              )
            : null;
          const usersBox = users && users.getBoundingClientRect();
          const usersStyle = users && getComputedStyle(users);
          return {
            text: element.textContent,
            className: element.className,
            title: element.title,
            ariaLabel: element.getAttribute('aria-label'),
            color: getComputedStyle(element).color,
            visible: getComputedStyle(element).display !== 'none' && box.width > 0 && box.height > 0,
            resetText: reset && reset.textContent,
            resetVisible: Boolean(reset && getComputedStyle(reset).display !== 'none' && resetBox.width > 0 && resetBox.height > 0),
            usersText: users && users.textContent,
            usersVisible: Boolean(users && usersStyle.display !== 'none' && usersBox.width > 0 && usersBox.height > 0),
            optionAria: option && option.getAttribute('aria-label'),
          };
        }),
      }))()`,
    );
    assert.equal(
      availability.summary,
      'Session availability · Premium: 2 available · Unlimited: 2 available',
    );
    assert.equal(availability.role, 'status');
    assert.equal(availability.live, 'polite');
    assert.equal(availability.atomic, 'true');
    assert.equal(availability.summaryVisible, true);
    assert.deepEqual(
      availability.counts.map((count) => count.text),
      ['2 available', '2 available', 'At capacity'],
    );
    assert.ok(availability.counts.every((count) => count.visible));
    assert.ok(availability.counts.every((count) => count.usersVisible));
    assert.match(availability.counts[0].className, /available/);
    assert.match(availability.counts[2].className, /none/);
    assert.equal(
      availability.counts[0].usersText,
      'Used by: Mobile screenshot review',
    );
    assert.equal(availability.counts[1].usersText, 'Session names unavailable');
    assert.equal(availability.counts[2].usersText, 'Used by: Disabled model session');
    assert.equal(
      availability.counts[0].ariaLabel,
      'Session availability: 2 available. Used by: Mobile screenshot review',
    );
    assert.equal(
      availability.counts[0].title,
      '2 available · 1/3 used · Used by: Mobile screenshot review',
    );
    assert.notEqual(availability.counts[2].color, 'rgb(255, 130, 151)');
    assert.deepEqual(
      availability.counts.map((count) => count.resetText),
      ['Resets Fri, 6:00 PM', 'Resets Sat, 8:00 PM', 'Resets Fri, 6:00 PM'],
    );
    assert.ok(availability.counts.every((count) => count.resetVisible));
    assert.match(availability.counts[0].optionAria, /Resets Fri, 6:00 PM/);
    assert.ok(
      hasAccessibleStatus(await accessibilityNodes(cdp), availability.summary),
      'model session availability missing from Chromium accessibility tree',
    );

    await evaluate(
      cdp,
      `(() => {
        const badge = document.querySelector(
          '.freebuff-model-option[title="Fable 5"] .model-badge',
        );
        const sonnet = document.querySelector(
          '.freebuff-model-option[title="Sonnet 5"]',
        );
        badge.textContent = 'Premium · 2/3 tabs in use';
        sonnet.setAttribute(
          'data-tooltip',
          'Unlimited sessions today. Resets Sun, 9:00 PM.',
        );
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      `(() => {
        const summary = document.querySelector('.fb-model-session-summary');
        const count = document.querySelector(
          '.freebuff-model-option[title="Fable 5"] .fb-model-session-count',
        );
        return Boolean(summary && count) &&
          summary.textContent.includes('Premium: 1 available') &&
          count.textContent === '1 available' &&
          document.querySelector(
            '.freebuff-model-option[title="Sonnet 5"] .fb-model-session-reset',
          ).textContent === 'Resets Sun, 9:00 PM';
      })()`,
    );
    const refreshedAvailability = await evaluate(
      cdp,
      `(() => ({
        summary: document.querySelector('.fb-model-session-summary').textContent,
        count: document.querySelector(
          '.freebuff-model-option[title="Fable 5"] .fb-model-session-count',
        ).textContent,
        detail: document.querySelector(
          '.freebuff-model-option[title="Fable 5"] .fb-model-session-count',
        ).title,
        reset: document.querySelector(
          '.freebuff-model-option[title="Sonnet 5"] .fb-model-session-reset',
        ).textContent,
      }))()`,
    );
    assert.equal(
      refreshedAvailability.summary,
      'Session availability · Premium: 1 available · Unlimited: 2 available',
    );
    assert.equal(refreshedAvailability.count, '1 available');
    assert.equal(
      refreshedAvailability.detail,
      '1 available · 2/3 used · Used by: Mobile screenshot review',
    );
    assert.equal(refreshedAvailability.reset, 'Resets Sun, 9:00 PM');
    assert.ok(
      hasAccessibleStatus(
        await accessibilityNodes(cdp),
        refreshedAvailability.summary,
      ),
      'refreshed model session availability missing from Chromium accessibility tree',
    );

    const modelScreenshot = await capture(
      cdp,
      path.join(outputDir, 'mobile-ui-model-picker-availability.png'),
    );
    assert.deepEqual(pngDimensions(modelScreenshot), { width: 390, height: 844 });
    assert.ok(modelScreenshot.length > 5000, 'model picker screenshot is unexpectedly empty');

    const sessionLink = await evaluate(
      cdp,
      `(() => {
        const link = document.querySelector('.fb-model-session-user');
        return {
          text: link && link.textContent,
          role: link && link.getAttribute('role'),
          tabIndex: link && link.getAttribute('tabindex'),
          ariaLabel: link && link.getAttribute('aria-label'),
        };
      })()`,
    );
    assert.deepEqual(sessionLink, {
      text: 'Mobile screenshot review',
      role: 'button',
      tabIndex: '0',
      ariaLabel: 'Switch to session “Mobile screenshot review”',
    });
    await evaluate(cdp, "document.querySelector('.fb-model-session-user').click()");
    await waitFor(cdp, "!document.querySelector('.agent-menu')");
    await waitFor(
      cdp,
      "document.querySelector('.fb-mobile-live-region').textContent.includes('Selected session: “Mobile screenshot review”.')",
    );
    const directSelection = await evaluate(
      cdp,
      `(() => ({
        status: document.querySelector('.fb-mobile-live-region').textContent,
        active: document.querySelector('.tab.active .tab-title').textContent,
      }))()`,
    );
    assert.equal(
      directSelection.status,
      'Selected session: “Mobile screenshot review”.',
    );
    assert.equal(directSelection.active, 'Mobile screenshot review');

    await evaluate(cdp, "document.querySelector('.fb-model-pill').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-model-session-user'))");
    const disabledSessionLink = await evaluate(
      cdp,
      `(() => {
        const link = document.querySelector(
          '.fb-model-session-users[data-fb-model-session-for="Opus 4.8"] .fb-model-session-user',
        );
        return {
          text: link && link.textContent,
          pointerEvents: link && getComputedStyle(link).pointerEvents,
          ariaLabel: link && link.getAttribute('aria-label'),
        };
      })()`,
    );
    assert.deepEqual(disabledSessionLink, {
      text: 'Disabled model session',
      pointerEvents: 'auto',
      ariaLabel: 'Switch to session “Disabled model session”',
    });
    await evaluate(
      cdp,
      'document.querySelector(\'.fb-model-session-users[data-fb-model-session-for="Opus 4.8"] .fb-model-session-user\').click()',
    );
    await waitFor(cdp, "!document.querySelector('.agent-menu')");
    await waitFor(
      cdp,
      "document.querySelector('.fb-mobile-live-region').textContent.includes('Selected session: “Disabled model session”.')",
    );

    await evaluate(cdp, "document.querySelector('.fb-model-pill').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-model-session-user'))");
    await evaluate(
      cdp,
      `(() => {
        const link = document.querySelector('.fb-model-session-user');
        link.focus();
        link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return document.activeElement === link;
      })()`,
    );
    await waitFor(cdp, "!document.querySelector('.agent-menu')");
    await waitFor(
      cdp,
      "document.querySelector('.fb-mobile-live-region').textContent.includes('Selected session: “Mobile screenshot review”.')",
    );

    await evaluate(cdp, "document.querySelector('.fb-model-pill').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-model-sheet-close'))");
    await evaluate(cdp, "document.querySelector('.fb-model-sheet-close').click()");
    await waitFor(cdp, "!document.querySelector('.agent-menu')");

    await evaluate(
      cdp,
      `(() => {
        window.__nativeCloseClicks = 0;
        document.querySelector('.tab-close').addEventListener('click', () => {
          window.__nativeCloseClicks += 1;
        });
        return true;
      })()`,
    );
    await evaluate(cdp, "document.querySelector('.fb-session-switch').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-menu-close'))");
    await waitFor(
      cdp,
      "document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-model').length === 2 && document.querySelector('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-model').textContent === 'Fable 5' && document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-model')[1].textContent === 'Opus 4.8' && document.querySelector('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-model').getAttribute('aria-label') === 'Model: Fable 5' && document.querySelector('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-status').textContent === 'Running' && document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-status')[1].textContent === 'Stopped'",
    );
    const sessionModelLegend = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not(.recent)')).map((row) => ({
        title: row.querySelector('.fb-session-menu-label').textContent,
        model: row.querySelector('.fb-session-menu-model').textContent,
        modelAria: row.querySelector('.fb-session-menu-model').getAttribute('aria-label'),
        status: row.querySelector('.fb-session-menu-status').textContent,
        statusAria: row.querySelector('.fb-session-menu-status').getAttribute('aria-label'),
      }))`,
    );
    assert.deepEqual(sessionModelLegend, [
      {
        title: 'Mobile screenshot review',
        model: 'Fable 5',
        modelAria: 'Model: Fable 5',
        status: 'Running',
        statusAria: 'Session status: Running',
      },
      {
        title: 'Disabled model session',
        model: 'Opus 4.8',
        modelAria: 'Model: Opus 4.8',
        status: 'Stopped',
        statusAria: 'Session status: Stopped',
      },
    ]);
    const sessionStatusScreenshot = await capture(
      cdp,
      path.join(outputDir, 'mobile-ui-session-status.png'),
    );
    assert.deepEqual(pngDimensions(sessionStatusScreenshot), {
      width: 390,
      height: 844,
    });
    assert.ok(
      sessionStatusScreenshot.length > 5000,
      'session status screenshot is unexpectedly empty',
    );
    const sessionStatusSemantics = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not(.recent) .fb-session-menu-status')).map((status) => {
        const box = status.getBoundingClientRect();
        const style = getComputedStyle(status);
        return {
          text: status.textContent,
          aria: status.getAttribute('aria-label'),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0,
        };
      })`,
    );
    assert.deepEqual(sessionStatusSemantics, [
      { text: 'Running', aria: 'Session status: Running', visible: true },
      { text: 'Stopped', aria: 'Session status: Stopped', visible: true },
    ]);
    await waitFor(
      cdp,
      "Boolean(document.querySelector('.fb-session-menu-item.recent .fb-session-menu-model')) && document.querySelector('.fb-session-menu-item.recent .fb-session-menu-model').textContent === 'Sonnet 5' && document.querySelector('.fb-session-menu-item.recent .fb-session-menu-status').textContent === 'Stopped'",
    );
    const recentRows = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.fb-session-menu-item.recent')).map((row) => ({
        title: row.querySelector('.fb-session-menu-label').textContent,
        model: row.querySelector('.fb-session-menu-model').textContent,
        modelAria: row.querySelector('.fb-session-menu-model').getAttribute('aria-label'),
        status: row.querySelector('.fb-session-menu-status').textContent,
        statusAria: row.querySelector('.fb-session-menu-status').getAttribute('aria-label'),
      }))`,
    );
    assert.deepEqual(recentRows, [
      {
        title: 'Recent model session',
        model: 'Sonnet 5',
        modelAria: 'Model: Sonnet 5',
        status: 'Stopped',
        statusAria: 'Session status: Stopped',
      },
    ]);
    const modelFilterInfo = await evaluate(
      cdp,
      `(() => {
        const filter = document.querySelector('.fb-session-menu-filter');
        return {
          tag: filter && filter.tagName,
          ariaLabel: filter && filter.getAttribute('aria-label'),
          value: filter && filter.value,
          options: filter ? Array.from(filter.options).map((option) => option.textContent) : [],
        };
      })()`,
    );
    assert.deepEqual(modelFilterInfo, {
      tag: 'SELECT',
      ariaLabel: 'Filter sessions by model',
      value: 'all',
      options: ['All models', 'Fable 5', 'Opus 4.8', 'Sonnet 5'],
    });
    await evaluate(
      cdp,
      `(() => {
        const filter = document.querySelector('.fb-session-menu-filter');
        filter.value = 'opus48';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      `(() => {
        const rows = Array.from(document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]'));
        const visible = rows.filter((row) => !row.hidden).map((row) => row.getAttribute('data-fb-session-id'));
        return visible.length === 1 && visible[0] === 'opus-session' &&
          document.querySelector('.fb-session-menu-filter').value === 'opus48';
      })()`,
    );
    const opusFilterRows = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]')).map((row) => ({
        id: row.getAttribute('data-fb-session-id'),
        hidden: row.hidden,
        ariaHidden: row.getAttribute('aria-hidden'),
      }))`,
    );
    assert.deepEqual(opusFilterRows, [
      { id: 'screenshot', hidden: true, ariaHidden: 'true' },
      { id: 'opus-session', hidden: false, ariaHidden: 'false' },
      { id: 'recent-sonnet', hidden: true, ariaHidden: 'true' },
    ]);
    await evaluate(
      cdp,
      `(() => {
        const filter = document.querySelector('.fb-session-menu-filter');
        filter.value = 'sonnet5';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      "document.querySelector('.fb-session-menu-item[data-fb-session-id=\\\"recent-sonnet\\\"]').hidden === false && document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not([hidden])').length === 1",
    );
    await evaluate(
      cdp,
      `(() => {
        const recent = document.querySelector('.fb-session-menu-item[data-fb-session-id="recent-sonnet"]');
        if (recent) recent.remove();
        const filter = document.querySelector('.fb-session-menu-filter');
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      "document.querySelector('.fb-session-menu-filter-empty').hidden === false && document.querySelector('.fb-session-menu-filter-empty').textContent === 'No sessions use Sonnet 5.'",
    );
    const noMatchFilter = await evaluate(
      cdp,
      `(() => {
        const empty = document.querySelector('.fb-session-menu-filter-empty');
        return {
          text: empty.textContent,
          role: empty.getAttribute('role'),
          live: empty.getAttribute('aria-live'),
          hidden: empty.hidden,
        };
      })()`,
    );
    assert.deepEqual(noMatchFilter, {
      text: 'No sessions use Sonnet 5.',
      role: 'status',
      live: 'polite',
      hidden: false,
    });
    await evaluate(cdp, "document.querySelector('.fb-session-switch').click()");
    await waitFor(cdp, "!document.querySelector('.fb-session-menu')");
    await evaluate(cdp, "document.querySelector('.fb-session-switch').click()");
    await waitFor(
      cdp,
      "Boolean(document.querySelector('.fb-session-menu-filter')) && Boolean(document.querySelector('.fb-session-menu-item.recent'))",
    );
    await evaluate(
      cdp,
      `(() => {
        const filter = document.querySelector('.fb-session-menu-filter');
        filter.value = 'all';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      "document.querySelector('.fb-session-menu-filter').value === 'all' && document.querySelectorAll('.fb-session-menu-item[data-fb-session-id]:not([hidden])').length === 3",
    );
    fixture.sessionStatus.screenshot = 'stopped';
    await evaluate(
      cdp,
      "(() => { const stop = document.querySelector('.composer .composer-row .stop'); if (stop) stop.style.display = 'none'; return true; })()",
    );
    await waitFor(
      cdp,
      "document.querySelector('.fb-session-menu-item[data-fb-session-id=\\\"screenshot\\\"] .fb-session-menu-status').textContent === 'Stopped'",
    );
    const liveSessionStatus = await evaluate(
      cdp,
      `(() => ({
        status: document.querySelector('.fb-session-menu-item[data-fb-session-id="screenshot"] .fb-session-menu-status').textContent,
        className: document.querySelector('.fb-session-menu-item[data-fb-session-id="screenshot"] .fb-session-menu-status').className,
        aria: document.querySelector('.fb-session-menu-item[data-fb-session-id="screenshot"] .fb-session-menu-status').getAttribute('aria-label'),
      }))()`,
    );
    assert.deepEqual(liveSessionStatus, {
      status: 'Stopped',
      className: 'fb-session-menu-status stopped',
      aria: 'Session status: Stopped',
    });

    await evaluate(cdp, "document.querySelector('.fb-session-menu-select').click()");
    await waitFor(cdp, "!document.querySelector('.fb-session-menu')");
    await waitFor(
      cdp,
      "Boolean(document.querySelector('.fb-mobile-live-region')) && document.querySelector('.fb-mobile-live-region').textContent.includes('Selected session')",
    );
    const selectedStatus = await evaluate(
      cdp,
      `(() => ({
        text: document.querySelector('.fb-mobile-live-region').textContent,
        role: document.querySelector('.fb-mobile-live-region').getAttribute('role'),
        live: document.querySelector('.fb-mobile-live-region').getAttribute('aria-live'),
        atomic: document.querySelector('.fb-mobile-live-region').getAttribute('aria-atomic'),
      }))()`,
    );
    assert.equal(selectedStatus.text, 'Selected session: “Mobile screenshot review”.');
    assert.equal(selectedStatus.role, 'status');
    assert.equal(selectedStatus.live, 'polite');
    assert.equal(selectedStatus.atomic, 'true');
    const selectedAx = await accessibilityNodes(cdp);
    assert.ok(
      hasAccessibleStatus(
        selectedAx,
        'Selected session: “Mobile screenshot review”.',
      ),
      `selected-session announcement missing from Chromium accessibility tree: ${JSON.stringify(selectedAx.filter((node) => node.role === 'status'))}`,
    );

    await evaluate(cdp, "document.querySelector('.fb-session-switch').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-menu-close'))");
    await evaluate(
      cdp,
      "document.querySelector('.fb-session-menu-close').focus(); document.querySelector('.fb-session-menu-close').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    const confirmation = await evaluate(
      cdp,
      `(() => ({
        title: document.querySelector('.fb-session-close-title').textContent,
        yes: document.querySelector('.fb-session-close-yes').textContent,
        no: document.querySelector('.fb-session-close-no').textContent,
        yesColor: getComputedStyle(
          document.querySelector('.fb-session-close-yes'),
        ).backgroundColor,
        noColor: getComputedStyle(
          document.querySelector('.fb-session-close-no'),
        ).backgroundColor,
        announcement: document.querySelector('.fb-session-close-announcement').textContent,
        announcementRole: document.querySelector('.fb-session-close-announcement').getAttribute('role'),
        announcementLive: document.querySelector('.fb-session-close-announcement').getAttribute('aria-live'),
        announcementAtomic: document.querySelector('.fb-session-close-announcement').getAttribute('aria-atomic'),
        announcementVisible: (() => {
          const element = document.querySelector('.fb-session-close-announcement');
          const box = element.getBoundingClientRect();
          return getComputedStyle(element).display !== 'none' && box.width > 0 && box.height > 0;
        })(),
      }))()`,
    );
    assert.equal(confirmation.title, 'Close session?');
    assert.equal(confirmation.yes, 'Yes');
    assert.equal(confirmation.no, 'No');
    assert.equal(
      confirmation.announcement,
      'Confirmation required for “Mobile screenshot review”. Choose Yes to close session or No to keep it open.',
    );
    assert.equal(confirmation.announcementRole, 'status');
    assert.equal(confirmation.announcementLive, 'assertive');
    assert.equal(confirmation.announcementAtomic, 'true');
    assert.equal(confirmation.announcementVisible, true);
    assert.ok(
      hasAccessibleStatus(
        await accessibilityNodes(cdp),
        'Confirmation required for “Mobile screenshot review”.',
      ),
      'confirmation announcement missing from Chromium accessibility tree',
    );
    const yesColor = rgbChannels(confirmation.yesColor);
    const noColor = rgbChannels(confirmation.noColor);
    assert.ok(yesColor[0] > yesColor[1], `Yes button is not red: ${confirmation.yesColor}`);
    assert.ok(noColor[1] > noColor[0], `No button is not green: ${confirmation.noColor}`);

    const confirmScreenshot = await capture(
      cdp,
      path.join(outputDir, 'mobile-ui-session-close-confirm.png'),
    );
    assert.deepEqual(pngDimensions(confirmScreenshot), { width: 390, height: 844 });
    assert.ok(confirmScreenshot.length > 5000, 'confirmation screenshot is unexpectedly empty');

    await evaluate(
      cdp,
      "document.querySelector('.fb-session-close-confirm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))",
    );
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    const escapeCancelled = await evaluate(
      cdp,
      `(() => ({
        nativeCloseClicks: window.__nativeCloseClicks,
        menuStillOpen: Boolean(document.querySelector('.fb-session-menu')),
        focusClass: document.activeElement && document.activeElement.className,
        liveStatus: document.querySelector('.fb-mobile-live-region').textContent,
      }))()`,
    );
    assert.equal(escapeCancelled.nativeCloseClicks, 0);
    assert.equal(escapeCancelled.menuStillOpen, true);
    assert.equal(escapeCancelled.focusClass, 'fb-session-menu-close');
    assert.equal(escapeCancelled.liveStatus, 'Session “Mobile screenshot review” kept open.');
    assert.ok(
      hasAccessibleStatus(
        await accessibilityNodes(cdp),
        'Session “Mobile screenshot review” kept open.',
      ),
      'Escape outcome missing from Chromium accessibility tree',
    );

    await evaluate(
      cdp,
      "document.querySelector('.fb-session-menu-close').focus(); document.querySelector('.fb-session-menu-close').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    await evaluate(cdp, 'history.back()');
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    const backCancelled = await evaluate(
      cdp,
      `(() => ({
        nativeCloseClicks: window.__nativeCloseClicks,
        menuStillOpen: Boolean(document.querySelector('.fb-session-menu')),
        focusClass: document.activeElement && document.activeElement.className,
        liveStatus: document.querySelector('.fb-mobile-live-region').textContent,
      }))()`,
    );
    assert.equal(backCancelled.nativeCloseClicks, 0);
    assert.equal(backCancelled.menuStillOpen, true);
    assert.equal(backCancelled.focusClass, 'fb-session-menu-close');
    assert.equal(backCancelled.liveStatus, 'Session “Mobile screenshot review” kept open.');

    await evaluate(
      cdp,
      "document.querySelector('.fb-session-menu-close').focus(); document.querySelector('.fb-session-menu-close').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    await evaluate(
      cdp,
      "document.querySelector('.fb-session-close-confirm').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))",
    );
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    const backdropCancelled = await evaluate(
      cdp,
      `(() => ({
        nativeCloseClicks: window.__nativeCloseClicks,
        menuStillOpen: Boolean(document.querySelector('.fb-session-menu')),
        focusClass: document.activeElement && document.activeElement.className,
        liveStatus: document.querySelector('.fb-mobile-live-region').textContent,
      }))()`,
    );
    assert.equal(backdropCancelled.nativeCloseClicks, 0);
    assert.equal(backdropCancelled.menuStillOpen, true);
    assert.equal(backdropCancelled.focusClass, 'fb-session-menu-close');
    assert.equal(backdropCancelled.liveStatus, 'Session “Mobile screenshot review” kept open.');

    await evaluate(
      cdp,
      "document.querySelector('.fb-session-menu-close').focus(); document.querySelector('.fb-session-menu-close').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    await evaluate(cdp, "document.querySelector('.fb-session-close-no').click()");
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    const cancelled = await evaluate(
      cdp,
      `(() => ({
        nativeCloseClicks: window.__nativeCloseClicks,
        menuStillOpen: Boolean(document.querySelector('.fb-session-menu')),
        focusClass: document.activeElement && document.activeElement.className,
        liveStatus: document.querySelector('.fb-mobile-live-region').textContent,
      }))()`,
    );
    assert.equal(cancelled.nativeCloseClicks, 0);
    assert.equal(cancelled.menuStillOpen, true);
    assert.equal(cancelled.focusClass, 'fb-session-menu-close');
    assert.equal(cancelled.liveStatus, 'Session “Mobile screenshot review” kept open.');

    await evaluate(
      cdp,
      "document.querySelector('.fb-session-menu-close').focus(); document.querySelector('.fb-session-menu-close').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    await evaluate(cdp, "document.querySelector('.fb-session-close-yes').click()");
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    const accepted = await evaluate(
      cdp,
      `(() => ({
        nativeCloseClicks: window.__nativeCloseClicks,
        menuStillOpen: Boolean(document.querySelector('.fb-session-menu')),
        liveStatus: document.querySelector('.fb-mobile-live-region').textContent,
      }))()`,
    );
    assert.equal(accepted.nativeCloseClicks, 1);
    assert.equal(accepted.menuStillOpen, false);
    assert.equal(accepted.liveStatus, 'Session “Mobile screenshot review” closed.');
    assert.ok(
      hasAccessibleStatus(
        await accessibilityNodes(cdp),
        'Session “Mobile screenshot review” closed.',
      ),
      'close outcome missing from Chromium accessibility tree',
    );

    await evaluate(cdp, "document.querySelector('.tab.active').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.fb-tab-menu'))");
    await evaluate(
      cdp,
      "document.querySelector('.fb-tab-menu-item.danger').click()",
    );
    await waitFor(cdp, "Boolean(document.querySelector('.fb-session-close-confirm'))");
    await evaluate(cdp, "document.querySelector('.fb-session-close-no').click()");
    await waitFor(cdp, "!document.querySelector('.fb-session-close-confirm')");
    assert.equal(
      await evaluate(cdp, "Boolean(document.querySelector('.fb-tab-menu'))"),
      true,
    );

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 800,
    });
    await delay(180);
    const desktop = await evaluate(
      cdp,
      `(() => ({
        controlsHidden: Array.from(document.querySelectorAll(
          '.fb-session-switch, .fb-ctx-fab, .fb-composer-pills',
        )).every((el) => getComputedStyle(el).display === 'none'),
        taskPosition: getComputedStyle(
          document.querySelector('.thread-bottom .todo-dock'),
        ).position,
      }))()`,
    );
    assert.equal(desktop.controlsHidden, true);
    assert.notEqual(desktop.taskPosition, 'fixed');
  } finally {
    await closeChrome(browser);
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
