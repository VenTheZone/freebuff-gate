'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const { renderQrText } = require('./mobile-connect-qr');
const {
  isLoopbackHostname,
  randomId,
} = require('./mobile-connect-protocol');

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:58061';
const DEFAULT_RELAY_HTTP_URL = 'https://mobile.example.invalid';
const DEFAULT_RELAY_WS_URL = 'wss://mobile.example.invalid';
const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  '.config',
  'freebuff',
  'mobile-connect-agent.json',
);
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
const RETRY_MAX_MS = 60_000;
const CONNECTOR_REFRESH_SKEW_MS = 60_000;

function normalizeHttpUrl(raw) {
  const parsed = new URL(String(raw));
  const local = isLoopbackHostname(parsed.hostname);
  if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !local)) {
    throw new Error('Upstream URL must use HTTPS (HTTP is allowed only for localhost)');
  }
  if (parsed.username || parsed.password) throw new Error('Upstream URL must not contain credentials');
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function toWsUrl(raw) {
  const parsed = new URL(String(raw));
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (!['wss:', 'ws:'].includes(parsed.protocol)) throw new Error('Relay URL must use HTTPS/WSS');
  if (parsed.protocol === 'ws:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('Unencrypted WS is allowed only for localhost development');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read agent state: ${error.message}`);
  }
}

function parseTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeJsonFile(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  try {
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function requestJson(target, options = {}) {
  const parsed = new URL(target);
  const transport = parsed.protocol === 'https:' ? https : http;
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
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ status: response.statusCode || 0, data });
      });
    });
    request.on('timeout', () => request.destroy(new Error('relay request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function filterUpstreamHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'accept-encoding' ||
      lower === 'sec-websocket-accept' ||
      lower === 'sec-websocket-key' ||
      lower === 'sec-websocket-protocol'
    ) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return result;
}

function responseHeaderObject(headers) {
  const result = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length' || lower === 'content-encoding') continue;
    result[name] = value;
  }
  return result;
}

