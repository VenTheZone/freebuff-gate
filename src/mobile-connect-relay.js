'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const {
  GatewayError,
  PairingStore,
} = require('./mobile-connect-gateway');
const {
  hashSecret,
  isLoopbackHostname,
  randomId,
  randomToken,
  secretsEqual,
} = require('./mobile-connect-protocol');
const {
  acceptUpgrade,
  parseSubprotocols,
  rejectUpgrade,
} = require('./mobile-connect-websocket');
const { createApnsProvider } = require('./mobile-push-apns');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8795;
const DEFAULT_HTTP_URL = 'https://mobile.example.invalid';
const DEFAULT_WS_URL = 'wss://mobile.example.invalid';
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  '.config',
  'freebuff',
  'mobile-relay.json',
);
const DEFAULT_CONNECTOR_STATE_FILE = path.join(
  os.homedir(),
  '.config',
  'freebuff',
  'mobile-relay-connectors.json',
);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 15 * 60 * 1000;
// Web-session cookie TTL for the mobile WebView. Long-lived (7 days) and
// renewed on use (getWebSession extends it), so an active app never hits
// "Could not load skills: web_session_expired" mid-session: the app
// re-establishes every access-token refresh, and any request with a still-
// valid cookie extends the session further. Revocation is still enforced on
// every request via the device lookup.
const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONNECTOR_TOKEN_TTL_MS = 15 * 60 * 1000;
const CONNECTOR_REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = '__Host-freebuff_session';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function emptyConnectorState() {
  return { version: 1, credentials: {} };
}

function loadConnectorState(file) {
  if (!file) return emptyConnectorState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !parsed.credentials || typeof parsed.credentials !== 'object') {
      throw new Error('unsupported connector state shape');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyConnectorState();
    throw new Error(`Cannot read relay connector state: ${error.message}`);
  }
}

function persistConnectorState(file, state) {
  if (!file) return;
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  try {
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class RelayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

function nowMs() {
  return Date.now();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function requireString(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new RelayError(400, 'invalid_request', `${field} is required`);
  return result;
}

function normalizeConnectorId(value) {
  const id = requireString(value, 'connectorId');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
    throw new RelayError(400, 'invalid_connector', 'connectorId contains unsupported characters');
  }
  return id;
}

function normalizeUrl(value, kind) {
  try {
    const parsed = new URL(String(value));
    const local = isLoopbackHostname(parsed.hostname);
    const allowed = kind === 'http'
      ? parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)
      : parsed.protocol === 'wss:' || (parsed.protocol === 'ws:' && local);
    if (!allowed || parsed.username || parsed.password) throw new Error('unsupported URL');
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new RelayError(400, 'invalid_relay_url', `${kind} relay URL must use HTTPS/WSS`);
  }
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new RelayError(413, 'body_too_large', 'Request body is too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new RelayError(413, 'body_too_large', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RelayError(400, 'invalid_json', 'Request body must be valid JSON'));
      }
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new RelayError(413, 'body_too_large', 'Request body is too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new RelayError(413, 'body_too_large', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function cookieValue(header, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(header || '').match(new RegExp(`(?:^|;)\\s*${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function headerObject(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || lower === 'content-length') continue;
    if (lower === 'cookie') {
      const kept = String(value || '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => !part.startsWith(`${COOKIE_NAME}=`))
        .join('; ');
      if (kept) result[name] = kept;
      continue;
    }
    result[name] = Array.isArray(value) ? value : String(value ?? '');
  }
  return result;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    result[name] = value;
  }
  return result;
}

function sendJson(res, status, body, options = {}) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  if (options.setCookie) res.setHeader('set-cookie', [options.setCookie]);
  if (options.allowedOrigin && options.requestOrigin === options.allowedOrigin) {
    res.setHeader('access-control-allow-origin', options.allowedOrigin);
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('vary', 'Origin');
  }
  res.end(payload);
}

function failResponse(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const normalized = error instanceof RelayError || error instanceof GatewayError
    ? error
    : new RelayError(500, 'internal_error', 'Relay request failed');
  sendJson(res, normalized.status || 500, {
    error: normalized.code || 'internal_error',
    message: normalized.message,
  });
}

