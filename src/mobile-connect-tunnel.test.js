'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { createRelayServer, RelayHub } = require('./mobile-connect-relay');
const {
  MAX_FRAME_BYTES,
  Spake2Session,
  TunnelAgent,
  TunnelPeer,
  decodeFrame,
  deriveKeys,
  encodeFrame,
  hexToBuffer,
  scalarFromToken,
} = require('./mobile-connect-tunnel');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startRelay() {
  const hub = new RelayHub({
    stateFile: null,
    connectorStateFile: null,
    connectorToken: 'relay-test-token',
    publicHttpUrl: 'http://127.0.0.1:1',
    publicWsUrl: 'ws://127.0.0.1:1',
  });
  const server = createRelayServer({ hub });
  const port = await listen(server);
  return { server, hub, port };
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world', query: req.headers['x-probe'] || null }));
      return;
    }
    if (req.method === 'POST' && req.url === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        res.write(`data: ${JSON.stringify({ n: count })}\n\n`);
        if (count === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 20);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return listen(server).then((port) => ({ server, port }));
}

// Phone-side simulation: mirrors the Kotlin LoopbackProxy. Its HTTP requests
// are serialized into tunnel messages and responses are streamed back.
class LoopbackBridge {
  constructor(peer) {
    this.peer = peer;
    this.pending = new Map();
    this.counter = 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.peer.onMessage = (message) => this.onTunnel(message);
  }

  async start() {
    this.port = await listen(this.server);
    return this.port;
  }

  handle(req, res) {
    const id = `p_${++this.counter}`;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      this.pending.set(id, { res, started: false });
      const flat = { 'h:x-probe': 'via-tunnel' };
      for (const [name, value] of Object.entries(req.headers)) {
        flat[`h:${name}`] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      this.peer.send({
        type: 'http.request',
        id,
        method: req.method,
        path: req.url,
        ...flat,
        bodyBase64: chunks.length ? Buffer.concat(chunks).toString('base64') : null,
      });
    });
  }

  onTunnel(message) {
    const entry = this.pending.get(String(message.id || ''));
    if (!entry) return;
    if (message.type === 'http.response.start') {
      entry.started = true;
      entry.res.writeHead(message.status, message.headers || {});
      entry.res.flushHeaders?.();
    } else if (message.type === 'http.response.chunk') {
      entry.res.write(Buffer.from(String(message.dataBase64 || ''), 'base64'));
    } else if (message.type === 'http.response.end') {
      this.pending.delete(String(message.id));
      if (!entry.started) entry.res.writeHead(204);
      entry.res.end();
    } else if (message.type === 'http.error') {
      this.pending.delete(String(message.id));
      if (!entry.res.headersSent) entry.res.writeHead(502);
      entry.res.end();
    }
  }

  close() {
    this.server.close();
  }
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor timed out'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