class RelayAgent {
  constructor(options = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('Node WebSocket client unavailable; use Node 22 or add a supported WebSocket runtime');
    }
    this.connectorCredentialFile = options.connectorCredentialFile || process.env.FB_MOBILE_RELAY_CONNECTOR_CREDENTIAL_FILE || null;
    const credentials = this.connectorCredentialFile ? readJsonFile(this.connectorCredentialFile) : {};
    this.connectorToken = options.connectorToken || process.env.FB_MOBILE_RELAY_CONNECTOR_TOKEN || credentials.connectorToken || null;
    this.connectorRefreshToken = options.connectorRefreshToken || process.env.FB_MOBILE_RELAY_CONNECTOR_REFRESH_TOKEN || credentials.connectorRefreshToken || null;
    this.connectorTokenExpiresAt = parseTimestamp(
      options.connectorTokenExpiresAt || process.env.FB_MOBILE_RELAY_CONNECTOR_TOKEN_EXPIRES_AT || credentials.connectorTokenExpiresAt,
    );
    if (!this.connectorToken && !this.connectorRefreshToken) {
      throw new Error('FB_MOBILE_RELAY_CONNECTOR_TOKEN or provisioned connector credentials are required');
    }
    this.relayHttpUrl = normalizeHttpUrl(options.relayHttpUrl || process.env.FB_MOBILE_RELAY_HTTP_URL || DEFAULT_RELAY_HTTP_URL);
    this.relayWsUrl = toWsUrl(options.relayWsUrl || process.env.FB_MOBILE_RELAY_WS_URL || this.relayHttpUrl);
    this.upstreamUrl = normalizeHttpUrl(options.upstreamUrl || process.env.FB_MOBILE_UI_URL || DEFAULT_UPSTREAM_URL);
    this.stateFile = options.stateFile || process.env.FB_MOBILE_AGENT_STATE_FILE || DEFAULT_STATE_FILE;
    const state = readJsonFile(this.stateFile);
    this.connectorId = options.connectorId || process.env.FB_MOBILE_CONNECTOR_ID || credentials.connectorId || state.connectorId || randomId('c_');
    if (!state.connectorId || state.connectorId !== this.connectorId) writeJsonFile(this.stateFile, { connectorId: this.connectorId });
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.socket = null;
    this.manualStop = false;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.refreshInFlight = null;
    this.upstreamSockets = new Map();
    this.httpControllers = new Map();
  }

  start() {
    this.manualStop = false;
    this.connect();
  }

  stop() {
    this.manualStop = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
    for (const controller of this.httpControllers.values()) controller.abort();
    this.httpControllers.clear();
    for (const socket of this.upstreamSockets.values()) socket.close();
    this.upstreamSockets.clear();
    if (this.socket) this.socket.close(1000, 'Agent stopped');
    this.socket = null;
  }

  needsConnectorRefresh() {
    return !this.connectorToken || (
      this.connectorTokenExpiresAt > 0 &&
      this.connectorTokenExpiresAt - Date.now() <= CONNECTOR_REFRESH_SKEW_MS
    );
  }

  persistConnectorCredentials() {
    if (!this.connectorCredentialFile) return;
    const existing = readJsonFile(this.connectorCredentialFile);
    writeJsonFile(this.connectorCredentialFile, {
      ...existing,
      connectorId: this.connectorId,
      connectorToken: this.connectorToken,
      connectorRefreshToken: this.connectorRefreshToken,
      connectorTokenExpiresAt: new Date(this.connectorTokenExpiresAt).toISOString(),
    });
  }

  async refreshConnectorToken() {
    if (!this.connectorRefreshToken) throw new Error('Provisioned connector refresh credential is missing');
    const result = await requestJson(`${this.relayHttpUrl}/v1/relay/refresh`, {
      method: 'POST',
      body: {
        connectorId: this.connectorId,
        connectorRefreshToken: this.connectorRefreshToken,
      },
    });
    if (result.status >= 400) {
      throw new Error(result.data?.message || `Relay returned HTTP ${result.status}`);
    }
    const token = String(result.data?.connectorToken || '');
    const expiresAt = parseTimestamp(result.data?.connectorTokenExpiresAt);
    if (!token || !expiresAt) throw new Error('Relay returned incomplete connector credentials');
    this.connectorToken = token;
    this.connectorTokenExpiresAt = expiresAt;
    this.persistConnectorCredentials();
    this.logger('connector_token_refreshed', { connectorId: this.connectorId });
  }

  async ensureConnectorCredential() {
    if (!this.needsConnectorRefresh()) return;
    await this.refreshConnectorToken();
  }

  startConnectorRefresh(reconnect) {
    if (this.refreshInFlight || !this.connectorRefreshToken) return;
    this.refreshInFlight = this.refreshConnectorToken()
      .then(() => {
        if (reconnect && !this.manualStop) this.connect();
      })
      .catch((error) => {
        this.logger('connector_token_refresh_error', { message: error.message });
        if (reconnect && !this.manualStop) this.scheduleReconnect();
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  connect() {
    if (this.manualStop || this.socket) return;
    if (this.needsConnectorRefresh()) {
      if (!this.connectorRefreshToken) {
        this.logger('connector_refresh_missing', { connectorId: this.connectorId });
        this.scheduleReconnect();
        return;
      }
      this.startConnectorRefresh(true);
      return;
    }
    if (!this.connectorToken) {
      this.logger('connector_token_missing', { connectorId: this.connectorId });
      this.scheduleReconnect();
      return;
    }
    const url = `${this.relayWsUrl}/v1/relay/desktop`;
    let socket;
    try {
      socket = new WebSocket(url, ['freebuff-relay-v1', `auth-${this.connectorToken}`]);
    } catch (error) {
      this.logger('connect_error', { message: error.message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.retryAttempt = 0;
      this.sendJson({ type: 'connector.register', connectorId: this.connectorId, protocolVersion: 1 });
      this.heartbeatTimer = setInterval(() => {
        if (this.needsConnectorRefresh()) this.startConnectorRefresh(false);
        this.sendJson({ type: 'connector.heartbeat', at: Date.now() });
      }, 20_000);
      this.logger('connected', { connectorId: this.connectorId });
    });
    socket.addEventListener('message', (event) => this.handleRelayMessage(event.data));
    socket.addEventListener('error', () => this.logger('socket_error', { connectorId: this.connectorId }));
    socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;
      this.logger('disconnected', { connectorId: this.connectorId });
      if (!this.manualStop) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.manualStop || this.retryTimer) return;
    const base = Math.min(RETRY_MAX_MS, 1_000 * (2 ** Math.min(this.retryAttempt, 6)));
    const delay = Math.max(250, Math.round(base * (0.8 + Math.random() * 0.4)));
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  sendJson(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async handleRelayMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      this.stop();
      return;
    }
    switch (message.type) {
      case 'connector.ready':
      case 'connector.heartbeat.ack':
        this.logger(message.type, { connectorId: this.connectorId });
        break;
      case 'http.request':
        await this.handleHttpRequest(message);
        break;
      case 'http.cancel':
        this.httpControllers.get(String(message.id || ''))?.abort();
        break;
      case 'ws.open':
        this.openUpstreamWebSocket(message);
        break;
      case 'ws.message':
        this.sendUpstreamWebSocketMessage(message);
        break;
      case 'ws.close':
        this.closeUpstreamWebSocket(message);
        break;
      default:
        this.logger('unknown_relay_message', { type: message.type });
    }
  }

  async handleHttpRequest(message) {
    const id = String(message.id || '');
    if (!id) return;
    const controller = new AbortController();
    this.httpControllers.set(id, controller);
    try {
      const target = new URL(String(message.path || '/'), `${this.upstreamUrl}/`);
      const method = String(message.method || 'GET').toUpperCase();
      const body = message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64') : null;
      const init = {
        method,
        headers: filterUpstreamHeaders(message.headers),
        redirect: 'manual',
        signal: controller.signal,
      };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body;
      const response = await fetch(target, init);
      this.sendJson({
        type: 'http.response.start',
        id,
        status: response.status,
        headers: responseHeaderObject(response.headers),
      });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.sendJson({
            type: 'http.response.chunk',
            id,
            dataBase64: Buffer.from(value).toString('base64'),
          });
        }
      }
      this.sendJson({ type: 'http.response.end', id });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.sendJson({ type: 'http.error', id, message: error.message || 'Upstream request failed' });
      }
    } finally {
      this.httpControllers.delete(id);
    }
  }

  openUpstreamWebSocket(message) {
    const id = String(message.id || '');
    if (!id || this.upstreamSockets.has(id)) return;
    const target = new URL(String(message.path || '/'), `${this.upstreamUrl}/`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(target.toString());
    } catch (error) {
      this.sendJson({ type: 'ws.error', id, message: error.message });
      return;
    }
    this.upstreamSockets.set(id, socket);
    socket.addEventListener('open', () => this.sendJson({ type: 'ws.ready', id }));
    socket.addEventListener('message', async (event) => {
      const data = await messageDataBuffer(event.data);
      this.sendJson({
        type: 'ws.message',
        id,
        binary: typeof event.data !== 'string',
        dataBase64: data.toString('base64'),
      });
    });
    socket.addEventListener('error', () => this.sendJson({ type: 'ws.error', id, message: 'Upstream WebSocket error' }));
    socket.addEventListener('close', (event) => {
      this.upstreamSockets.delete(id);
      this.sendJson({ type: 'ws.close', id, code: event.code || 1000, reason: event.reason || '' });
    });
  }

  async sendUpstreamWebSocketMessage(message) {
    const socket = this.upstreamSockets.get(String(message.id || ''));
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const data = Buffer.from(String(message.dataBase64 || ''), 'base64');
    socket.send(message.binary ? data : data.toString('utf8'));
  }

  closeUpstreamWebSocket(message) {
    const socket = this.upstreamSockets.get(String(message.id || ''));
    if (!socket) return;
    socket.close(Number(message.code) || 1000, String(message.reason || 'Relay closed socket'));
    this.upstreamSockets.delete(String(message.id || ''));
  }

  async createPairing(options = {}) {
    const result = await requestJson(`${this.relayHttpUrl}/v1/pairings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.connectorToken}` },
      body: {
        connectorId: this.connectorId,
        appUrl: options.appUrl || process.env.FB_MOBILE_APP_URL || `${this.relayHttpUrl}/pair`,
        relayUrl: options.relayUrl || this.relayWsUrl,
        uiUrl: options.uiUrl || process.env.FB_MOBILE_UI_URL || this.relayHttpUrl,
        ttlSeconds: options.ttlSeconds || 600,
      },
    });
    if (result.status >= 400) throw new Error(result.data?.message || `Relay returned HTTP ${result.status}`);
    return result.data;
  }
}

