'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createSetupController, createWizardServer } = require('./freebuff-setup-wizard');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('setup wizard serves state and protects state-changing actions with a session nonce', async () => {
  const calls = [];
  const controller = {
    state: { phase: 'ready', message: 'Ready' },
    async refresh() {
      calls.push('refresh');
      return this.state;
    },
    async run(action) {
      calls.push(action);
      this.state = { phase: 'ready', message: `Applied ${action}` };
      return this.state;
    },
  };
  const server = createWizardServer({ controller });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Freebuff Setup/);
    const nonce = html.match(/data-session-nonce="([^"]+)"/)?.[1];
    assert.match(nonce, /^[A-Za-z0-9_-]{20,}$/);

    const state = await fetch(`${base}/api/state`);
    assert.deepEqual(await state.json(), controller.state);

    const denied = await fetch(`${base}/api/refresh`, { method: 'POST' });
    assert.equal(denied.status, 403);

    const refreshed = await fetch(`${base}/api/refresh`, {
      method: 'POST',
      headers: { 'x-freebuff-setup-nonce': nonce },
    });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), controller.state);

    const action = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-freebuff-setup-nonce': nonce,
      },
      body: JSON.stringify({ action: 'upgrade' }),
    });
    assert.equal(action.status, 200);
    assert.deepEqual(await action.json(), controller.state);
    assert.deepEqual(calls, ['refresh', 'upgrade']);
  } finally {
    await close(server);
  }
});

test('setup wizard rejects unknown routes and malformed actions', async () => {
  const server = createWizardServer({
    controller: {
      state: { phase: 'ready' },
      async refresh() { return this.state; },
      async run() { throw new Error('should not run'); },
    },
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    const html = await (await fetch(`${base}/`)).text();
    const nonce = html.match(/data-session-nonce="([^"]+)"/)?.[1];
    const malformed = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'x-freebuff-setup-nonce': nonce, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await close(server);
  }
});

test('setup wizard exposes nonce-protected close action', async () => {
  let closed = false;
  const server = createWizardServer({
    onClose: () => { closed = true; },
    controller: {
      state: { phase: 'ready' },
      async refresh() { return this.state; },
      async run() { return this.state; },
    },
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    const nonce = html.match(/data-session-nonce="([^"]+)"/)?.[1];
    const response = await fetch(`${base}/api/close`, {
      method: 'POST',
      headers: { 'x-freebuff-setup-nonce': nonce },
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, true);
  } finally {
    await close(server);
  }
});

test('setup controller maps real inspection and action seams into retryable wizard states', async () => {
  let fixed = false;
  const applied = [];
  const controller = createSetupController({
    async inspect() {
      return {
        report: { desktopDir: '/fake/desktop' },
        actions: fixed ? [] : [{ id: 'upgrade', description: 'Apply setup' }],
      };
    },
    async execute(action) {
      applied.push(action.id);
      fixed = true;
    },
  });

  assert.deepEqual(controller.getState(), { phase: 'idle', message: 'Waiting to inspect this Desktop.' });
  assert.equal((await controller.refresh()).phase, 'action-needed');
  assert.deepEqual(controller.getState().actions, [{ id: 'upgrade', description: 'Apply setup' }]);
  assert.equal((await controller.run('upgrade')).phase, 'ready');
  assert.deepEqual(applied, ['upgrade']);
  await assert.rejects(() => controller.run('unknown'), /unknown setup action/);
});

test('setup controller preserves explicit states such as missing Desktop', async () => {
  const controller = createSetupController({
    async inspect() {
      return { phase: 'desktop-missing', message: 'Freebuff Desktop not found', report: {}, actions: [] };
    },
    async execute() {},
  });
  const state = await controller.refresh();
  assert.deepEqual(state, {
    phase: 'desktop-missing',
    message: 'Freebuff Desktop not found',
    report: {},
    actions: [],
  });
});
