'use strict';

// Apple Push Notification service provider for Freebuff Gate turn
// notifications.
//
// Sends APNs pushes directly (no Firebase): an ES256-signed provider token
// (from an Apple .p8 auth key) authenticates every request, and each push is
// a single HTTP/2 POST to api.push.apple.com (or the sandbox endpoint).
//
// Configuration (all optional; the provider is a no-op until they are set):
//   FB_APNS_KEY      path to the .p8 key, or the PEM body itself
//   FB_APNS_KEY_ID   10-char key id from the Apple developer portal
//   FB_APNS_TEAM_ID  team id
//   FB_APNS_TOPIC    bundle id to push to (default com.freebuff.gate)
//   FB_APNS_SANDBOX  "1" to use api.sandbox.push.apple.com
//
// Provider tokens are cached and regenerated before expiry (they live 1
// hour). The iOS app must have registered for remote notifications and
// uploaded its device token to the relay (POST /v1/mobile/push-token).

const crypto = require('node:crypto');
const http2 = require('node:http2');
const fs = require('node:fs');

const PROVIDER_TOKEN_TTL_MS = 60 * 60 * 1000;
const APNS_HOST = 'api.push.apple.com';
const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com';
const DEFAULT_TOPIC = 'com.freebuff.gate';

function loadConfig(env = process.env) {
  const keyRaw = env.FB_APNS_KEY || '';
  let key = keyRaw.trim();
  if (key && !key.includes('-----BEGIN') && fs.existsSync(key)) {
    key = fs.readFileSync(key, 'utf8');
  }
  return {
    key,
    keyId: (env.FB_APNS_KEY_ID || '').trim(),
    teamId: (env.FB_APNS_TEAM_ID || '').trim(),
    topic: (env.FB_APNS_TOPIC || DEFAULT_TOPIC).trim(),
    sandbox: env.FB_APNS_SANDBOX === '1',
    configured: Boolean(key && env.FB_APNS_KEY_ID && env.FB_APNS_TEAM_ID),
  };
}

// ES256 JWT provider token. APNs requires the raw R||S ECDSA signature form
// (ieee-p1363), not DER.
function signProviderToken(config, nowMs = Date.now()) {
  const header = { alg: 'ES256', kid: config.keyId };
  const nowSec = Math.floor(nowMs / 1000);
  const claims = { iss: config.teamId, iat: nowSec, exp: nowSec + 3600 };
  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto
    .createSign('sha256')
    .update(signingInput)
    .sign({ key: config.key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

function buildPayload({ title, body, threadId, badge = 1 }) {
  const aps = {
    alert: { title, body },
    sound: 'default',
    'content-available': 1,
  };
  if (badge) aps.badge = badge;
  const payload = { aps };
  if (threadId) payload.threadId = threadId;
  return payload;
}

// Returns a provider object. send() is a no-op resolving false when APNs is
// not configured; configured providers push over HTTP/2 and resolve the
// APNs response status (200 ok, others carry an apns error reason).
function createApnsProvider(options = {}) {
  const config = { ...loadConfig(options.env), ...options };
  let client = null;
  let providerToken = null;
  let providerTokenExpiresAt = 0;

  function connect() {
    if (client) return client;
    const host = config.sandbox ? APNS_SANDBOX_HOST : APNS_HOST;
    client = http2.connect(`https://${host}`);
    client.on('error', () => {
      client = null;
    });
    return client;
  }

  function token() {
    const now = Date.now();
    if (!providerToken || providerTokenExpiresAt - now < 10 * 60 * 1000) {
      providerToken = signProviderToken(config, now);
      providerTokenExpiresAt = now + PROVIDER_TOKEN_TTL_MS;
    }
    return providerToken;
  }

  function send(deviceToken, fields = {}) {
    if (!config.configured || !deviceToken) return Promise.resolve(false);
    const body = JSON.stringify(buildPayload(fields));
    return new Promise((resolve) => {
      const request = connect().request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(deviceToken)}`,
        authorization: `bearer ${token()}`,
        'apns-topic': config.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let reason = '';
      request.on('response', (headers) => {
        status = Number(headers[':status'] || 0);
        reason = String(headers['apns-reason'] || '');
        // 403 with ExpiredProviderToken: force a fresh token next time.
        if (status === 403 && /ExpiredProviderToken/i.test(reason)) {
          providerToken = null;
        }
      });
      let data = '';
      request.on('data', (chunk) => {
        data += chunk;
      });
      request.on('error', () => resolve(false));
      request.on('end', () => {
        if (status !== 200) {
          // eslint-disable-next-line no-console
          console.warn(`[push] APNs ${status}${reason ? ` ${reason}` : ''}${data ? `: ${data}` : ''}`);
        }
        resolve(status === 200);
      });
      request.end(body);
    });
  }

  return { send, configured: config.configured };
}

module.exports = {
  buildPayload,
  createApnsProvider,
  loadConfig,
  signProviderToken,
};