class RelayHub {
  constructor(options = {}) {
    this.now = options.now || nowMs;
    this.connectorToken = options.connectorToken || process.env.FB_MOBILE_RELAY_CONNECTOR_TOKEN || null;
    this.enrollmentToken = options.enrollmentToken || process.env.FB_MOBILE_RELAY_ENROLLMENT_TOKEN || null;
    this.connectorStateFile = options.connectorStateFile === undefined
      ? (process.env.FB_MOBILE_RELAY_CONNECTOR_STATE_FILE || DEFAULT_CONNECTOR_STATE_FILE)
      : options.connectorStateFile;
    this.connectorState = loadConnectorState(this.connectorStateFile);
    this.connectorTokenTtlMs = options.connectorTokenTtlMs || CONNECTOR_TOKEN_TTL_MS;
    this.connectorRefreshTtlMs = options.connectorRefreshTtlMs || CONNECTOR_REFRESH_TTL_MS;
    this.adminToken = options.adminToken || process.env.FB_MOBILE_RELAY_ADMIN_TOKEN || null;
    this.publicHttpUrl = normalizeUrl(
      options.publicHttpUrl || process.env.FB_MOBILE_RELAY_HTTP_URL || DEFAULT_HTTP_URL,
      'http',
    );
    this.publicWsUrl = normalizeUrl(
      options.publicWsUrl || process.env.FB_MOBILE_RELAY_WS_URL || DEFAULT_WS_URL,
      'ws',
    );
    this.allowedOrigin = options.allowedOrigin || process.env.FB_MOBILE_RELAY_ALLOWED_ORIGIN || null;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.cookieName = options.cookieName || COOKIE_NAME;
    this.webSessionTtlMs = options.webSessionTtlMs || WEB_SESSION_TTL_MS;
    this.connectors = new Map();
    this.httpRequests = new Map();
    this.webSockets = new Map();
    this.webSessions = new Map();
    // APNs turn-notification provider (no-op until FB_APNS_* is configured)
    // plus the per-connector /api/events watcher that drives it.
    this.apns = options.apnsProvider || createApnsProvider({ env: process.env });
    this.eventWatchers = new Map();
    // Per-connector "desktop last interacted" timestamps, fed by the thread
    // events on the /api/events stream (thread.lastPromptAt = when the user
    // last sent a message on the desktop). The turn-finished watcher uses
    // this to detect a user who walked away leaving the desktop UI open and
    // push to the phone even when the phone app itself looks active.
    this.desktopPromptAt = new Map();
    // A connector is "desktop idle" when no prompt has been sent through it
    // for this long; pushes then fire to every paired device regardless of
    // that device's own recency (the user is away from the desktop).
    this.desktopIdleMs = options.desktopIdleMs
      || Number(process.env.FB_PUSH_DESKTOP_IDLE_MS)
      || 120_000;
    this.store = options.store || new PairingStore({
      stateFile: options.stateFile === undefined ? DEFAULT_STATE_FILE : options.stateFile,
      appUrl: options.appUrl || `${this.publicHttpUrl}/pair`,
      relayUrl: options.relayUrl || this.publicWsUrl,
      uiUrl: options.uiUrl || this.publicHttpUrl,
    });
  }

  requireConnector(req) {
    const identity = this.authenticateConnectorToken(bearerToken(req));
    if (!identity) {
      throw new RelayError(401, 'connector_not_authorized', 'Connector authorization is required');
    }
    return identity;
  }

  requireEnrollment(req) {
    if (!this.enrollmentToken) {
      throw new RelayError(503, 'enrollment_unavailable', 'Relay enrollment is not configured');
    }
    if (!secretsEqual(bearerToken(req), this.enrollmentToken)) {
      throw new RelayError(401, 'enrollment_not_authorized', 'Enrollment authorization is required');
    }
  }

  authenticateConnectorToken(token) {
    const supplied = String(token || '');
    if (this.connectorToken && secretsEqual(supplied, this.connectorToken)) {
      return { connectorId: null, kind: 'static' };
    }
    this.cleanup();
    const current = this.now();
    for (const credential of Object.values(this.connectorState.credentials)) {
      if (
        credential.revokedAt == null &&
        credential.tokenExpiresAt > current &&
        secretsEqual(hashSecret(supplied), credential.tokenHash)
      ) {
        return { connectorId: credential.connectorId, kind: 'issued' };
      }
    }
    return null;
  }

  enrollConnector(connectorId) {
    const id = normalizeConnectorId(connectorId || randomId('c_'));
    const createdAt = this.now();
    const connectorToken = randomToken();
    const connectorRefreshToken = randomToken();
    const credential = {
      connectorId: id,
      tokenHash: hashSecret(connectorToken),
      refreshTokenHash: hashSecret(connectorRefreshToken),
      tokenExpiresAt: createdAt + this.connectorTokenTtlMs,
      refreshExpiresAt: createdAt + this.connectorRefreshTtlMs,
      createdAt,
      revokedAt: null,
    };
    this.connectorState.credentials[id] = credential;
    persistConnectorState(this.connectorStateFile, this.connectorState);
    return {
      protocolVersion: 1,
      connectorId: id,
      connectorToken,
      connectorTokenExpiresAt: new Date(credential.tokenExpiresAt).toISOString(),
      connectorRefreshToken,
      connectorRefreshTokenExpiresAt: new Date(credential.refreshExpiresAt).toISOString(),
      relayHttpUrl: this.publicHttpUrl,
      relayWsUrl: this.publicWsUrl,
    };
  }

