#!/usr/bin/env node
/*
 * freebuff_tailnet_proxy.js — Freebuff Desktop browser-port proxy.
 *
 * Listens on 127.0.0.1:58061 and proxies to the desktop orchestrator UI
 * (127.0.0.1:58060). Rewrites Host/Origin so the UI treats the proxy as
 * same-origin, injects the `window.freebuffDesktop` shim plus the repo's
 * mobile adaptation (src/mobile-ui.css / src/mobile-ui.js, read fresh per
 * request) into HTML pages, and passes SSE and WebSocket traffic through.
 *
 * Upstream defaults to 127.0.0.1:58060; override with FREEBUFF_UPSTREAM.
 * Port defaults to 58061; override with FREEBUFF_PROXY_PORT.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const UPSTREAM = process.env.FREEBUFF_UPSTREAM || 'http://127.0.0.1:58060';
const PORT = Number(process.env.FREEBUFF_PROXY_PORT || 58061);
const up = new URL(UPSTREAM);

const REPO = '/home/admin/FB-Browser-UI/src';
const MOBILE_CSS_PATH = path.join(REPO, 'mobile-ui.css');
const MOBILE_JS_PATH = path.join(REPO, 'mobile-ui.js');

// ---- window.freebuffDesktop shim (browser fallbacks for the Electron preload bridge) ----
const SHIM = `(function () {
  if (window.freebuffDesktop) return;
  var virtualPick = function () {
    return new Promise(function (resolve) {
      if (window.showDirectoryPicker) {
        window.showDirectoryPicker({ id: 'fb-workspace', mode: 'readwrite' })
          .then(function (h) { resolve('workspace://' + h.name); })
          .catch(function () { resolve(null); });
        return;
      }
      var input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('webkitdirectory', '');
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var name = null;
        if (input.files && input.files.length) {
          var rel = input.files[0].webkitRelativePath;
          name = rel ? rel.split('/')[0] : input.files[0].name;
        }
        document.body.removeChild(input);
        resolve(name ? 'workspace://' + name : null);
      });
      document.body.appendChild(input);
      input.click();
    });
  };
  window.freebuffDesktop = {
    platform: 'browser',
    pickDirectory: virtualPick,
    onMenuCommand: function () {},
    onTheme: function () {},
    onWindowStateChange: function () {},
    tabContextMenu: function () {},
    reportBusy: function () {},
    revealChange: function () {},
    updateAction: function () {},
    customTitleBar: function () {},
    setTheme: function () {},
    detectOpenTargets: function () { return Promise.resolve([]); },
    openIn: function (target) { if (target && target.url) window.open(target.url, '_blank', 'noopener'); },
    updateAction: function () { return Promise.resolve(); },
    windowState: function () { return Promise.resolve({ fullScreen: false, maximized: false, state: 'normal' }); }
    // openExternal and readImage intentionally absent: the UI's guards fall
    // through to window.open / the "failed" path in a browser.
  };
})();`;

function mobileTag(type) {
  try {
    const body = fs.readFileSync(type === 'css' ? MOBILE_CSS_PATH : MOBILE_JS_PATH, 'utf8');
    return type === 'css'
      ? `<style id="fb-mobile-ui">${body}</style>`
      : `<script id="fb-mobile-ui">${body}<\/script>`;
  } catch (e) {
    return '';
  }
}

function injectInto(html) {
  const inject = mobileTag('css') + mobileTag('js') + `<script id="fb-desktop-shim">${SHIM}<\/script>`;
  if (html.includes('</head>')) return html.replace('</head>', inject + '</head>');
  return inject + html;
}

// ---- Bundle patch: stop the boot-time empty-thread auto-create ----
// The packaged UI's boot hook calls wy({pickProject:!1,home:!0}) on every
// page load to open the home screen. That routes into the store's
// openTab(path, threadId, home), which ALWAYS calls ve.createThread() even
// when a home tab already exists — orphaning an empty "New thread" in the
// DB on every load (and its re-armed guard makes it 2-3 per load). The
// proxy is the one layer we control that sees every browser-port load, so
// patch openTab's home branch to reuse an existing tab instead of creating
// a new thread: prefer the existing home tab, else fall back to the
// leftmost restored tab (persisted tabs lose their home flag, so a fresh
// load otherwise re-opens home as a brand-new tab every time). The reused
// branch must return the FULL thread object from the store (not just its
// id): openTab wraps whatever the callback returns into the threads map,
// and a bare {id} stub replaces the real thread and crashes the thread
// view (e.deliveries.at(-1)). First ever boot (no tabs at all) still
// creates the initial home thread; user-initiated new threads (the
// .tab-new button / "New session" menu) pass home=false and are untouched.
const CREATE_MARK =
  'lr(t,()=>ve.createThread(n,{inheritFromThreadId:i}),"Could not open tab")';
const CREATE_REUSE =
  'lr(t,()=>{const hb=r&&(G.getState().tabs.find(h=>h.home)||G.getState().tabs[0]),th=hb&&G.getState().threads[hb.id]&&G.getState().threads[hb.id].thread;return th||ve.createThread(n,{inheritFromThreadId:i})},"Could not open tab")';

function patchBundle(body) {
  if (!body.includes(CREATE_MARK)) return body;
  return body.split(CREATE_MARK).join(CREATE_REUSE);
}

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  headers.host = up.host;
  if (headers.origin) {
    try { headers.origin = up.origin; } catch (e) { /* keep as-is */ }
  }
  headers['accept-encoding'] = 'identity';
  const preq = http.request({
    host: up.hostname,
    port: up.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, (pres) => {
    const type = String(pres.headers['content-type'] || '');
    if (type.includes('text/html')) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const out = injectInto(body);
        const outHeaders = { ...pres.headers };
        outHeaders['content-length'] = Buffer.byteLength(out);
        res.writeHead(pres.statusCode || 200, outHeaders);
        res.end(out);
      });
      pres.on('error', () => res.destroy());
      return;
    }
    if (type.includes('javascript')) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const out = patchBundle(body);
        const outHeaders = { ...pres.headers };
        outHeaders['content-length'] = Buffer.byteLength(out);
        res.writeHead(pres.statusCode || 200, outHeaders);
        res.end(out);
      });
      pres.on('error', () => res.destroy());
      return;
    }
    res.writeHead(pres.statusCode || 200, pres.headers);
    pres.pipe(res);
    pres.on('error', () => res.destroy());
  });
  preq.on('error', () => res.destroy());
  req.pipe(preq);
});

server.on('upgrade', (req, socket, head) => {
  const headers = { ...req.headers };
  headers.host = up.host;
  if (headers.origin) {
    try { headers.origin = up.origin; } catch (e) { /* keep as-is */ }
  }
  const preq = http.request({
    host: up.hostname,
    port: up.port || 80,
    method: 'GET',
    path: req.url,
    headers,
  });
  preq.on('upgrade', (pres, usock, uhead) => {
    if ((pres.statusCode || 0) !== 101) {
      socket.destroy();
      usock.destroy();
      return;
    }
    let headStr = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < pres.rawHeaders.length; i += 2) {
      headStr += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    }
    socket.write(headStr + '\r\n');
    if (head && head.length) usock.write(head);
    if (uhead && uhead.length) socket.write(uhead);
    usock.pipe(socket);
    socket.pipe(usock);
    usock.on('error', () => socket.destroy());
    socket.on('error', () => usock.destroy());
  });
  preq.on('error', () => socket.destroy());
  preq.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`freebuff tailnet proxy on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
