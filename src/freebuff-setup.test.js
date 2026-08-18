'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLiveSetupController, parseBinaryArgs, startWizard } = require('./freebuff-setup');
const { runAgent } = require('./freebuff-setup-sea-entry');

test('binary entry separates launcher flags from existing setup options', () => {
  assert.deepEqual(parseBinaryArgs(['--no-browser', '--advanced', '--dry-run', '--source-dir', '/tmp/src']), {
    advanced: true,
    noBrowser: true,
    setupArgs: ['--dry-run', '--source-dir', '/tmp/src'],
  });
  assert.deepEqual(parseBinaryArgs(['--version']), {
    advanced: false,
    noBrowser: false,
    version: true,
    setupArgs: [],
  });
});

test('startWizard binds loopback server and opens browser with local URL', async () => {
  const opened = [];
  const app = await startWizard({
    controller: {
      state: { phase: 'ready', message: 'Ready' },
      async refresh() { return this.state; },
      async run() { return this.state; },
    },
    openBrowser: (url) => opened.push(url),
  });
  try {
    assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(opened[0]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Freebuff Setup/);
  } finally {
    await app.close();
  }
});

test('SEA agent mode runs installed wrapper with service arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-setup-agent-mode-'));
  const marker = path.join(root, 'args.json');
  const wrapper = path.join(root, 'wrapper.js');
  try {
    fs.writeFileSync(wrapper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv));\n`);
    const before = process.argv;
    assert.equal(runAgent(wrapper, ['serve']), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).slice(-1), ['serve']);
    assert.equal(process.argv, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live wizard reports hosted relay unavailable until advanced mode is selected', async () => {
  const controller = createLiveSetupController({
    sourceDir: path.resolve(__dirname),
    platform: 'darwin',
    env: {},
  }, {
    resolveLocalStack() {
      return {
        sourceDir: path.resolve(__dirname),
        installerPath: path.join(__dirname, 'install-mobile-connect.js'),
      };
    },
    async collectState() {
      return {
        verify: { ok: true, errors: [], warnings: [] },
        ports: { desktopPort: 58060, proxyPort: 58061 },
        proxy: { reachable: true, checks: [] },
        forward: { known: false, up: false, detail: null },
      };
    },
    planActions() { return []; },
  });
  const unavailable = await controller.refresh();
  assert.equal(unavailable.phase, 'hosted-unavailable');
  assert.equal(unavailable.hosted.status, 'unavailable');
  assert.deepEqual(unavailable.actions, [{ id: 'advanced', description: 'Use advanced local setup' }]);
  const advanced = await controller.run('advanced');
  assert.equal(advanced.phase, 'ready');
  assert.equal(advanced.hosted.status, 'advanced');
});