  refreshConnector(options = {}) {
    const id = normalizeConnectorId(options.connectorId);
    const refreshToken = requireString(options.connectorRefreshToken, 'connectorRefreshToken');
    const credential = this.connectorState.credentials[id];
    const current = this.now();
    if (
      !credential ||
      credential.revokedAt != null ||
      credential.refreshExpiresAt <= current ||
      !secretsEqual(hashSecret(refreshToken), credential.refreshTokenHash)
    ) {
      throw new RelayError(401, 'connector_refresh_not_authorized', 'Connector refresh credential is invalid or expired');
    }
    const connectorToken = randomToken();
    credential.tokenHash = hashSecret(connectorToken);
    credential.tokenExpiresAt = current + this.connectorTokenTtlMs;
    persistConnectorState(this.connectorStateFile, this.connectorState);
    return {
      protocolVersion: 1,
      connectorId: id,
      connectorToken,
      connectorTokenExpiresAt: new Date(credential.tokenExpiresAt).toISOString(),
      connectorRefreshTokenExpiresAt: new Date(credential.refreshExpiresAt).toISOString(),
      relayHttpUrl: this.publicHttpUrl,
      relayWsUrl: this.publicWsUrl,
    };
  }

  requireAdmin(req) {
    if (!this.adminToken || !secretsEqual(bearerToken(req), this.adminToken)) {
      throw new RelayError(401, 'admin_not_authorized', 'Relay admin authorization is required');
    }
  }

  cleanup() {
    const current = this.now();
    for (const [tokenHash, session] of this.webSessions) {
      if (session.expiresAt <= current) this.webSessions.delete(tokenHash);
    }
    let changed = false;
    for (const [id, credential] of Object.entries(this.connectorState.credentials)) {
      if (credential.refreshExpiresAt <= current) {
        delete this.connectorState.credentials[id];
        changed = true;
      }
    }
    if (changed) persistConnectorState(this.connectorStateFile, this.connectorState);
  }

