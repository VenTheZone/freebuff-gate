'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const { renderQrText } = require('./mobile-connect-qr');
const {
  ACCESS_TOKEN_TTL_MS,
  DEFAULT_PAIRING_TTL_MS,
  DEVICE_TOKEN_TTL_MS,
  MAX_PAIRING_ATTEMPTS,
  clampPairingTtl,
  deviceKeyFingerprint,
  hashSecret,
  isLoopbackHostname,
  makePairingUrl,
  normalizeDeviceName,
  randomId,
  randomToken,
  validateAppUrl,
  validateDeviceKey,
  validateRelayUrl,
  verifySecret,
} = require('./mobile-connect-protocol');

const DEFAULT_PORT = 8794;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_APP_URL = 'https://mobile.freebuff.app/pair';
const DEFAULT_UI_URL = 'http://127.0.0.1:58061';
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  '.config',
  'freebuff',
  'mobile-connect.json',
);
const MAX_BODY_BYTES = 64 * 1024;

class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}

function nowMs() {
  return Date.now();
}

function requireString(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new GatewayError(400, 'invalid_request', `${field} is required`);
  return result;
}

function parsePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new GatewayError(400, 'invalid_request', `${field} must be a positive integer`);
  }
  return number;
}

function safeStateShape(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.version !== 1) return null;
  if (!state.pending || typeof state.pending !== 'object') return null;
  if (!state.devices || typeof state.devices !== 'object') return null;
  return state;
}

function defaultState() {
  return {
    version: 1,
    pending: {},
    devices: {},
  };
}

class PairingStore {
  constructor(options = {}) {
    this.stateFile = options.stateFile === undefined ? DEFAULT_STATE_FILE : options.stateFile;
    this.now = options.now || nowMs;
    this.appUrl = options.appUrl || null;
    this.relayUrl = options.relayUrl || null;
    this.uiUrl = validateAppUrl(options.uiUrl || DEFAULT_UI_URL).toString();
    this.state = this.load();
    this.cleanup();
  }

