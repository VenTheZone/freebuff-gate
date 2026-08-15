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
      response.end(JSON.stringify({ projects: [] }));
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
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
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