  createPairing(body = {}) {
    const connectorId = normalizeConnectorId(body.connectorId);
    const pairing = this.store.startPairing({
      connectorId,
      appUrl: body.appUrl || `${this.publicHttpUrl}/pair`,
      relayUrl: body.relayUrl || this.publicWsUrl,
      uiUrl: body.uiUrl || this.publicHttpUrl,
      ttlMs: body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds) * 1000,
    });
    return pairing;
  }

  registerConnector(connection, connectorId) {
    const id = normalizeConnectorId(connectorId);
    if (connection.authenticatedConnectorId && connection.authenticatedConnectorId !== id) {
      throw new RelayError(403, 'connector_identity_mismatch', 'Connector token is bound to another connector id');
    }
    const previous = this.connectors.get(id);
    if (previous && previous !== connection) previous.close(4001, 'Replaced by newer connector');
    this.connectors.set(id, connection);
    connection.connectorId = id;
    connection.sendJson({ type: 'connector.ready', connectorId: id, protocolVersion: 1 });
    connection.once('close', () => {
      if (this.connectors.get(id) === connection) {
        this.connectors.delete(id);
        this.failConnectorRequests(id, 'Desktop connector disconnected');
        this.failConnectorSockets(id);
        this.stopEventWatcher(id);
      }
    });
    this.startEventWatcher(id);
  }

  // ---- Turn-finished push watcher (APNs) ----
  // Holds one SSE stream per connector to the desktop orchestrator's
  // /api/events (through the connector, same path the WebView uses) and, on
  // agent finish events, pushes to every paired device of that connector that
  // has uploaded an APNs token and was not actively used within the last 2
  // minutes (an active app's UI is already live; idle/background apps need
  // the push). Only runs when APNs is configured.
  eventWatcherFor(connectorId, requestId) {
    const watcher = this.eventWatchers.get(connectorId);
    return watcher && watcher.id === requestId ? watcher : null;
  }

  startEventWatcher(connectorId) {
    if (!this.apns.configured || this.eventWatchers.has(connectorId)) return;
    const connector = this.connectors.get(connectorId);
    if (!connector) return;
    const watcher = { id: randomId('w_'), connectorId, buffer: '', retry: null };
    this.eventWatchers.set(connectorId, watcher);
    connector.sendJson({
      type: 'http.request',
      id: watcher.id,
      method: 'GET',
      path: '/api/events',
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      bodyBase64: null,
    });
  }

  stopEventWatcher(connectorId) {
    const watcher = this.eventWatchers.get(connectorId);
    if (!watcher) return;
    this.eventWatchers.delete(connectorId);
    clearTimeout(watcher.retry);
    const connector = this.connectors.get(connectorId);
    if (connector) connector.sendJson({ type: 'http.cancel', id: watcher.id });
  }

  scheduleEventWatcherRetry(connectorId) {
    const watcher = this.eventWatchers.get(connectorId);
    if (!watcher || watcher.retry) return;
    watcher.retry = setTimeout(() => {
      watcher.retry = null;
      if (this.eventWatchers.get(connectorId) !== watcher) return;
      const connector = this.connectors.get(connectorId);
      if (!connector) {
        this.eventWatchers.delete(connectorId);
        return;
      }
      connector.sendJson({
        type: 'http.request',
        id: watcher.id,
        method: 'GET',
        path: '/api/events',
        headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
        bodyBase64: null,
      });
    }, 3000);
  }

  handleEventWatcherChunk(connectorId, dataBase64) {
    const watcher = this.eventWatchers.get(connectorId);
    if (!watcher) return;
    watcher.buffer += Buffer.from(String(dataBase64 || ''), 'base64').toString('utf8');
    if (watcher.buffer.length > 65536) watcher.buffer = watcher.buffer.slice(-65536);
    let index;
    while ((index = watcher.buffer.indexOf('\n\n')) !== -1) {
      const frame = watcher.buffer.slice(0, index);
      watcher.buffer = watcher.buffer.slice(index + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      let event;
      try {
        event = JSON.parse(data.slice(6));
      } catch {
        continue;
      }
      if (event && event.type === 'thread' && event.thread && event.thread.lastPromptAt) {
        // The user just interacted with the desktop (sent a message on this
        // thread). Keep the freshest prompt timestamp across all threads of
        // the connector.
        const lastPrompt = Number(event.thread.lastPromptAt) || 0;
        if (lastPrompt > 0) {
          this.desktopPromptAt.set(
            connectorId,
            Math.max(this.desktopPromptAt.get(connectorId) || 0, lastPrompt),
          );
        }
      }
      if (event && event.type === 'agent' && event.event && event.event.type === 'finish') {
        this.onTurnFinished(connectorId, String(event.threadId || ''));
      }
    }
  }

  onTurnFinished(connectorId, threadId) {
    if (!this.apns.configured) return;
    const now = this.now();
    // Desktop idle = the user has not sent a message through this connector
    // for a while. If they left the desktop UI open and walked away, the
    // finish must reach the phone even when a phone app was recently used
    // (its screen may be live but the user is not watching it). When the
    // desktop is active, keep the per-device recency skip so a live app is
    // not double-notified.
    const lastPrompt = this.desktopPromptAt.get(connectorId) || 0;
    const desktopIdle = now - lastPrompt >= this.desktopIdleMs;
    for (const device of this.store.devicesForConnector(connectorId)) {
      if (!device.pushToken) continue;
      if (!desktopIdle && now - (device.lastSeenAt || 0) < 120_000) continue;
      this.apns
        .send(device.pushToken, {
          title: 'Buffy finished working',
          body: 'Tap to open Freebuff Gate',
          threadId,
        })
        .catch(() => {});
    }
  }

  failConnectorRequests(connectorId, message) {
    for (const [id, request] of this.httpRequests) {
      if (request.connectorId !== connectorId) continue;
      this.httpRequests.delete(id);
      clearTimeout(request.timer);
      if (!request.response.headersSent) {
        sendJson(request.response, 503, { error: 'desktop_offline', message });
      } else {
        request.response.destroy();
      }
    }
  }

  failConnectorSockets(connectorId) {
    for (const [id, bridge] of this.webSockets) {
      if (bridge.connectorId !== connectorId) continue;
      this.webSockets.delete(id);
      bridge.mobile.close(1011, 'Desktop connector disconnected');
    }
  }

  getWebSession(req, suppliedToken = null) {
    this.cleanup();
    const raw = suppliedToken || cookieValue(req.headers.cookie, this.cookieName);
    if (!raw) throw new RelayError(401, 'web_session_required', 'Mobile session cookie is required');
    const tokenHash = hashSecret(raw);
    const session = this.webSessions.get(tokenHash);
    const current = this.now();
    if (!session || session.expiresAt <= current) {
      this.webSessions.delete(tokenHash);
      throw new RelayError(401, 'web_session_expired', 'Mobile session cookie expired');
    }
    // Sliding renewal: a session that is more than half consumed gets
    // extended, so actively-used sessions never expire out from under a
    // user mid-conversation (the mobile UI surfaces the 401 as "Could not
    // load skills: web_session_expired").
    if (session.expiresAt - current < this.webSessionTtlMs / 2) {
      session.expiresAt = current + this.webSessionTtlMs;
    }
    let device;
    try {
      device = this.store.getDevice(session.deviceId);
    } catch (error) {
      this.webSessions.delete(tokenHash);
      throw error;
    }
    if (!device || device.revokedAt || device.deviceExpiresAt <= current) {
      this.webSessions.delete(tokenHash);
      throw new RelayError(401, 'device_not_authorized', 'Paired device is no longer authorized');
    }
    // Activity marker for the push watcher (in-memory; persisted on the next
    // token operation): lets the watcher skip pushing to actively-used apps.
    device.lastSeenAt = current;
    return { ...session, device };
  }

  establishWebSession(accessToken) {
    const device = this.store.getDeviceForAccess({ accessToken });
    if (!device.connectorId) {
      throw new RelayError(503, 'connector_missing', 'Pairing is not attached to a desktop connector');
    }
    if (!this.connectors.has(device.connectorId)) {
      throw new RelayError(503, 'desktop_offline', 'Desktop connector is offline');
    }
    const token = randomToken();
    const expiresAt = this.now() + this.webSessionTtlMs;
    this.webSessions.set(hashSecret(token), {
      deviceId: device.id,
      connectorId: device.connectorId,
      expiresAt,
    });
    return {
      cookie: `${this.cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(this.webSessionTtlMs / 1000)}; Secure; HttpOnly; SameSite=Strict`,
      expiresAt: new Date(expiresAt).toISOString(),
      deviceId: device.id,
    };
  }

  async proxyRequest(req, res) {
    const session = this.getWebSession(req);
    const connector = this.connectors.get(session.connectorId);
    if (!connector) throw new RelayError(503, 'desktop_offline', 'Desktop connector is offline');
    const body = await readRequestBody(req);
    const id = randomId('r_');
    const request = {
      id,
      connectorId: session.connectorId,
      response: res,
      started: false,
      finished: false,
      timer: null,
    };
    request.timer = setTimeout(() => {
      this.httpRequests.delete(id);
      if (!res.headersSent) sendJson(res, 504, { error: 'upstream_timeout', message: 'Desktop response timed out' });
      else res.destroy();
    }, HTTP_TIMEOUT_MS);
    this.httpRequests.set(id, request);
    res.once('close', () => {
      if (request.finished) return;
      this.httpRequests.delete(id);
      clearTimeout(request.timer);
      connector.sendJson({ type: 'http.cancel', id });
    });

    connector.sendJson({
      type: 'http.request',
      id,
      method: req.method,
      path: req.url || '/',
      headers: headerObject(req.headers),
      bodyBase64: body.length ? body.toString('base64') : null,
    });
  }

  // Long-lived SSE stream for a paired device: authenticates the short-lived
  // access token, then proxies the desktop orchestrator's /api/events stream
  // (via the device's connector) straight to the caller. The mobile app's
  // background service consumes this to raise a local notification when an
  // agent turn finishes. No fixed timeout — the caller ends it, or the
  // connector drop path (failConnectorRequests) destroys it.
  streamMobileEvents(req, res, accessToken) {
    const device = this.store.getDeviceForAccess({ accessToken });
    if (!device.connectorId) {
      throw new RelayError(503, 'connector_missing', 'Pairing is not attached to a desktop connector');
    }
    const connector = this.connectors.get(device.connectorId);
    if (!connector) {
      throw new RelayError(503, 'desktop_offline', 'Desktop connector is offline');
    }
    const id = randomId('r_');
    const request = {
      id,
      connectorId: device.connectorId,
      response: res,
      started: false,
      finished: false,
      timer: null,
    };
    this.httpRequests.set(id, request);
    res.once('close', () => {
      if (request.finished) return;
      this.httpRequests.delete(id);
      clearTimeout(request.timer);
      connector.sendJson({ type: 'http.cancel', id });
    });
    connector.sendJson({
      type: 'http.request',
      id,
      method: 'GET',
      path: '/api/events',
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache' },
      bodyBase64: null,
    });
    return { deviceId: device.id };
  }

  handleConnectorMessage(connection, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      connection.close(1003, 'JSON messages required');
      return;
    }

    if (message.type === 'connector.register') {
      try {
        this.registerConnector(connection, message.connectorId);
      } catch (error) {
        connection.close(4003, error.message);
      }
      return;
    }
    if (!connection.connectorId) {
      connection.close(4003, 'Connector must register first');
      return;
    }

    switch (message.type) {
      case 'http.response.start': {
        const watcher = this.eventWatcherFor(connection.connectorId, message.id);
        if (watcher) break; // SSE headers for the event watcher are ignored
        this.httpResponseStart(message);
        break;
      }
      case 'http.response.chunk': {
        const watcher = this.eventWatcherFor(connection.connectorId, message.id);
        if (watcher) {
          this.handleEventWatcherChunk(connection.connectorId, message.dataBase64);
        } else {
          this.httpResponseChunk(message);
        }
        break;
      }
      case 'http.response.end': {
        const watcher = this.eventWatcherFor(connection.connectorId, message.id);
        if (watcher) {
          this.eventWatchers.delete(connection.connectorId);
          this.scheduleEventWatcherRetry(connection.connectorId);
        } else {
          this.httpResponseEnd(message);
        }
        break;
      }
      case 'http.error':
        this.httpError(message);
        break;
      case 'connector.heartbeat':
        connection.sendJson({ type: 'connector.heartbeat.ack', at: message.at || null });
        break;
      case 'ws.ready':
        this.webSocketReady(message);
        break;
      case 'ws.message':
        this.webSocketMessage(message);
        break;
      case 'ws.close':
        this.webSocketClose(message);
        break;
      case 'ws.error':
        this.webSocketError(message);
        break;
      default:
        connection.sendJson({ type: 'relay.error', code: 'unknown_message', message: 'Unknown connector message' });
    }
  }

  getHttpRequest(message) {
    const request = this.httpRequests.get(String(message.id || ''));
    if (!request) return null;
    return request;
  }

  httpResponseStart(message) {
    const request = this.getHttpRequest(message);
    if (!request || request.started) return;
    const status = Number(message.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      this.httpError({ id: message.id, message: 'Invalid upstream status' });
      return;
    }
    request.started = true;
    request.response.writeHead(status, responseHeaders(message.headers));
    // Flush headers immediately so SSE/streaming callers receive response
    // status before first upstream chunk arrives.
    request.response.flushHeaders?.();
  }

  httpResponseChunk(message) {
    const request = this.getHttpRequest(message);
    if (!request || !request.started || request.finished) return;
    try {
      request.response.write(Buffer.from(String(message.dataBase64 || ''), 'base64'));
    } catch {
      this.httpError({ id: message.id, message: 'Invalid upstream chunk' });
    }
  }

  httpResponseEnd(message) {
    const request = this.getHttpRequest(message);
    if (!request || request.finished) return;
    request.finished = true;
    this.httpRequests.delete(request.id);
    clearTimeout(request.timer);
    if (!request.started) request.response.writeHead(204);
    request.response.end();
  }

  httpError(message) {
    const request = this.getHttpRequest(message);
    if (!request || request.finished) return;
    request.finished = true;
    this.httpRequests.delete(request.id);
    clearTimeout(request.timer);
    if (!request.response.headersSent) {
      sendJson(request.response, 502, { error: 'desktop_upstream_error', message: String(message.message || 'Desktop request failed') });
    } else {
      request.response.destroy();
    }
  }

  openMobileWebSocket(req, socket, head, session, protocol = null) {
    const connector = this.connectors.get(session.connectorId);
    if (!connector) {
      rejectUpgrade(socket, 503, 'Desktop connector offline');
      return;
    }
    const mobile = acceptUpgrade(req, socket, head, {
      protocol,
      allowedOrigin: this.allowedOrigin,
      maxFrameBytes: MAX_BODY_BYTES,
    });
    if (!mobile) return;

    const id = randomId('w_');
    const bridge = { id, connectorId: session.connectorId, mobile, connector };
    this.webSockets.set(id, bridge);
    mobile.on('message', (payload, isBinary) => {
      if (!this.webSockets.has(id)) return;
      connector.sendJson({
        type: 'ws.message',
        id,
        binary: Boolean(isBinary),
        dataBase64: Buffer.from(payload).toString('base64'),
      });
    });
    mobile.once('close', () => {
      this.webSockets.delete(id);
      connector.sendJson({ type: 'ws.close', id, code: 1000, reason: 'Mobile socket closed' });
    });
    connector.sendJson({
      type: 'ws.open',
      id,
      path: req.url || '/',
      headers: headerObject(req.headers),
    });
  }

  webSocketBridge(message) {
    return this.webSockets.get(String(message.id || ''));
  }

  webSocketReady(message) {
    const bridge = this.webSocketBridge(message);
    if (!bridge) return;
    bridge.ready = true;
  }

  webSocketMessage(message) {
    const bridge = this.webSocketBridge(message);
    if (!bridge || bridge.mobile.closed) return;
    const data = Buffer.from(String(message.dataBase64 || ''), 'base64');
    if (message.binary) bridge.mobile.sendBinary(data);
    else bridge.mobile.sendText(data.toString('utf8'));
  }

  webSocketClose(message) {
    const bridge = this.webSocketBridge(message);
    if (!bridge) return;
    this.webSockets.delete(bridge.id);
    bridge.mobile.close(Number(message.code) || 1000, String(message.reason || 'Desktop socket closed'));
  }

  webSocketError(message) {
    const bridge = this.webSocketBridge(message);
    if (!bridge) return;
    this.webSockets.delete(bridge.id);
    bridge.mobile.close(1011, 'Desktop WebSocket error');
  }

  close() {
    for (const connector of this.connectors.values()) connector.close(1001, 'Relay shutting down');
    for (const request of this.httpRequests.values()) {
      clearTimeout(request.timer);
      if (!request.response.writableEnded) request.response.destroy();
    }
    for (const bridge of this.webSockets.values()) bridge.mobile.close(1001, 'Relay shutting down');
    this.connectors.clear();
    this.httpRequests.clear();
    this.webSockets.clear();
  }
}

