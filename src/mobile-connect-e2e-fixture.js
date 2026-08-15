'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { RelayAgent } = require('./mobile-connect-agent');
const { createRelayServer } = require('./mobile-connect-relay');

const DEFAULT_RELAY_PORT = 18495;
const DEFAULT_UPSTREAM_PORT = 18496;
const DEFAULT_EMULATOR_HOST = '10.0.2.2';
const DEFAULT_CONNECTOR_ID = 'ci-android-e2e';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function waitForConnector(relay, connectorId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!relay.hub.connectors.has(connectorId)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for desktop connector');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function createUpstreamServer() {
  return http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      const body = '<!doctype html><html><head><meta charset="utf-8"><title>Freebuff E2E Ready</title></head><body data-freebuff-e2e="ready">Freebuff E2E Ready</body></html>';
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });
}

async function startFixture(options = {}) {
  const relayPort = Number(options.relayPort || process.env.FB_MOBILE_E2E_RELAY_PORT || DEFAULT_RELAY_PORT);
  const upstreamPort = Number(options.upstreamPort || process.env.FB_MOBILE_E2E_UPSTREAM_PORT || DEFAULT_UPSTREAM_PORT);
  const emulatorHost = options.emulatorHost || process.env.FB_MOBILE_E2E_EMULATOR_HOST || DEFAULT_EMULATOR_HOST;
  const connectorId = options.connectorId || process.env.FB_MOBILE_E2E_CONNECTOR_ID || DEFAULT_CONNECTOR_ID;
  const connectorToken = options.connectorToken || process.env.FB_MOBILE_E2E_CONNECTOR_TOKEN || crypto.randomBytes(24).toString('base64url');
  const certificatePath = options.certificatePath || requiredEnv('FB_MOBILE_E2E_CERTIFICATE');
  const keyPath = options.keyPath || requiredEnv('FB_MOBILE_E2E_KEY');
  const pairingFile = options.pairingFile || requiredEnv('FB_MOBILE_E2E_PAIRING_FILE');
  const publicHttpUrl = `https://${emulatorHost}:${relayPort}`;
  const publicWsUrl = `wss://${emulatorHost}:${relayPort}`;
  const localHttpUrl = `https://127.0.0.1:${relayPort}`;
  const localWsUrl = `wss://127.0.0.1:${relayPort}`;
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  const stateFile = path.join(os.tmpdir(), `freebuff-mobile-e2e-agent-${process.pid}.json`);

  const upstream = createUpstreamServer();
  const relay = createRelayServer({
    tls: {
      cert: fs.readFileSync(certificatePath),
      key: fs.readFileSync(keyPath),
    },
    stateFile: null,
    connectorToken,
    publicHttpUrl,
    publicWsUrl,
    appUrl: `${publicHttpUrl}/pair`,
    uiUrl: publicHttpUrl,
  });
  let agent;
  let stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    agent?.stop();
    relay.hub.close();
    await Promise.all([
      new Promise((resolve) => relay.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    for (const file of [stateFile, pairingFile]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  try {
    await listen(upstream, upstreamPort, '127.0.0.1');
    await listen(relay, relayPort, '0.0.0.0');
    agent = new RelayAgent({
      stateFile,
      connectorToken,
      relayHttpUrl: localHttpUrl,
      relayWsUrl: localWsUrl,
      upstreamUrl,
      connectorId,
    });
    agent.start();
    await waitForConnector(relay, connectorId);
    const pairing = await agent.createPairing({
      appUrl: `${publicHttpUrl}/pair`,
      relayUrl: publicWsUrl,
      uiUrl: publicHttpUrl,
      // Emulator boot and APK installation can exceed one minute on hosted runners.
      ttlSeconds: 600,
    });
    fs.mkdirSync(path.dirname(pairingFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pairingFile, `${JSON.stringify({
      pairingUrl: pairing.pairingUrl,
      manualCode: pairing.manualCode,
      relayOrigin: publicHttpUrl,
      webOrigin: publicHttpUrl,
    })}\n`, { mode: 0o600 });
    return { pairing, publicHttpUrl, publicWsUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function main() {
  const fixture = await startFixture();
  let shuttingDown;
  const shutdown = () => {
    if (!shuttingDown) shuttingDown = fixture.stop().then(() => process.exit(0));
    return shuttingDown;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(`Android pairing fixture ready at ${fixture.publicHttpUrl}`);
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`E2E fixture failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CONNECTOR_ID,
  DEFAULT_EMULATOR_HOST,
  DEFAULT_RELAY_PORT,
  DEFAULT_UPSTREAM_PORT,
  createUpstreamServer,
  startFixture,
};
