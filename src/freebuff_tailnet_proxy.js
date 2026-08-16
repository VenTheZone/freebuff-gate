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
// The browser UI runs against the orchestrator on the SERVER, so "pick a
// folder" cannot use the browser's local filesystem (showDirectoryPicker
// would resolve to a local path the server never sees). Instead we ask for
// an absolute path on the server, prefilled with the directory of the most
// recently opened project and with quick-pick buttons for known projects.
const SHIM = `(function () {
  if (window.freebuffDesktop) return;
  var virtualPick = function () {
    return new Promise(function (resolve) {
      function show(hint) {
        var wrap = document.createElement('div');
        wrap.className = 'fb-pick-wrap';
        var style = document.createElement('style');
        style.textContent = '.fb-pick-wrap{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif}.fb-pick-box{width:min(100%,420px);padding:18px;border:1px solid var(--border,#333);border-radius:14px;background:var(--bg,#111);color:var(--text,#eee);box-shadow:0 18px 44px rgba(0,0,0,.5)}.fb-pick-box h3{margin:0 0 6px;font-size:15px}.fb-pick-box p{margin:0 0 12px;font-size:12.5px;color:var(--muted,#999);line-height:1.4}.fb-pick-input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border,#444);border-radius:9px;background:var(--surface-2,#1a1a1a);color:var(--text,#eee);font:inherit;font-size:13.5px;outline:none}.fb-pick-input:focus{border-color:var(--accent,#4ade80)}.fb-pick-recents{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.fb-pick-recents button{padding:6px 10px;border:1px solid var(--border,#444);border-radius:8px;background:var(--surface-2,#1a1a1a);color:var(--muted,#bbb);font:inherit;font-size:12px;cursor:pointer}.fb-pick-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.fb-pick-actions button{min-width:88px;min-height:40px;padding:8px 14px;border:1px solid transparent;border-radius:9px;font:inherit;font-size:13px;font-weight:650;color:#fff;cursor:pointer}.fb-pick-ok{background:#2eaa62}.fb-pick-cancel{background:#555}@media(max-width:700px){.fb-pick-box h3{font-size:16px}.fb-pick-actions button{min-height:44px}}';
        wrap.appendChild(style);
        var box = document.createElement('div');
        box.className = 'fb-pick-box';
        var h = document.createElement('h3');
        h.textContent = 'Open project folder';
        var p = document.createElement('p');
        p.textContent = 'Enter the absolute path of the folder on the server (for example ' + (hint || '/home/you/my-project') + ').';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'fb-pick-input';
        input.value = hint || '';
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('aria-label', 'Server folder path');
        var recents = document.createElement('div');
        recents.className = 'fb-pick-recents';
        if (recentsArr && recentsArr.length) {
          recentsArr.forEach(function (r) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = r;
            b.addEventListener('click', function () { input.value = r; input.focus(); });
            recents.appendChild(b);
          });
        }
        var actions = document.createElement('div');
        actions.className = 'fb-pick-actions';
        var ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'fb-pick-ok';
        ok.textContent = 'Open';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'fb-pick-cancel';
        cancel.textContent = 'Cancel';
        function done() {
          var v = input.value.trim();
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(v || null);
        }
        function cancelPick() {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(null);
        }
        ok.addEventListener('click', done);
        cancel.addEventListener('click', cancelPick);
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); done(); }
          else if (ev.key === 'Escape') { ev.preventDefault(); cancelPick(); }
        });
        wrap.addEventListener('click', function (ev) { if (ev.target === wrap) cancelPick(); });
        actions.appendChild(cancel);
        actions.appendChild(ok);
        box.appendChild(h);
        box.appendChild(p);
        box.appendChild(input);
        if (recentsArr && recentsArr.length) box.appendChild(recents);
        box.appendChild(actions);
        wrap.appendChild(box);
        document.body.appendChild(wrap);
        input.focus();
        input.select();
      }
      var hint = '/home/';
      var recentsArr = [];
      try {
        fetch('/api/project/recents', { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            var list = (d && (d.paths || d.recentProjects)) || [];
            if (list.length) {
              var first = String(list[0]).replace(/\/+$/, '');
              var slash = first.lastIndexOf('/');
              if (slash > 0) hint = first.slice(0, slash + 1);
              recentsArr = list.slice(0, 6);
            }
            show(hint, recentsArr);
          })
          .catch(function () { show(hint, recentsArr); });
      } catch (e) { show(hint, recentsArr); }
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
// a new thread: prefer the existing home tab, else the first restored tab
// whose thread is still live, else the thread id pinned in localStorage
// (fb.homeThread, set the first time a home thread is created), else the
// leftmost restored tab if it is live. Dead tabs whose threads were
// deleted are skipped, so a reload never respawns a purged thread. The
// reused branch must return the FULL thread object from the store (not
// just its id): openTab wraps whatever the callback returns into the
// threads map, and a bare {id} stub replaces the real thread and crashes
// the thread view (e.deliveries.at(-1)). Because thread hydration can lag
// the boot home call, an unmatched lookup retries once after 800ms and
// only then creates a thread (pinning its id for future boots). First
// ever boot (no tabs, nothing pinned) still creates the initial home
// thread; user-initiated new threads (the .tab-new button / "New session"
// menu) pass home=false and are untouched.
const CREATE_MARK =
  'lr(t,()=>ve.createThread(n,{inheritFromThreadId:i}),"Could not open tab")';
const CREATE_REUSE =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const s=()=>{const ts=G.getState().tabs,lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,hb=ts.find(h=>h.home)||ts.find(x=>lv(x.id)),th=hb&&lv(hb.id)||(()=>{try{const k=localStorage.getItem("fb.homeThread");return k&&lv(k)}catch(e){}})();return th||(ts[0]&&lv(ts[0].id))},th=s();if(th)return th;return new Promise(q=>setTimeout(()=>{const th2=s();if(th2)return q(th2);const nt=ve.createThread(n,{inheritFromThreadId:i});try{localStorage.setItem("fb.homeThread",nt.id)}catch(e){}q(nt)},800))},"Could not open tab")';

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