function createRelayServer(options = {}) {
  const hub = options.hub || new RelayHub(options);
  const requestHandler = (req, res) => {
    Promise.resolve()
      .then(async () => {
        const url = new URL(req.url || '/', 'http://relay.local');
        const pathname = url.pathname;
        const requestOptions = {
          requestOrigin: req.headers.origin,
          allowedOrigin: hub.allowedOrigin,
        };

        if (req.method === 'OPTIONS') {
          sendJson(res, 204, {}, requestOptions);
          return;
        }
        if (req.method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, {
            ok: true,
            service: 'freebuff-mobile-relay',
            protocolVersion: 1,
            connectors: hub.connectors.size,
          }, requestOptions);
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/relay/enroll') {
          hub.requireEnrollment(req);
          const body = await readJsonBody(req);
          const result = hub.enrollConnector(body.connectorId);
          sendJson(res, 201, result, requestOptions);
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/relay/refresh') {
          const body = await readJsonBody(req);
          const result = hub.refreshConnector({
            connectorId: body.connectorId,
            connectorRefreshToken: body.connectorRefreshToken,
          });
          sendJson(res, 200, result, requestOptions);
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/pairings') {
          const identity = hub.requireConnector(req);
          const body = await readJsonBody(req);
          if (identity.connectorId && body.connectorId && identity.connectorId !== body.connectorId) {
            throw new RelayError(403, 'connector_identity_mismatch', 'Connector token is bound to another connector id');
          }
          if (identity.connectorId && !body.connectorId) body.connectorId = identity.connectorId;
          const pairing = hub.createPairing(body);
          sendJson(res, 201, pairing, requestOptions);
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/pairings/claim') {
          const body = await readJsonBody(req);
          const result = hub.store.claim({
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
          sendJson(res, 200, hub.store.refresh({
            deviceId: body.deviceId,
            deviceToken: body.deviceToken,
          }), requestOptions);
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/mobile/session') {
          const session = hub.establishWebSession(bearerToken(req));
          sendJson(res, 200, {
            ok: true,
            deviceId: session.deviceId,
            expiresAt: session.expiresAt,
          }, { ...requestOptions, setCookie: session.cookie });
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/mobile/events') {
          // Streaming SSE; owns the response (no sendJson).
          hub.streamMobileEvents(req, res, bearerToken(req));
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/mobile/push-token') {
          const body = await readJsonBody(req);
          const device = hub.store.getDeviceForAccess({ accessToken: bearerToken(req) });
          hub.store.setPushToken(device.id, typeof body.token === 'string' ? body.token : '');
          sendJson(res, 200, { ok: true, deviceId: device.id }, requestOptions);
          return;
        }
        if (req.method === 'DELETE' && pathname === '/v1/mobile/push-token') {
          const device = hub.store.getDeviceForAccess({ accessToken: bearerToken(req) });
          hub.store.setPushToken(device.id, '');
          sendJson(res, 200, { ok: true, deviceId: device.id }, requestOptions);
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/devices') {
          hub.requireAdmin(req);
          sendJson(res, 200, { devices: hub.store.listDevices() }, requestOptions);
          return;
        }
        const revoke = pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
        if (req.method === 'POST' && revoke) {
          hub.requireAdmin(req);
          sendJson(res, 200, { device: hub.store.revoke(decodeURIComponent(revoke[1])) }, requestOptions);
          return;
        }

        if (pathname.startsWith('/v1/')) {
          throw new RelayError(404, 'not_found', 'Relay endpoint not found');
        }
        await hub.proxyRequest(req, res);
      })
      .catch((error) => failResponse(res, error));
  };
  const server = options.tls
    ? https.createServer(options.tls, requestHandler)
    : http.createServer(requestHandler);

  server.hub = hub;
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://relay.local');
    if (url.pathname === '/v1/relay/desktop') {
      const protocols = parseSubprotocols(req.headers['sec-websocket-protocol']);
      const authProtocol = protocols.find((value) => value.startsWith('auth-'));
      const token = authProtocol ? authProtocol.slice('auth-'.length) : '';
      const identity = hub.authenticateConnectorToken(token);
      if (!identity) {
        rejectUpgrade(socket, 401, 'Connector authorization required');
        return;
      }
      const connection = acceptUpgrade(req, socket, head, {
        protocol: protocols.includes('freebuff-relay-v1') ? 'freebuff-relay-v1' : null,
        allowedOrigin: hub.allowedOrigin,
        maxFrameBytes: MAX_BODY_BYTES,
      });
      if (!connection) return;
      connection.authenticatedConnectorId = identity.connectorId;
      connection.on('message', (payload) => hub.handleConnectorMessage(connection, payload));
      return;
    }

    if (url.pathname === '/v1/mobile/socket') {
      const protocols = parseSubprotocols(req.headers['sec-websocket-protocol']);
      const sessionProtocol = protocols.find((value) => value.startsWith('session-'));
      let session;
      try {
        session = hub.getWebSession(req, sessionProtocol ? sessionProtocol.slice('session-'.length) : null);
      } catch (error) {
        rejectUpgrade(socket, error.status || 401, error.message);
        return;
      }
      const protocol = protocols.includes('freebuff-mobile-v1') ? 'freebuff-mobile-v1' : null;
      hub.openMobileWebSocket(req, socket, head, session, protocol);
      return;
    }

    rejectUpgrade(socket, 404, 'WebSocket endpoint not found');
  });

  return server;
}

