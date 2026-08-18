'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PairingStore,
  createGatewayServer,
} = require('./mobile-connect-gateway');

function tempStateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-mobile-'));
  return {
    directory,
    file: path.join(directory, 'mobile-connect.json'),
  };
}

async function withServer(callback, options = {}) {
  const server = createGatewayServer({
    stateFile: null,
    appUrl: 'https://mobile.example.test/pair',
    relayUrl: 'wss://relay.example.test',
    uiUrl: 'https://ui.example.test',
    adminToken: 'admin-secret',
    ...options,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ baseUrl, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return {
    response,
    body: await response.json(),
  };
}

test('PairingStore keeps raw pairing secrets out of persisted state and rejects replay', () => {
  const { directory, file } = tempStateFile();
  try {
    const store = new PairingStore({
      stateFile: file,
      appUrl: 'https://mobile.example.test/pair',
      relayUrl: 'wss://relay.example.test',
      uiUrl: 'https://ui.example.test',
    });
    const pairing = store.startPairing();
    const persisted = fs.readFileSync(file, 'utf8');
    const qr = new URL(pairing.pairingUrl);
    const qrData = new URLSearchParams(qr.hash.slice(1));

    assert.match(pairing.pairingUrl, /^https:\/\/mobile\.example\.test\/pair#/);
    assert.equal(pairing.pairingUrl.includes('?token='), false);
    assert.equal(persisted.includes(qrData.get('token')), false);
    const result = store.claim({
      pairingId: qrData.get('pairingId'),
      token: qrData.get('token'),
      deviceName: 'Test phone',
      devicePublicKey: 'ed25519:test-public-key',
    });
    assert.match(result.deviceId, /^d_/);
    assert.ok(result.deviceToken);
    assert.ok(result.accessToken);
    assert.equal(store.listDevices()[0].name, 'Test phone');

    assert.throws(
      () => store.claim({
        pairingId: qrData.get('pairingId'),
        token: qrData.get('token'),
        devicePublicKey: 'ed25519:replay',
      }),
      (error) => error.code === 'pairing_not_found' && error.status === 404,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PairingStore expires pending requests and supports refresh/revoke', () => {
  let current = 1_700_000_000_000;
  const store = new PairingStore({
    stateFile: null,
    now: () => current,
    appUrl: 'https://mobile.example.test/pair',
  });
  const pairing = store.startPairing({ ttlMs: 1000 });
  current += 1001;    assert.throws(
      () => store.claim({
        pairingId: pairing.pairingId,
        token: new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get('token'),
        devicePublicKey: 'ed25519:expired',
      }),
    (error) => error.code === 'pairing_not_found' && error.status === 404,
  );

  current = 1_700_000_000_000;
  const livePairing = store.startPairing();
  const liveQrData = new URLSearchParams(new URL(livePairing.pairingUrl).hash.slice(1));
  const claimed = store.claim({
    pairingId: liveQrData.get('pairingId'),
    token: liveQrData.get('token'),
    devicePublicKey: 'ed25519:live',
  });
  const refreshed = store.refresh({
    deviceId: claimed.deviceId,
    deviceToken: claimed.deviceToken,
  });
  assert.notEqual(refreshed.accessToken, claimed.accessToken);
  assert.throws(
    () => store.revoke(claimed.deviceId) && store.refresh({
      deviceId: claimed.deviceId,
      deviceToken: claimed.deviceToken,
    }),
    (error) => error.code === 'device_not_authorized' && error.status === 401,
  );
});

test('PairingStore keeps the rotated-away access token valid until its original expiry (refresh/establish race)', () => {
  let current = 1_700_000_000_000;
  const store = new PairingStore({
    stateFile: null,
    now: () => current,
    appUrl: 'https://mobile.example.test/pair',
  });
  const pairing = store.startPairing();
  const qr = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1));
  const claimed = store.claim({
    pairingId: qr.get('pairingId'),
    token: qr.get('token'),
    devicePublicKey: 'ed25519:race',
  });

  // A refresh rotates the access token (the launch-time double-refresh race
  // that left the web-session establish holding the pre-rotation token).
  const refreshed = store.refresh({
    deviceId: claimed.deviceId,
    deviceToken: claimed.deviceToken,
  });
  assert.notEqual(refreshed.accessToken, claimed.accessToken, 'refresh rotates the token');

  // The NEW token authenticates…
  assert.equal(store.authenticateAccess({ accessToken: refreshed.accessToken }).id, claimed.deviceId);
  // …and the OLD token still does within its grace window: an establish that
  // raced this refresh must not get a spurious 401 "Access token is invalid
  // or expired".
  assert.equal(store.authenticateAccess({ accessToken: claimed.accessToken }).id, claimed.deviceId);
  assert.throws(
    () => store.authenticateAccess({ accessToken: 'not-a-real-token' }),
    (error) => error.code === 'access_not_authorized' && error.status === 401,
  );

  // A second refresh keeps the newest rotated-away token as the grace
  // candidate: the token from the FIRST refresh still authenticates.
  const refreshed2 = store.refresh({
    deviceId: claimed.deviceId,
    deviceToken: claimed.deviceToken,
  });
  assert.equal(store.authenticateAccess({ accessToken: refreshed.accessToken }).id, claimed.deviceId);
  assert.equal(store.authenticateAccess({ accessToken: refreshed2.accessToken }).id, claimed.deviceId);

  // Once the original expiry passes, the first token is rejected.
  current += 15 * 60 * 1000 + 1;
  assert.throws(
    () => store.authenticateAccess({ accessToken: claimed.accessToken }),
    (error) => error.code === 'access_not_authorized' && error.status === 401,
  );
});

test('HTTP gateway exposes pairing, refresh, list, and revoke flows', async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = { authorization: 'Bearer admin-secret' };
    const started = await jsonRequest(`${baseUrl}/v1/pairings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    assert.equal(started.response.status, 201);

    const claim = await jsonRequest(`${baseUrl}/v1/pairings/claim`, {
      method: 'POST',
      body: JSON.stringify({
        pairingId: started.body.pairingId,
        token: new URLSearchParams(new URL(started.body.pairingUrl).hash.slice(1)).get('token'),
        deviceName: 'HTTP phone',
        devicePublicKey: 'ed25519:http-test',
      }),
    });
    assert.equal(claim.response.status, 200);
    // E2E tunnel rendezvous contract: the pairing minted a tunnel token the
    // desktop connector received at create time; claim/refresh hand the SAME
    // token to the phone plus the session id (deviceId).
    assert.equal(typeof started.body.tunnelToken, 'string');
    assert.ok(started.body.tunnelToken.length >= 16);
    assert.equal(claim.body.tunnelToken, started.body.tunnelToken, 'claim reuses pairing tunnel token');
    assert.equal(claim.body.tunnelSessionId, claim.body.deviceId);

    const refreshed = await jsonRequest(`${baseUrl}/v1/sessions/refresh`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: claim.body.deviceId,
        deviceToken: claim.body.deviceToken,
      }),
    });
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.body.tunnelToken, started.body.tunnelToken, 'refresh reuses pairing tunnel token');
    assert.equal(refreshed.body.tunnelSessionId, claim.body.deviceId);

    const devices = await jsonRequest(`${baseUrl}/v1/devices`, { headers });
    assert.equal(devices.response.status, 200);
    assert.equal(devices.body.devices.length, 1);

    const revoked = await jsonRequest(
      `${baseUrl}/v1/devices/${encodeURIComponent(claim.body.deviceId)}/revoke`,
      { method: 'POST', headers },
    );
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body.device.status, 'revoked');

    const denied = await jsonRequest(`${baseUrl}/v1/sessions/refresh`, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: claim.body.deviceId,
        deviceToken: claim.body.deviceToken,
      }),
    });
    assert.equal(denied.response.status, 401);
  });
});

test('HTTP gateway rejects incorrect admin credentials', async () => {
  await withServer(async ({ baseUrl }) => {
    const result = await jsonRequest(`${baseUrl}/v1/pairings`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
      body: '{}',
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, 'admin_not_authorized');
  });
});
