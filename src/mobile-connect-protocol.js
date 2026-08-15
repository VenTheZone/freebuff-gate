'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 1;
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DEVICE_KEY_LENGTH = 8192;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomId(prefix) {
  return `${prefix}${randomToken(12)}`;
}

function randomManualCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64url');
}

function secretsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySecret(secret, expectedHash) {
  return secretsEqual(hashSecret(secret), expectedHash);
}

function normalizeCode(value) {
  return String(value ?? '').trim().replace(/\s/g, '');
}

function normalizeDeviceName(value) {
  const name = String(value ?? '').trim().replace(/[\r\n\t]+/g, ' ');
  return name.slice(0, 80) || 'Android device';
}

function validateDeviceKey(value) {
  const key = String(value ?? '').trim();
  if (!key || key.length > MAX_DEVICE_KEY_LENGTH) {
    throw new TypeError('devicePublicKey is required and must be short enough to store safely');
  }
  return key;
}

function deviceKeyFingerprint(publicKey) {
  return hashSecret(validateDeviceKey(publicKey));
}

function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function validateAppUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError('appUrl must be a valid URL');
  }

  const localHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new TypeError('appUrl must use HTTPS (HTTP is allowed only for localhost development)');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('appUrl must not contain credentials');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed;
}

function makePairingUrl(appUrl, pairingId, token) {
  const parsed = validateAppUrl(appUrl);
  parsed.hash = new URLSearchParams({
    pairingId: String(pairingId),
    token: String(token),
  }).toString();
  return parsed.toString();
}

function validateRelayUrl(value) {
  if (value == null || value === '') return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError('relayUrl must be a valid URL');
  }
  const localHttp =
    (parsed.protocol === 'http:' || parsed.protocol === 'ws:') &&
    isLoopbackHostname(parsed.hostname);
  if (!['https:', 'wss:'].includes(parsed.protocol) && !localHttp) {
    throw new TypeError('relayUrl must use HTTPS/WSS (HTTP/WS is allowed only for localhost development)');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('relayUrl must not contain credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

function clampPairingTtl(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError('pairing TTL must be a positive number of milliseconds');
  }
  return Math.min(ttl, MAX_PAIRING_TTL_MS);
}

module.exports = {
  ACCESS_TOKEN_TTL_MS,
  DEFAULT_PAIRING_TTL_MS,
  DEVICE_TOKEN_TTL_MS,
  MAX_PAIRING_ATTEMPTS,
  MAX_PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  clampPairingTtl,
  deviceKeyFingerprint,
  hashSecret,
  isLoopbackHostname,
  makePairingUrl,
  normalizeCode,
  normalizeDeviceName,
  randomId,
  randomManualCode,
  randomToken,
  secretsEqual,
  validateAppUrl,
  validateDeviceKey,
  validateRelayUrl,
  verifySecret,
};