function parseArgs(argv) {
  const options = {
    host: process.env.FB_MOBILE_RELAY_HOST || DEFAULT_HOST,
    port: Number(process.env.FB_MOBILE_RELAY_PORT || DEFAULT_PORT),
    stateFile: process.env.FB_MOBILE_RELAY_STATE_FILE || DEFAULT_STATE_FILE,
    connectorStateFile: process.env.FB_MOBILE_RELAY_CONNECTOR_STATE_FILE || DEFAULT_CONNECTOR_STATE_FILE,
    connectorToken: process.env.FB_MOBILE_RELAY_CONNECTOR_TOKEN || null,
    enrollmentToken: process.env.FB_MOBILE_RELAY_ENROLLMENT_TOKEN || null,
    adminToken: process.env.FB_MOBILE_RELAY_ADMIN_TOKEN || null,
    publicHttpUrl: process.env.FB_MOBILE_RELAY_HTTP_URL || DEFAULT_HTTP_URL,
    publicWsUrl: process.env.FB_MOBILE_RELAY_WS_URL || DEFAULT_WS_URL,
    allowedOrigin: process.env.FB_MOBILE_RELAY_ALLOWED_ORIGIN || null,
    appUrl: process.env.FB_MOBILE_APP_URL || null,
    uiUrl: process.env.FB_MOBILE_UI_URL || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--host': options.host = next(); break;
      case '--port': options.port = Number(next()); break;
      case '--state-file': options.stateFile = next(); break;
      case '--connector-state-file': options.connectorStateFile = next(); break;
      case '--connector-token': options.connectorToken = next(); break;
      case '--enrollment-token': options.enrollmentToken = next(); break;
      case '--admin-token': options.adminToken = next(); break;
      case '--http-url': options.publicHttpUrl = next(); break;
      case '--ws-url': options.publicWsUrl = next(); break;
      case '--allowed-origin': options.allowedOrigin = next(); break;
      case '--app-url': options.appUrl = next(); break;
      case '--ui-url': options.uiUrl = next(); break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return options;
}

function usage() {
  console.log(`Freebuff managed mobile relay

Run:
  node src/mobile-connect-relay.js serve --enrollment-token <bootstrap-secret>

Required production settings:
  FB_MOBILE_RELAY_HTTP_URL           public HTTPS relay URL
  FB_MOBILE_RELAY_WS_URL             public WSS relay URL
  FB_MOBILE_RELAY_CONNECTOR_TOKEN    legacy shared connector secret (optional)
  FB_MOBILE_RELAY_ENROLLMENT_TOKEN   installer bootstrap secret
  FB_MOBILE_RELAY_CONNECTOR_STATE_FILE  hashed issued-credential state path
  FB_MOBILE_RELAY_ADMIN_TOKEN          device admin secret

The relay terminates WSS/TLS, provisions short-lived connector tokens through
/v1/relay/enroll, refreshes them through /v1/relay/refresh, exchanges access
tokens for Secure HttpOnly session cookies, and forwards browser
HTTP/SSE/WebSocket traffic to an outbound desktop connector. It is not
end-to-end encrypted from relay operators.`);
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  if (!options.connectorToken && !options.enrollmentToken) {
    throw new Error('FB_MOBILE_RELAY_CONNECTOR_TOKEN or FB_MOBILE_RELAY_ENROLLMENT_TOKEN is required');
  }
  if (!isLoopbackHostname(options.host) && !options.adminToken) {
    throw new Error('Refusing non-loopback relay bind without FB_MOBILE_RELAY_ADMIN_TOKEN');
  }
  const server = createRelayServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  console.log(`Managed relay listening on http://${options.host}:${address.port}`);
  console.log(`Public HTTP URL: ${server.hub.publicHttpUrl}`);
  console.log(`Public WS URL: ${server.hub.publicWsUrl}`);
  console.log(`State file: ${options.stateFile}`);
  await new Promise((resolve) => {
    const stop = () => {
      server.hub.close();
      server.close(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; },
  );
}

module.exports = {
  CONNECTOR_REFRESH_TTL_MS,
  CONNECTOR_TOKEN_TTL_MS,
  COOKIE_NAME,
  DEFAULT_CONNECTOR_STATE_FILE,
  DEFAULT_HTTP_URL,
  DEFAULT_PORT,
  DEFAULT_WS_URL,
  RelayError,
  RelayHub,
  createRelayServer,
  parseArgs,
  runCli,
};
