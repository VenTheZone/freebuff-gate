'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  claimPairing,
  createPairing,
  fetchSessionCookie,
  hasWebSocket,
  startAgent,
  startRelay,
} = require('./mobile-connect-live-fixture');

function createUpstreamServer() {
  return http.createServer((req, res) => {
    if (req.url === '/api/projects') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"projects":[{"path":"/fixture"}]}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

test('live fixture walks the real CLI pairing + routing path end-to-end', async (t) => {
  if (!hasWebSocket()) {
    t.skip('needs Node 22 (global WebSocket) for the agent CLI');
    return;
  }

  const upstream = createUpstreamServer();
  await listen(upstream);
  const relay = await startRelay({});
  const agent = await startAgent({ relay, connectorId: 'fixture-e2e-connector', upstream: `http://127.0.0.1:${upstream.address().port}` });
  t.after(async () => {
    await agent.stop();
    await relay.stop();
    await new Promise((resolve) => upstream.close(resolve));
  });

  await agent.waitRegistered();

  const pairing = await createPairing({ relay, connectorId: agent.connectorId, ttlSeconds: 120 });
  assert.ok(pairing.pairingId, 'pairing carries an id');
  assert.ok(pairing.pairingToken, 'pairing carries the one-use token');
  assert.ok(pairing.expiresAt, 'pairing carries an expiry');

  const claim = await claimPairing(relay.baseUrl, pairing, { deviceName: 'Fixture e2e phone' });
  assert.ok(claim.deviceId, 'claim issues a device id');
  assert.ok(claim.accessToken, 'claim issues an access token');

  const { value: cookie, raw: rawSetCookie } = await fetchSessionCookie(relay.baseUrl, claim.accessToken);
  assert.match(cookie, /^__Host-freebuff_session=/, 'cookie is the HttpOnly session cookie');
  assert.match(rawSetCookie, /HttpOnly/, 'cookie is HttpOnly');

  const routed = await fetch(`${relay.baseUrl}/api/projects`, { headers: { cookie } });
  assert.equal(routed.status, 200);
  assert.equal(await routed.text(), '{"projects":[{"path":"/fixture"}]}', 'body comes from the configured upstream');

  const second = await fetch(`${relay.baseUrl}/api/projects`, { headers: { cookie } });
  assert.equal(second.status, 200, 'renew-on-use keeps the session alive');

  const rejected = await fetch(`${relay.baseUrl}/api/projects`);
  assert.equal(rejected.status, 401, 'unauthenticated requests are rejected');
});
