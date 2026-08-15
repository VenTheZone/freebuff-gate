'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRelayServer } = require('./mobile-connect-relay');

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (event) => { cleanup(); reject(event.error || new Error('WebSocket connection failed')); };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });
}

function messageQueue(socket) {
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', (event) => {
    let value = event.data;
    try { value = JSON.parse(value); } catch {}
    const waiter = waiters.find((entry) => entry.predicate(value));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      messages.push(value);
    }
  });
  return {
    waitFor(predicate, timeoutMs = 2000) {
      const existing = messages.find(predicate);
      if (existing !== undefined) {
        messages.splice(messages.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

async function startRelay() {
  const server = createRelayServer({
    stateFile: null,
    connectorToken: 'connector-secret',
    adminToken: 'admin-secret',
    publicHttpUrl: 'http://127.0.0.1',
    publicWsUrl: 'ws://127.0.0.1',
    appUrl: 'http://127.0.0.1/pair',
    uiUrl: 'http://127.0.0.1',
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  };
}

test('relay enrollment issues short-lived connector credentials and refreshes them', async () => {
  const relay = createRelayServer({
    stateFile: null,
    connectorStateFile: null,
    enrollmentToken: 'bootstrap-secret',
    publicHttpUrl: 'http://127.0.0.1',
    publicWsUrl: 'ws://127.0.0.1',
  });
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${relay.address().port}`;
  try {
    const enrolled = await jsonRequest(`${baseUrl}/v1/relay/enroll`, {
      method: 'POST',
      headers: { authorization: 'Bearer bootstrap-secret' },
      body: JSON.stringify({ connectorId: 'provisioned-desktop' }),
    });
    assert.equal(enrolled.response.status, 201);
    assert.equal(enrolled.body.connectorId, 'provisioned-desktop');
    assert.ok(enrolled.body.connectorToken);
    assert.ok(enrolled.body.connectorRefreshToken);
    assert.ok(enrolled.body.connectorTokenExpiresAt);

    const denied = await jsonRequest(`${baseUrl}/v1/relay/enroll`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ connectorId: 'denied-desktop' }),
    });
    assert.equal(denied.response.status, 401);

    const refreshed = await jsonRequest(`${baseUrl}/v1/relay/refresh`, {
      method: 'POST',
      body: JSON.stringify({
        connectorId: enrolled.body.connectorId,
        connectorRefreshToken: enrolled.body.connectorRefreshToken,
      }),
    });
    assert.equal(refreshed.response.status, 200);
    assert.notEqual(refreshed.body.connectorToken, enrolled.body.connectorToken);
    assert.equal(refreshed.body.connectorId, enrolled.body.connectorId);
    assert.equal(relay.hub.authenticateConnectorToken(enrolled.body.connectorToken), null);
    assert.equal(relay.hub.authenticateConnectorToken(refreshed.body.connectorToken).connectorId, 'provisioned-desktop');
  } finally {
    relay.hub.close();
    await new Promise((resolve) => relay.close(resolve));
  }
});

async function pairAndConnect(relay) {
  const desktop = new WebSocket(`${relay.wsUrl}/v1/relay/desktop`, [
    'freebuff-relay-v1',
    'auth-connector-secret',
  ]);
  const desktopMessages = messageQueue(desktop);
  await waitForOpen(desktop);
  desktop.send(JSON.stringify({ type: 'connector.register', connectorId: 'desktop-test' }));
  await desktopMessages.waitFor((message) => message.type === 'connector.ready');

  const started = await jsonRequest(`${relay.baseUrl}/v1/pairings`, {
    method: 'POST',
    headers: { authorization: 'Bearer connector-secret' },
    body: JSON.stringify({
      connectorId: 'desktop-test',
      appUrl: `${relay.baseUrl}/pair`,
      relayUrl: relay.wsUrl,
      uiUrl: relay.baseUrl,
      ttlSeconds: 60,
    }),
  });
  assert.equal(started.response.status, 201);
  const pairingUrl = new URL(started.body.pairingUrl);
  const qr = new URLSearchParams(pairingUrl.hash.slice(1));

  const claim = await jsonRequest(`${relay.baseUrl}/v1/pairings/claim`, {
    method: 'POST',
    body: JSON.stringify({
      pairingId: qr.get('pairingId'),
      token: qr.get('token'),
      deviceName: 'Relay test phone',
      devicePublicKey: 'ed25519:relay-test',
    }),
  });
  assert.equal(claim.response.status, 200);

  return { desktop, desktopMessages, claim: claim.body };
}

test('managed relay exchanges access token for HttpOnly cookie and streams HTTP responses', async () => {
  const relay = await startRelay();
  try {
    const { desktop, desktopMessages, claim } = await pairAndConnect(relay);
    const session = await fetch(`${relay.baseUrl}/v1/mobile/session`, {
      headers: { authorization: `Bearer ${claim.accessToken}` },
    });
    assert.equal(session.status, 200);
    const cookieHeader = session.headers.get('set-cookie');
    assert.match(cookieHeader, /__Host-freebuff_session=/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /SameSite=Strict/);
    const cookie = cookieHeader.split(';', 1)[0];

    const unauthenticated = await fetch(`${relay.baseUrl}/chat`);
    assert.equal(unauthenticated.status, 401);

    const responsePromise = fetch(`${relay.baseUrl}/chat?stream=1`, {
      headers: { cookie },
    });
    const request = await desktopMessages.waitFor((message) => message.type === 'http.request');
    assert.equal(request.path, '/chat?stream=1');
    assert.equal(request.headers.cookie, undefined);

    desktop.send(JSON.stringify({
      type: 'http.response.start',
      id: request.id,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const response = await responsePromise;
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    desktop.send(JSON.stringify({
      type: 'http.response.chunk',
      id: request.id,
      dataBase64: Buffer.from('data: first\n\n').toString('base64'),
    }));
    desktop.send(JSON.stringify({
      type: 'http.response.chunk',
      id: request.id,
      dataBase64: Buffer.from('data: second\n\n').toString('base64'),
    }));
    desktop.send(JSON.stringify({ type: 'http.response.end', id: request.id }));
    const chunks = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'data: first\n\ndata: second\n\n');
    desktop.close();
  } finally {
    relay.server.hub.close();
    await new Promise((resolve) => relay.server.close(resolve));
  }
});

test('managed relay bridges browser WebSocket frames to desktop connector', async () => {
  const relay = await startRelay();
  try {
    const { desktop, desktopMessages, claim } = await pairAndConnect(relay);
    const session = await fetch(`${relay.baseUrl}/v1/mobile/session`, {
      headers: { authorization: `Bearer ${claim.accessToken}` },
    });
    const cookie = session.headers.get('set-cookie').split(';', 1)[0];

    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const mobile = new WebSocket(`${relay.wsUrl}/v1/mobile/socket`, [
      'freebuff-mobile-v1',
      `session-${sessionToken}`,
    ]);
    await waitForOpen(mobile);
    const open = await desktopMessages.waitFor((message) => message.type === 'ws.open');
    assert.equal(open.path, '/v1/mobile/socket');
    desktop.send(JSON.stringify({ type: 'ws.ready', id: open.id }));

    mobile.send('hello relay');
    const inbound = await desktopMessages.waitFor((message) => message.type === 'ws.message');
    assert.equal(Buffer.from(inbound.dataBase64, 'base64').toString('utf8'), 'hello relay');
    assert.equal(inbound.binary, false);

    desktop.send(JSON.stringify({
      type: 'ws.message',
      id: open.id,
      binary: false,
      dataBase64: Buffer.from('hello phone').toString('base64'),
    }));
    const outbound = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for mobile frame')), 2000);
      mobile.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(event.data);
      }, { once: true });
    });
    assert.equal(outbound, 'hello phone');
    mobile.close();
    desktop.close();
  } finally {
    relay.server.hub.close();
    await new Promise((resolve) => relay.server.close(resolve));
  }
});
