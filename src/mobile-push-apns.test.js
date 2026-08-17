'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const {
  buildPayload,
  createApnsProvider,
  loadConfig,
  signProviderToken,
} = require('./mobile-push-apns');

function testKey() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

test('provider token is an ES256 JWT with kid/iss and a valid signature', () => {
  const { privateKey, publicKey } = testKey();
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = signProviderToken({
    key: pem,
    keyId: 'ABCDE12345',
    teamId: 'TEAMID0001',
  });
  const [header, claims, signature] = token.split('.');
  assert.ok(header && claims && signature, 'three JWT segments');

  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  assert.equal(decodedHeader.alg, 'ES256');
  assert.equal(decodedHeader.kid, 'ABCDE12345');

  const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(decodedClaims.iss, 'TEAMID0001');
  assert.ok(decodedClaims.iat > 0);
  assert.equal(decodedClaims.exp - decodedClaims.iat, 3600);

  const verify = crypto.createVerify('sha256');
  verify.update(`${header}.${claims}`);
  assert.ok(
    verify.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
    'signature verifies (raw R||S)',
  );
});

test('payload carries the APNs alert, content-available, and thread id', () => {
  const payload = buildPayload({
    title: 'Buffy finished working',
    body: 'Tap to open Freebuff Gate',
    threadId: 't-123',
    badge: 1,
  });
  assert.equal(payload.aps.alert.title, 'Buffy finished working');
  assert.equal(payload.aps.alert.body, 'Tap to open Freebuff Gate');
  assert.equal(payload.aps['content-available'], 1);
  assert.equal(payload.aps.sound, 'default');
  assert.equal(payload.aps.badge, 1);
  assert.equal(payload.threadId, 't-123');
});

test('provider is a no-op until APNs is configured', async () => {
  const unconfigured = createApnsProvider({ env: {} });
  assert.equal(unconfigured.configured, false);
  assert.equal(await unconfigured.send('device-token', { title: 'x' }), false);

  const { privateKey } = testKey();
  const config = loadConfig({
    FB_APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    FB_APNS_KEY_ID: 'ABCDE12345',
    FB_APNS_TEAM_ID: 'TEAMID0001',
  });
  assert.equal(config.configured, true);
  assert.equal(config.sandbox, false);
  assert.equal(config.topic, 'com.freebuff.gate');

  const sandbox = loadConfig({
    FB_APNS_KEY: 'key',
    FB_APNS_KEY_ID: 'k',
    FB_APNS_TEAM_ID: 't',
    FB_APNS_TOPIC: 'com.freebuff.gate.ios',
    FB_APNS_SANDBOX: '1',
  });
  assert.equal(sandbox.sandbox, true);
  assert.equal(sandbox.topic, 'com.freebuff.gate.ios');
});