test('RFC 9382 P-256 vector derives exact messages, transcript, and confirmations', () => {
  const options = {
    identityA: 'server',
    identityB: 'client',
    w: hexToBuffer('2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f'),
  };
  const mobile = new Spake2Session({
    ...options,
    role: 'mobile',
    scalar: hexToBuffer('43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729'),
  });
  const agent = new Spake2Session({
    ...options,
    role: 'agent',
    scalar: hexToBuffer('dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be'),
  });

  assert.equal(
    mobile.message.toString('hex'),
    '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
  );
  assert.equal(
    agent.message.toString('hex'),
    '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
  );

  mobile.receivePeerMessage(agent.message);
  agent.receivePeerMessage(mobile.message);
  assert.equal(
    mobile.sharedPoint.toBytes(false).toString('hex'),
    '0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325',
  );
  assert.equal(mobile.transcriptHash.toString('hex'), '0e0672dc86f8e45565d338b0540abe6915bdf72e2b35b5c9e5663168e960a91b');
  assert.equal(mobile.ke.toString('hex'), '0e0672dc86f8e45565d338b0540abe69');
  assert.equal(mobile.ka.toString('hex'), '15bdf72e2b35b5c9e5663168e960a91b');
  assert.equal(mobile.confirmation.mac.toString('hex'), '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0');
  assert.equal(agent.confirmation.mac.toString('hex'), 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b');

  mobile.verifyPeerConfirmation(agent.confirmation);
  agent.verifyPeerConfirmation(mobile.confirmation);
  assert.equal(mobile.ready, true);
  assert.equal(agent.ready, true);
});

test('SPAKE2 matching token confirms, derives directional keys, and rejects wrong token', () => {
  assert.equal(
    scalarFromToken('same-token').toString(16).padStart(64, '0'),
    '986bcf7c77c81a7681aa1a97c021a762f0b479c4129dd002222e8146d29a9736',
  );
  const mobile = new Spake2Session({ role: 'mobile', token: 'same-token' });
  const agent = new Spake2Session({ role: 'agent', token: 'same-token' });
  mobile.receivePeerMessage(agent.message);
  agent.receivePeerMessage(mobile.message);
  mobile.verifyPeerConfirmation(agent.confirmation);
  agent.verifyPeerConfirmation(mobile.confirmation);

  const mobileKeys = mobile.tunnelKeys();
  const agentKeys = agent.tunnelKeys();
  assert.deepEqual(mobileKeys, agentKeys);
  assert.notDeepEqual(mobileKeys.mobileToAgent, mobileKeys.agentToMobile);

  const freshMobile = new Spake2Session({ role: 'mobile', token: 'same-token' });
  const wrong = new Spake2Session({ role: 'agent', token: 'wrong-token' });
  freshMobile.receivePeerMessage(wrong.message);
  wrong.receivePeerMessage(freshMobile.message);
  assert.throws(() => freshMobile.verifyPeerConfirmation(wrong.confirmation), /confirmation/i);
  assert.equal(freshMobile.ready, false);
});

test('AEAD framing authenticates header and rejects tampering, replay, and ordering errors', () => {
  const keys = deriveKeys(Buffer.alloc(16, 7), Buffer.alloc(32, 8));
  assert.equal(keys.mobileToAgent.toString('hex'), '0c2e48b50e246e8e889dd2be8e528cfd19476a2b77706ce85d0cf1c2e0c00363');
  assert.equal(keys.agentToMobile.toString('hex'), 'd6efc0765a9dc1a11a1df38bc4b6e2eb16aaae5457df783a3398713c41f97d80');
  const frame = encodeFrame(keys.mobileToAgent, 0n, { type: 'probe', body: 'hello' }, { nonce: Buffer.alloc(12, 9) });
  assert.deepEqual(decodeFrame(keys.mobileToAgent, frame, 0n).message, { type: 'probe', body: 'hello' });
  assert.throws(() => decodeFrame(keys.mobileToAgent, frame, 1n), /sequence|replay/i);
  const futureFrame = encodeFrame(keys.mobileToAgent, 2n, { type: 'future' }, { nonce: Buffer.alloc(12, 10) });
  assert.throws(() => decodeFrame(keys.mobileToAgent, futureFrame, 1n), /sequence|order/i);

  for (const index of [0, 4, 12, frame.length - 1]) {
    const tampered = Buffer.from(frame);
    tampered[index] ^= 1;
    assert.throws(() => decodeFrame(keys.mobileToAgent, tampered, 0n), /frame|auth|length|sequence/i);
  }

  const oversized = Buffer.alloc(MAX_FRAME_BYTES + 1);
  oversized.writeUInt32BE(MAX_FRAME_BYTES, 0);
  assert.throws(() => decodeFrame(keys.mobileToAgent, oversized, 0n), /size|length/i);
});

test('full loop: phone proxy -> SPAKE2 tunnel -> blind relay -> agent -> upstream', async (t) => {
  const relay = await startRelay();
  const upstream = await startUpstream();
  t.after(() => {
    relay.server.close();
    upstream.server.close();
  });

  const sessionId = 'sess-full';
  const token = 'rendezvous-token';
  const agent = new TunnelAgent({
    relayWsUrl: `ws://127.0.0.1:${relay.port}`,
    sessionId,
    token,
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
  });
  agent.start();
  t.after(() => agent.stop());

  const phone = new TunnelPeer({
    url: `ws://127.0.0.1:${relay.port}/v1/tunnel?session=${sessionId}`,
    token,
    role: 'mobile',
  });
  const bridge = new LoopbackBridge(phone);
  const proxyPort = await bridge.start();
  t.after(() => bridge.close());
  const phoneReady = new Promise((resolve) => { phone.onReady = resolve; });
  phone.start();

  await phoneReady;
  await waitFor(() => agent.peer && agent.peer.ready);

  const hello = await getJson(`http://127.0.0.1:${proxyPort}/hello`);
  assert.equal(hello.status, 200);
  assert.equal(hello.body.hello, 'world');
  assert.equal(hello.body.query, 'via-tunnel');

  const echo = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ ping: 'pong' });
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/echo',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.body, { echoed: JSON.stringify({ ping: 'pong' }) });

  const events = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/events`, (res) => {
      assert.equal(res.statusCode, 200);
      let text = '';
      res.on('data', (chunk) => {
        text += chunk.toString('utf8');
        assert.equal(text.includes('data:'), true);
      });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
  const dataLines = events.split('\n').filter((line) => line.startsWith('data: '));
  assert.equal(dataLines.length, 3);
});

test('wrong rendezvous token is rejected before ready', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.server.close());
  const sessionId = 'sess-bad-token';
  const agent = new TunnelAgent({
    relayWsUrl: `ws://127.0.0.1:${relay.port}`,
    sessionId,
    token: 'correct-token',
    upstreamUrl: 'http://127.0.0.1:1',
  });
  agent.start();
  t.after(() => agent.stop());

  let ready = false;
  let closed = false;
  const phone = new TunnelPeer({
    url: `ws://127.0.0.1:${relay.port}/v1/tunnel?session=${sessionId}`,
    token: 'wrong-token',
    role: 'mobile',
    onReady: () => { ready = true; },
    onClose: () => { closed = true; },
  });
  phone.start();

  await waitFor(() => closed);
  assert.equal(ready, false);
  assert.equal(phone.ready, false);
});

test('relay rendezvous pipes opaque bytes and rejects a third peer', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.server.close());
  const sessionId = 'sess-pipe';
  const received = [];
  const a = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/tunnel?session=${sessionId}`);
  a.addEventListener('message', async (event) => {
    received.push(typeof event.data === 'string' ? event.data : await event.data.text());
  });
  const b = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/tunnel?session=${sessionId}`);
  await Promise.all([
    new Promise((resolve) => a.addEventListener('open', resolve)),
    new Promise((resolve) => b.addEventListener('open', resolve)),
  ]);

  b.send('opaque-bytes');
  await waitFor(() => received.length === 1);
  assert.equal(received[0], 'opaque-bytes');

  const c = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/tunnel?session=${sessionId}`);
  const code = await new Promise((resolve) => c.addEventListener('close', (event) => resolve(event.code)));
  assert.equal(code, 4001);
  a.close();
  b.close();
});
