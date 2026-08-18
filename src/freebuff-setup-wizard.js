'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

function createSetupController({ inspect, execute } = {}) {
  if (typeof inspect !== 'function') throw new TypeError('inspect callback is required');
  if (typeof execute !== 'function') throw new TypeError('execute callback is required');
  let snapshot = null;
  let state = { phase: 'idle', message: 'Waiting to inspect this Desktop.' };

  function getState() {
    return state;
  }

  async function refresh() {
    state = { phase: 'detecting', message: 'Checking Freebuff Desktop…' };
    try {
      const result = await inspect();
      const actions = Array.isArray(result.actions) ? result.actions : [];
      snapshot = { ...result, actions };
      state = {
        phase: result.phase || (actions.length > 0 ? 'action-needed' : 'ready'),
        message: result.message || (actions.length > 0 ? 'Setup actions are ready.' : 'Freebuff Desktop is ready.'),
        report: result.report ?? null,
        actions: actions.map(({ id, description }) => ({ id, description })),
        ...(result.hosted === undefined ? {} : { hosted: result.hosted }),
      };
    } catch (error) {
      state = { phase: 'error', message: error.message };
    }
    return state;
  }

  async function run(actionId) {
    const action = snapshot?.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error(`unknown setup action: ${actionId}`);
    state = {
      ...state,
      phase: 'working',
      message: action.description,
    };
    try {
      await execute(action, snapshot);
    } catch (error) {
      state = { phase: 'error', message: error.message, report: snapshot.report ?? null };
      throw error;
    }
    return refresh();
  }

  return { getState, refresh, run };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function renderWizardHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="session-nonce" content="${nonce}">
  <title>Freebuff Setup</title>
  <style>
    :root { color-scheme: light dark; font: 16px system-ui, sans-serif; }
    body { max-width: 720px; margin: 3rem auto; padding: 0 1rem; }
    button { font: inherit; margin: .25rem .5rem .25rem 0; padding: .55rem .8rem; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1rem; border: 1px solid #8886; border-radius: .5rem; }
    .muted { opacity: .75; }
  </style>
</head>
<body data-session-nonce="${nonce}">
  <h1>Freebuff Setup</h1>
  <p class="muted">Preparing local Desktop companion setup.</p>
  <pre id="state" aria-live="polite">Loading…</pre>
  <button type="button" data-action="refresh">Check status</button>
  <button type="button" data-action="upgrade">Apply setup</button>
  <button type="button" data-action="advanced">Use advanced setup</button>
  <button type="button" data-action="close">Exit</button>
  <script>
    const nonce = document.body.dataset.sessionNonce;
    const state = document.querySelector('#state');
    function updateButtons(value) {
      const actions = new Set((value && value.actions || []).map((item) => item.id));
      document.querySelectorAll('[data-action]').forEach((button) => {
        const action = button.dataset.action;
        button.disabled = !['refresh', 'close'].includes(action) && !actions.has(action);
      });
    }
    async function showState() {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const value = await response.json();
      updateButtons(value);
      state.textContent = JSON.stringify(value, null, 2);
    }
    async function run(action) {
      state.textContent = 'Working…';
      if (action === 'close') {
        const response = await fetch('/api/close', {
          method: 'POST',
          headers: { 'x-freebuff-setup-nonce': nonce },
        });
        const value = await response.json();
        updateButtons(value);
        state.textContent = JSON.stringify(value, null, 2);
        return;
      }
      const response = await fetch('/api/' + (action === 'refresh' ? 'refresh' : 'action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-freebuff-setup-nonce': nonce },
        body: action === 'refresh' ? '{}' : JSON.stringify({ action }),
      });
      const value = await response.json();
      updateButtons(value);
      state.textContent = JSON.stringify(value, null, 2);
    }
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => run(button.dataset.action).catch((error) => {
        state.textContent = JSON.stringify({ phase: 'error', message: error.message }, null, 2);
      }));
    });
    showState().catch((error) => { state.textContent = error.message; });
  </script>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeState(controller) {
  return typeof controller.getState === 'function' ? controller.getState() : controller.state;
}

function nonceMatches(expected, provided) {
  if (typeof provided !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createWizardServer({
  controller,
  host = '127.0.0.1',
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  sessionNonce = crypto.randomBytes(18).toString('base64url'),
  onClose = null,
} = {}) {
  if (!controller || typeof controller !== 'object') throw new TypeError('controller is required');
  let lastActivity = Date.now();

  function expired() {
    return Date.now() - lastActivity > sessionTtlMs;
  }

  function touch() {
    lastActivity = Date.now();
  }

  function requireNonce(req, res) {
    if (expired()) {
      json(res, 410, { error: 'setup_session_expired' });
      return false;
    }
    if (!nonceMatches(sessionNonce, req.headers['x-freebuff-setup-nonce'])) {
      json(res, 403, { error: 'setup_session_forbidden' });
      return false;
    }
    touch();
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        touch();
        text(res, 200, renderWizardHtml(sessionNonce), 'text/html; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { ok: !expired() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (expired()) {
          json(res, 410, { error: 'setup_session_expired' });
          return;
        }
        touch();
        json(res, 200, await safeState(controller));
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/api/refresh' || url.pathname === '/api/action' || url.pathname === '/api/close')) {
        if (!requireNonce(req, res)) return;
        if (url.pathname === '/api/close') {
          json(res, 200, { ok: true });
          if (typeof onClose === 'function') setImmediate(onClose);
          return;
        }
        let payload = {};
        try {
          const body = await readBody(req);
          if (body) payload = JSON.parse(body);
        } catch (error) {
          json(res, 400, { error: 'invalid_json', message: error.message });
          return;
        }
        if (url.pathname === '/api/refresh') {
          json(res, 200, await controller.refresh());
          return;
        }
        if (typeof payload.action !== 'string' || !/^[a-z0-9_-]+$/.test(payload.action)) {
          json(res, 400, { error: 'invalid_action' });
          return;
        }
        try {
          json(res, 200, await controller.run(payload.action));
        } catch (error) {
          json(res, 422, { error: 'setup_action_failed', message: error.message });
        }
        return;
      }
      text(res, 404, 'Not found\n');
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: 'setup_server_error', message: error.message });
      else res.destroy(error);
    }
  });
  server.setupSessionNonce = sessionNonce;
  server.setupHost = host;
  return server;
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  MAX_BODY_BYTES,
  createSetupController,
  createWizardServer,
  renderWizardHtml,
};
