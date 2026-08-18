'use strict';

/**
 * mobile-connect-live-fixture.js — reusable live-stack harness.
 *
 * Starts a throwaway relay in-process, spawns the real agent CLI
 * (`mobile-connect-agent.js serve`) and pairing CLI (`pair`) as child
 * processes, and exposes claim/cookie helpers. Shared by the live-trace tool
 * (`.tools/trace-pairing.js`) and the process-level e2e test
 * (`mobile-connect-live-fixture.test.js`) so both exercise the same CLI
 * environment wiring — connector id, state file, relay URLs — that the
 * in-process unit tests never touch.
 *
 * The agent CLI requires Node 22 (global WebSocket). Use hasWebSocket() to
 * skip cleanly under older Node.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelayServer } = require('./mobile-connect-relay');

function hasWebSocket() {
  return typeof WebSocket === 'function';
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** In-process relay on an ephemeral (or explicit) loopback port. */
async function startRelay(options = {}) {
  const token = options.token || randomToken();
  const port = options.port || 0;
  const server = createRelayServer({
    stateFile: options.stateFile === undefined ? null : options.stateFile,
    connectorToken: token,
    publicHttpUrl: `http://127.0.0.1:${port}`,
    publicWsUrl: `ws://127.0.0.1:${port}`,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  // Advertise the real port now that it is known (pairing URLs derive from
  // hub.publicHttpUrl at creation time).
  server.hub.publicHttpUrl = `http://127.0.0.1:${actualPort}`;
  server.hub.publicWsUrl = `ws://127.0.0.1:${actualPort}`;
  let stopped = false;
  return {
    port: actualPort,
    token,
    hub: server.hub,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    wsUrl: `ws://127.0.0.1:${actualPort}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      server.hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Spawn the real agent CLI in `serve` mode and wait for registration. */
async function startAgent(options = {}) {
  const relay = options.relay;
  const connectorId = options.connectorId || 'fixture-connector';
  const stateFile =
    options.stateFile ||
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-fixture-agent-')), 'agent.json');
  const env = {
    ...process.env,
    FB_MOBILE_RELAY_WS_URL: relay.wsUrl,
    FB_MOBILE_RELAY_HTTP_URL: relay.baseUrl,
    FB_MOBILE_RELAY_CONNECTOR_TOKEN: options.token || relay.token,
    FB_MOBILE_CONNECTOR_ID: connectorId,
    FB_MOBILE_AGENT_STATE_FILE: stateFile,
    FB_MOBILE_UI_URL: options.upstream || 'http://127.0.0.1:58061',
  };
  const child = childProcess.spawn(
    options.node || process.execPath,
    [path.join(__dirname, 'mobile-connect-agent.js'), 'serve'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  async function waitRegistered(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (!relay.hub.connectors.has(connectorId)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `agent ${connectorId} did not register${stderr ? `: ${stderr.trim()}` : ''}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return connectorId;
  }

  return {
    child,
    connectorId,
    stateFile,
    waitRegistered,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}

/**
 * Generate a QR pairing through the real agent `pair` CLI. MUST use the same
 * connector id (and ideally state file) as the serving agent, otherwise the
 * claimed device attaches to a phantom connector and sessions fail with
 * `desktop_offline`.
 */
async function createPairing(options = {}) {
  const relay = options.relay;
  const env = {
    ...process.env,
    FB_MOBILE_RELAY_WS_URL: relay.wsUrl,
    FB_MOBILE_RELAY_HTTP_URL: relay.baseUrl,
    FB_MOBILE_RELAY_CONNECTOR_TOKEN: options.token || relay.token,
    FB_MOBILE_CONNECTOR_ID: options.connectorId || 'fixture-connector',
    FB_MOBILE_AGENT_STATE_FILE:
      options.stateFile ||
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-fixture-pair-')), 'pair.json'),
  };
  // Async spawn: the harness hosts the relay in-process, so a blocking
  // spawnSync would freeze the relay's event loop and the pair request would
  // time out.
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      options.node || process.execPath,
      [path.join(__dirname, 'mobile-connect-agent.js'), 'pair', '--json', '--no-qr', '--ttl', String(options.ttlSeconds || 600)],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`pair CLI failed: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        const pairing = JSON.parse(stdout);
        if (!pairing.pairingUrl || !pairing.pairingId) {
          reject(new Error('pair CLI returned no pairingUrl'));
          return;
        }
        const params = new URLSearchParams(pairing.pairingUrl.split('#')[1]);
        resolve({
          ...pairing,
          pairingId: params.get('pairingId'),
          pairingToken: params.get('token'),
        });
      } catch (error) {
        reject(new Error(`pair CLI returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function claimPairing(baseUrl, pairing, options = {}) {
  const response = await fetch(`${baseUrl}/v1/pairings/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingId: pairing.pairingId,
      token: pairing.pairingToken,
      deviceName: options.deviceName || 'Fixture phone',
      devicePublicKey: options.devicePublicKey || 'ed25519:fixture',
    }),
  });
  const claim = await response.json();
  if (!response.ok || !claim.accessToken) {
    throw new Error(`claim failed: HTTP ${response.status} ${JSON.stringify(claim)}`);
  }
  return claim;
}

/**
 * Exchange the claim access token for the HttpOnly session cookie.
 * Returns `{ value, raw }`: `value` is the `name=value` pair usable as a
 * request `cookie` header; `raw` is the full Set-Cookie header (carries the
 * HttpOnly/Secure/Path attributes).
 */
async function fetchSessionCookie(baseUrl, accessToken) {
  const response = await fetch(`${baseUrl}/v1/mobile/session`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`session failed: HTTP ${response.status}`);
  const raw = response.headers.get('set-cookie');
  if (!raw) throw new Error('session response carried no set-cookie');
  return { value: raw.split(';', 1)[0], raw };
}

module.exports = {
  claimPairing,
  createPairing,
  fetchSessionCookie,
  hasWebSocket,
  randomToken,
  startAgent,
  startRelay,
};