  load() {
    if (!this.stateFile) return defaultState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const valid = safeStateShape(parsed);
      if (!valid) throw new Error('unsupported state shape');
      return valid;
    } catch (error) {
      if (error.code === 'ENOENT') return defaultState();
      throw new Error(`Cannot read mobile-connect state: ${error.message}`);
    }
  }

  persist() {
    if (!this.stateFile) return;
    const directory = path.dirname(this.stateFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX modes.
    }

    const tempFile = `${this.stateFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(tempFile, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
    try {
      fs.renameSync(tempFile, this.stateFile);
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  cleanup() {
    const current = this.now();
    let changed = false;
    for (const [id, pairing] of Object.entries(this.state.pending)) {
      if (pairing.expiresAt <= current) {
        delete this.state.pending[id];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  startPairing(options = {}) {
    this.cleanup();
    const appUrl = validateAppUrl(options.appUrl || this.appUrl || DEFAULT_APP_URL);
    const relayUrl = validateRelayUrl(
      options.relayUrl === undefined ? this.relayUrl : options.relayUrl,
    );
    const uiUrl = validateAppUrl(options.uiUrl === undefined ? this.uiUrl : options.uiUrl).toString();
    const ttlMs = clampPairingTtl(options.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
    const createdAt = this.now();
    const expiresAt = createdAt + ttlMs;
    const pairingId = randomId('p_');
    const token = randomToken();

    this.state.pending[pairingId] = {
      id: pairingId,
      tokenHash: hashSecret(token),
      createdAt,
      expiresAt,
      attempts: 0,
      appUrl: appUrl.toString(),
      relayUrl,
      uiUrl,
      connectorId: options.connectorId ? String(options.connectorId) : null,
    };
    this.persist();

    return {
      protocolVersion: 1,
      pairingId,
      pairingUrl: makePairingUrl(appUrl.toString(), pairingId, token),
      expiresAt: new Date(expiresAt).toISOString(),
      relayUrl,
      uiUrl,
    };
  }

  claim(options = {}) {
    this.cleanup();
    const pairingId = requireString(options.pairingId, 'pairingId');
    const token = requireString(options.token, 'token');
    const pairing = this.state.pending[pairingId];

    if (!pairing) {
      throw new GatewayError(404, 'pairing_not_found', 'Pairing request is missing or expired');
    }
    if (pairing.expiresAt <= this.now()) {
      delete this.state.pending[pairingId];
      this.persist();
      throw new GatewayError(410, 'pairing_expired', 'Pairing request expired');
    }

    const tokenMatches = verifySecret(token, pairing.tokenHash);
    if (!tokenMatches) {
      pairing.attempts += 1;
      const locked = pairing.attempts >= MAX_PAIRING_ATTEMPTS;
      if (locked) delete this.state.pending[pairingId];
      this.persist();
      throw new GatewayError(
        locked ? 410 : 401,
        locked ? 'pairing_locked' : 'invalid_pairing',
        locked
          ? 'Pairing request locked after too many failed attempts'
          : 'Pairing token is invalid',
      );
    }

    const publicKey = validateDeviceKey(options.devicePublicKey);
    const createdAt = this.now();
    const deviceId = randomId('d_');
    const deviceToken = randomToken();
    const accessToken = randomToken();
    const deviceExpiresAt = createdAt + DEVICE_TOKEN_TTL_MS;
    const accessExpiresAt = createdAt + ACCESS_TOKEN_TTL_MS;
    const device = {
      id: deviceId,
      name: normalizeDeviceName(options.deviceName),
      keyFingerprint: deviceKeyFingerprint(publicKey),
      deviceTokenHash: hashSecret(deviceToken),
      deviceExpiresAt,
      accessTokenHash: hashSecret(accessToken),
      accessExpiresAt,
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
      pairingId,
      connectorId: pairing.connectorId || null,
      relayUrl: pairing.relayUrl,
      uiUrl: pairing.uiUrl,
    };

    delete this.state.pending[pairingId];
    this.state.devices[deviceId] = device;
    this.persist();

    return {
      protocolVersion: 1,
      deviceId,
      deviceToken,
      accessToken,
      accessTokenExpiresAt: new Date(accessExpiresAt).toISOString(),
      deviceExpiresAt: new Date(deviceExpiresAt).toISOString(),
      relayUrl: pairing.relayUrl,
      uiUrl: pairing.uiUrl,
    };
  }

  refresh(options = {}) {
    this.cleanup();
    const deviceId = requireString(options.deviceId, 'deviceId');
    const deviceToken = requireString(options.deviceToken, 'deviceToken');
    const device = this.state.devices[deviceId];
    if (!device || device.revokedAt) {
      throw new GatewayError(401, 'device_not_authorized', 'Device is not authorized');
    }
    const current = this.now();
    if (device.deviceExpiresAt <= current || !verifySecret(deviceToken, device.deviceTokenHash)) {
      throw new GatewayError(401, 'device_not_authorized', 'Device is not authorized');
    }

    const accessToken = randomToken();
    const accessExpiresAt = current + ACCESS_TOKEN_TTL_MS;
    device.accessTokenHash = hashSecret(accessToken);
    device.accessExpiresAt = accessExpiresAt;
    device.lastSeenAt = current;
    this.persist();

    return {
      protocolVersion: 1,
      deviceId,
      accessToken,
      accessTokenExpiresAt: new Date(accessExpiresAt).toISOString(),
      relayUrl: device.relayUrl,
      uiUrl: device.uiUrl,
    };
  }

  getDevice(deviceId) {
    const id = requireString(deviceId, 'deviceId');
    return this.state.devices[id] || null;
  }

  getDeviceForAccess(options = {}) {
    const accessToken = requireString(options.accessToken, 'accessToken');
    const current = this.now();
    for (const device of Object.values(this.state.devices)) {
      if (
        !device.revokedAt &&
        device.accessExpiresAt > current &&
        verifySecret(accessToken, device.accessTokenHash)
      ) {
        device.lastSeenAt = current;
        this.persist();
        return device;
      }
    }
    throw new GatewayError(401, 'access_not_authorized', 'Access token is invalid or expired');
  }

  authenticateAccess(options = {}) {
    return this.publicDevice(this.getDeviceForAccess(options));
  }

  publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      keyFingerprint: device.keyFingerprint,
      createdAt: new Date(device.createdAt).toISOString(),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
      expiresAt: new Date(device.deviceExpiresAt).toISOString(),
      revokedAt: device.revokedAt ? new Date(device.revokedAt).toISOString() : null,
      status: device.revokedAt
        ? 'revoked'
        : device.deviceExpiresAt <= this.now()
          ? 'expired'
          : 'paired',
    };
  }

  listDevices() {
    this.cleanup();
    return Object.values(this.state.devices).map((device) => this.publicDevice(device));
  }

  revoke(deviceId) {
    const id = requireString(deviceId, 'deviceId');
    const device = this.state.devices[id];
    if (!device) throw new GatewayError(404, 'device_not_found', 'Device not found');
    if (!device.revokedAt) {
      device.revokedAt = this.now();
      this.persist();
    }
    return this.publicDevice(device);
  }
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      reject(new GatewayError(413, 'body_too_large', 'Request body is too large'));
      req.resume();
      return;
    }

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError(413, 'body_too_large', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new GatewayError(400, 'invalid_json', 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function setHeaders(res, options = {}) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");

  const origin = options.requestOrigin;
  if (origin && options.allowedOrigin && origin === options.allowedOrigin) {
    res.setHeader('access-control-allow-origin', options.allowedOrigin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('vary', 'Origin');
  }
}

function sendJson(res, status, body, options) {
  setHeaders(res, options);
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    throw new GatewayError(400, 'invalid_url', 'Request URL is invalid');
  }
}

function createGatewayServer(options = {}) {
  const store = options.store || new PairingStore({
    stateFile: options.stateFile,
    appUrl: options.appUrl || process.env.FB_MOBILE_APP_URL || DEFAULT_APP_URL,
    relayUrl: options.relayUrl || process.env.FB_MOBILE_RELAY_URL || null,
    uiUrl: options.uiUrl || process.env.FB_MOBILE_UI_URL || DEFAULT_UI_URL,
  });
  const adminToken = options.adminToken ?? process.env.FB_MOBILE_ADMIN_TOKEN ?? null;
  const defaultAppUrl = options.appUrl || process.env.FB_MOBILE_APP_URL || DEFAULT_APP_URL;
  const allowedOrigin = options.allowedOrigin || null;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};

  function requireAdmin(req) {
    if (adminToken) {
      if (!verifySecret(bearerToken(req), hashSecret(adminToken))) {
        throw new GatewayError(401, 'admin_not_authorized', 'Admin authorization is required');
      }
      return;
    }
    if (!isLoopbackRequest(req)) {
      throw new GatewayError(401, 'admin_not_authorized', 'Set FB_MOBILE_ADMIN_TOKEN before using a non-local gateway');
    }
  }

  async function handle(req, res) {
    const pathname = requestPath(req);
    const requestOptions = {
      requestOrigin: req.headers.origin,
      allowedOrigin,
    };

    if (req.method === 'OPTIONS') {
      setHeaders(res, requestOptions);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'freebuff-mobile-gateway', protocolVersion: 1 }, requestOptions);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/pairings') {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const pairing = store.startPairing({
        appUrl: body.appUrl || defaultAppUrl,
        relayUrl: body.relayUrl,
        uiUrl: body.uiUrl,
        connectorId: body.connectorId,
        ttlMs: body.ttlSeconds === undefined
          ? undefined
          : parsePositiveInteger(body.ttlSeconds, 'ttlSeconds') * 1000,
      });
      sendJson(res, 201, pairing, requestOptions);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/pairings/claim') {
      const body = await readJsonBody(req);
      const result = store.claim({
        pairingId: body.pairingId,
        token: body.token,
        deviceName: body.deviceName,
        devicePublicKey: body.devicePublicKey,
      });
      sendJson(res, 200, result, requestOptions);
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/sessions/refresh') {
      const body = await readJsonBody(req);
      const result = store.refresh({
        deviceId: body.deviceId,
        deviceToken: body.deviceToken,
      });
      sendJson(res, 200, result, requestOptions);
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/devices') {
      requireAdmin(req);
      sendJson(res, 200, { devices: store.listDevices() }, requestOptions);
      return;
    }

    const revokeMatch = pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      requireAdmin(req);
      sendJson(res, 200, { device: store.revoke(decodeURIComponent(revokeMatch[1])) }, requestOptions);
      return;
    }

    throw new GatewayError(404, 'not_found', 'Endpoint not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const normalized = error instanceof GatewayError
        ? error
        : new GatewayError(500, 'internal_error', 'Gateway request failed');
      logger('request_error', {
        code: normalized.code,
        status: normalized.status,
        method: req.method,
        path: (() => {
          try {
            return requestPath(req);
          } catch {
            return '<invalid>';
          }
        })(),
      });
      if (!res.headersSent) {
        sendJson(res, normalized.status || 500, {
          error: normalized.code || 'internal_error',
          message: normalized.message,
        }, {
          requestOrigin: req.headers.origin,
          allowedOrigin,
        });
      } else {
        res.destroy();
      }
    });
  });

  server.store = store;
  server.adminTokenConfigured = Boolean(adminToken);
  return server;
}

function isLoopbackBind(host) {
  return isLoopbackHostname(host);
}

function parseCliArgs(argv) {
  const command = argv[0] || 'help';
  const options = {
    command: command === '--help' || command === '-h' ? 'help' : command,
    gateway: process.env.FB_MOBILE_GATEWAY_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    host: process.env.FB_MOBILE_GATEWAY_HOST || DEFAULT_HOST,
    port: Number(process.env.FB_MOBILE_GATEWAY_PORT || DEFAULT_PORT),
    stateFile: process.env.FB_MOBILE_STATE_FILE || DEFAULT_STATE_FILE,
    appUrl: process.env.FB_MOBILE_APP_URL || DEFAULT_APP_URL,
    relayUrl: process.env.FB_MOBILE_RELAY_URL || null,
    uiUrl: process.env.FB_MOBILE_UI_URL || DEFAULT_UI_URL,
    adminToken: process.env.FB_MOBILE_ADMIN_TOKEN || null,
    ttlSeconds: 600,
    deviceId: null,
    json: false,
    qr: true,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--gateway': options.gateway = next(); break;
      case '--host': options.host = next(); break;
      case '--port': options.port = Number(next()); break;
      case '--state-file': options.stateFile = next(); break;
      case '--app-url': options.appUrl = next(); break;
      case '--relay-url': options.relayUrl = next(); break;
      case '--ui-url': options.uiUrl = next(); break;
      case '--admin-token': options.adminToken = next(); break;
      case '--ttl': options.ttlSeconds = Number(next()); break;
      case '--json': options.json = true; break;
      case '--no-qr': options.qr = false; break;
      case '--device': options.deviceId = next(); break;
      case '--help':
      case '-h': options.command = 'help'; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return options;
}

function printUsage() {
  console.log(`Freebuff mobile pairing gateway

Commands:
  serve       Start local pairing control plane
  pair        Create one-use pairing QR URL
  devices     List paired devices
  revoke      Revoke a paired device

Examples:
  node src/mobile-connect-gateway.js serve
  node src/mobile-connect-gateway.js pair --ttl 600
  node src/mobile-connect-gateway.js pair --no-qr
  node src/mobile-connect-gateway.js devices
  node src/mobile-connect-gateway.js revoke --device d_...

Environment:
  FB_MOBILE_RELAY_URL       Managed relay base URL (HTTPS/WSS)
  FB_MOBILE_APP_URL         Android pairing URL, HTTPS only
  FB_MOBILE_ADMIN_TOKEN     Required when gateway binds beyond loopback
  FB_MOBILE_STATE_FILE      Protected local state path
`);
}

function requestJson(target, options = {}) {
  const parsed = new URL(target);
  const transport = parsed.protocol === 'https:' ? require('node:https') : http;
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers = {
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    ...(options.headers || {}),
  };

  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, {
      method: options.method || 'GET',
      headers,
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        resolve({ status: response.statusCode || 0, data });
      });
    });
    request.on('timeout', () => request.destroy(new Error('gateway request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function adminHeaders(adminToken) {
  return adminToken ? { authorization: `Bearer ${adminToken}` } : {};
}

async function runCli(argv) {
  const options = parseCliArgs(argv);
  if (options.command === 'help') {
    printUsage();
    return 0;
  }

  if (options.command === 'serve') {
    if (!isLoopbackBind(options.host) && !options.adminToken) {
      throw new Error('Refusing non-loopback bind without FB_MOBILE_ADMIN_TOKEN');
    }
    const server = createGatewayServer(options);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, resolve);
    });
    const address = server.address();
    console.log(`Mobile gateway listening on http://${options.host}:${address.port}`);
    console.log(`State file: ${options.stateFile}`);
    console.log(`Managed relay: ${options.relayUrl || 'not configured (pairing control plane only)'}`);
    if (!options.adminToken) {
      console.log('Admin endpoints restricted to local loopback requests.');
    }
    await new Promise((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }

  if (options.command === 'pair') {
    const result = await requestJson(`${options.gateway.replace(/\/$/, '')}/v1/pairings`, {
      method: 'POST',
      headers: adminHeaders(options.adminToken),
      body: {
        appUrl: options.appUrl,
        ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
        ...(options.uiUrl ? { uiUrl: options.uiUrl } : {}),
        ttlSeconds: options.ttlSeconds,
      },
    });
    if (result.status >= 400) throw new Error(result.data?.message || `Gateway returned HTTP ${result.status}`);
    if (options.json) {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      if (options.qr) console.log(renderQrText(result.data.pairingUrl));
      console.log('Pairing ready. Scan QR above or use URL in Freebuff Android app:');
      console.log(result.data.pairingUrl);
      console.log(`Expires: ${result.data.expiresAt}`);
      console.log('Pairing URL is one-use. Never paste it into logs or tickets.');
    }
    return 0;
  }

  if (options.command === 'devices') {
    const result = await requestJson(`${options.gateway.replace(/\/$/, '')}/v1/devices`, {
      headers: adminHeaders(options.adminToken),
    });
    if (result.status >= 400) throw new Error(result.data?.message || `Gateway returned HTTP ${result.status}`);
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  }

  if (options.command === 'revoke') {
    const deviceId = options.deviceId;
    if (!deviceId) throw new Error('revoke needs --device <device-id>');
    const result = await requestJson(
      `${options.gateway.replace(/\/$/, '')}/v1/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: 'POST', headers: adminHeaders(options.adminToken) },
    );
    if (result.status >= 400) throw new Error(result.data?.message || `Gateway returned HTTP ${result.status}`);
    console.log(JSON.stringify(result.data, null, 2));
    return 0;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  DEFAULT_APP_URL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_STATE_FILE,
  GatewayError,
  PairingStore,
  createGatewayServer,
  isLoopbackBind,
  parseCliArgs,
  runCli,
};