function messageDataBuffer(data) {
  if (typeof data === 'string') return Promise.resolve(Buffer.from(data, 'utf8'));
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data));
  if (Buffer.isBuffer(data)) return Promise.resolve(data);
  if (data && typeof data.arrayBuffer === 'function') return data.arrayBuffer().then((value) => Buffer.from(value));
  return Promise.resolve(Buffer.from(String(data ?? ''), 'utf8'));
}

function usage() {
  console.log(`Freebuff mobile desktop relay agent

Commands:
  serve       Keep outbound WSS connector online
  pair        Create pairing URL/code through managed relay

Examples:
  node src/mobile-connect-agent.js serve
  node src/mobile-connect-agent.js pair --ttl 600
  node src/mobile-connect-agent.js pair --no-qr

Environment:
  FB_MOBILE_RELAY_HTTP_URL       Managed relay HTTPS URL
  FB_MOBILE_RELAY_WS_URL         Managed relay WSS URL
  FB_MOBILE_RELAY_CONNECTOR_TOKEN  Connector token (installer can provision it)
  FB_MOBILE_RELAY_CONNECTOR_CREDENTIAL_FILE  Protected provisioned credential file
  FB_MOBILE_RELAY_CONNECTOR_REFRESH_TOKEN  Provisioned refresh token override
  FB_MOBILE_RELAY_CONNECTOR_TOKEN_EXPIRES_AT  Provisioned token expiry override
  FB_MOBILE_UI_URL               Local Freebuff UI upstream URL
  FB_MOBILE_CONNECTOR_ID         Optional stable connector id
`);
}

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = {
    command: command === '--help' || command === '-h' ? 'help' : command,
    relayHttpUrl: process.env.FB_MOBILE_RELAY_HTTP_URL || DEFAULT_RELAY_HTTP_URL,
    relayWsUrl: process.env.FB_MOBILE_RELAY_WS_URL || null,
    connectorToken: process.env.FB_MOBILE_RELAY_CONNECTOR_TOKEN || null,
    connectorCredentialFile: process.env.FB_MOBILE_RELAY_CONNECTOR_CREDENTIAL_FILE || null,
    upstreamUrl: process.env.FB_MOBILE_UI_URL || DEFAULT_UPSTREAM_URL,
    connectorId: process.env.FB_MOBILE_CONNECTOR_ID || null,
    stateFile: process.env.FB_MOBILE_AGENT_STATE_FILE || DEFAULT_STATE_FILE,
    appUrl: process.env.FB_MOBILE_APP_URL || null,
    uiUrl: process.env.FB_MOBILE_UI_URL || null,
    ttlSeconds: 600,
    json: false,
    qr: true,
    help: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--relay-http-url': options.relayHttpUrl = next(); break;
      case '--relay-ws-url': options.relayWsUrl = next(); break;
      case '--connector-token': options.connectorToken = next(); break;
      case '--connector-credential-file': options.connectorCredentialFile = next(); break;
      case '--upstream-url': options.upstreamUrl = next(); break;
      case '--connector-id': options.connectorId = next(); break;
      case '--state-file': options.stateFile = next(); break;
      case '--app-url': options.appUrl = next(); break;
      case '--ui-url': options.uiUrl = next(); break;
      case '--ttl': options.ttlSeconds = Number(next()); break;
      case '--json': options.json = true; break;
      case '--no-qr': options.qr = false; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help || options.command === 'help') {
    usage();
    return 0;
  }
  const agent = new RelayAgent(options);
  if (options.command === 'pair') {
    await agent.ensureConnectorCredential();
    const pairing = await agent.createPairing({
      appUrl: options.appUrl || undefined,
      relayUrl: options.relayWsUrl || undefined,
      uiUrl: options.uiUrl || undefined,
      ttlSeconds: options.ttlSeconds,
    });
    if (options.json) console.log(JSON.stringify(pairing, null, 2));
    else {
      if (options.qr) console.log(renderQrText(pairing.pairingUrl));
      console.log('Pairing ready. Scan QR above or use URL in Freebuff Android app:');
      console.log(pairing.pairingUrl);
      console.log(`Manual confirmation code: ${pairing.manualCode}`);
      console.log(`Expires: ${pairing.expiresAt}`);
    }
    return 0;
  }
  if (options.command !== 'serve') throw new Error(`Unknown command: ${options.command}`);
  agent.start();
  console.log(`Desktop relay agent started: ${agent.connectorId}`);
  console.log(`Upstream UI: ${agent.upstreamUrl}`);
  await new Promise((resolve) => {
    const stop = () => { agent.stop(); resolve(); };
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
  DEFAULT_RELAY_HTTP_URL,
  DEFAULT_RELAY_WS_URL,
  CONNECTOR_REFRESH_SKEW_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_UPSTREAM_URL,
  RelayAgent,
  messageDataBuffer,
  normalizeHttpUrl,
  parseArgs,
  requestJson,
  runCli,
};
