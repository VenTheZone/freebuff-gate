'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RelayAgent } = require('./mobile-connect-agent');
const { createRelayServer } = require('./mobile-connect-relay');
const { acceptUpgrade } = require('./mobile-connect-websocket');

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

function waitForMessage(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), timeoutMs);
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      resolve(event.data);
    }, { once: true });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
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

async function waitUntil(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for relay connector');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('desktop relay agent refreshes provisioned connector token before connecting', async () => {
  const relay = createRelayServer({
    stateFile: null,
    connectorStateFile: null,
    enrollmentToken: 'bootstrap-secret',
    publicHttpUrl: 'http://127.0.0.1',
    publicWsUrl: 'ws://127.0.0.1',
  });
  const relayPort = await listen(relay);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-agent-refresh-'));
  const credentialFile = path.join(stateDir, 'connector.json');
  const stateFile = path.join(stateDir, 'agent.json');
  const issued = relay.hub.enrollConnector('refresh-agent');
  fs.writeFileSync(credentialFile, `${JSON.stringify({
    connectorId: issued.connectorId,
    connectorToken: issued.connectorToken,
    connectorRefreshToken: issued.connectorRefreshToken,
    connectorTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    connectorRefreshTokenExpiresAt: issued.connectorRefreshTokenExpiresAt,
  })}\n`);
  const agent = new RelayAgent({
    stateFile,
    connectorCredentialFile: credentialFile,
    relayHttpUrl: `http://127.0.0.1:${relayPort}`,
    relayWsUrl: `ws://127.0.0.1:${relayPort}`,
    upstreamUrl: 'http://127.0.0.1:58061',
    connectorId: issued.connectorId,
  });

  try {
    agent.start();
    await waitUntil(() => relay.hub.connectors.has(issued.connectorId));
    const updated = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    assert.notEqual(updated.connectorToken, issued.connectorToken);
    assert.ok(Date.parse(updated.connectorTokenExpiresAt) > Date.now());
  } finally {
    agent.stop();
    relay.hub.close();
    await new Promise((resolve) => relay.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('desktop relay agent forwards HTTP streams and WebSocket frames', async () => {
  let upstreamSocketReady;
  const upstreamReady = new Promise((resolve) => { upstreamSocketReady = resolve; });
  const upstream = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from desktop');
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.end('data: last\n\n');
      }, 20);
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  upstream.on('upgrade', (req, socket, head) => {
    const connection = acceptUpgrade(req, socket, head);
    connection.on('message', (payload, binary) => {
      if (binary) connection.sendBinary(Buffer.from(payload));
      else connection.sendText(`echo:${payload}`);
    });
    upstreamSocketReady();
  });
  const upstreamPort = await listen(upstream);

  const relay = createRelayServer({
    stateFile: null,
    connectorToken: 'connector-secret',
    publicHttpUrl: 'http://127.0.0.1',
    publicWsUrl: 'ws://127.0.0.1',
  });
  const relayPort = await listen(relay);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-agent-'));
  const agent = new RelayAgent({
    stateFile: path.join(stateDir, 'agent.json'),
    connectorToken: 'connector-secret',
    relayHttpUrl: `http://127.0.0.1:${relayPort}`,
    relayWsUrl: `ws://127.0.0.1:${relayPort}`,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    connectorId: 'agent-test',
  });

  try {
    agent.start();
    await waitUntil(() => relay.hub.connectors.has('agent-test'));
    const pairing = await agent.createPairing({
      appUrl: `http://127.0.0.1:${relayPort}/pair`,
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      uiUrl: `http://127.0.0.1:${relayPort}`,
    });
    const pairingUrl = new URL(pairing.pairingUrl);
    const qr = new URLSearchParams(pairingUrl.hash.slice(1));
    const claim = await jsonRequest(`http://127.0.0.1:${relayPort}/v1/pairings/claim`, {
      method: 'POST',
      body: JSON.stringify({
        pairingId: qr.get('pairingId'),
        token: qr.get('token'),
        deviceName: 'Agent test phone',
        devicePublicKey: 'ed25519:agent-test',
      }),
    });
    assert.equal(claim.response.status, 200);

    const session = await fetch(`http://127.0.0.1:${relayPort}/v1/mobile/session`, {
      headers: { authorization: `Bearer ${claim.body.accessToken}` },
    });
    const cookie = session.headers.get('set-cookie').split(';', 1)[0];

    const hello = await fetch(`http://127.0.0.1:${relayPort}/hello`, { headers: { cookie } });
    assert.equal(hello.status, 200);
    assert.equal(await hello.text(), 'hello from desktop');

    const events = await fetch(`http://127.0.0.1:${relayPort}/events`, { headers: { cookie } });
    assert.equal(events.status, 200);
    assert.equal(await events.text(), 'data: first\n\ndata: last\n\n');

    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/mobile/socket`, [
      'freebuff-mobile-v1',
      `session-${sessionToken}`,
    ]);
    await waitForOpen(mobile);
    await upstreamReady;
    mobile.send('ping');
    assert.equal(await waitForMessage(mobile), 'echo:ping');
    mobile.close();
  } finally {
    agent.stop();
    relay.hub.close();
    await new Promise((resolve) => relay.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
