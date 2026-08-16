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
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const UPSTREAM = process.env.FREEBUFF_UPSTREAM || 'http://127.0.0.1:58060';
const PORT = Number(process.env.FREEBUFF_PROXY_PORT || 58061);

const REPO = __dirname;
const MOBILE_CSS_PATH = path.join(REPO, 'mobile-ui.css');
const MOBILE_JS_PATH = path.join(REPO, 'mobile-ui.js');
const PERF_PROBE_PATH = path.join(REPO, 'perf-probe.js');

// ---- perf probe ----
// In-page Navigation/Resource Timing probe (src/perf-probe.js). Dormant unless
// the URL carries ?fbperf=1 (or #fbperf). The probe POSTs its waterfall to
// /api/fb/perf-report, which the proxy logs here (tagged webview|firefox|
// browser by user-agent) so a phone WebView run and a Firefox run can be
// compared side by side.
const PERF_REPORT_LOG = path.join(os.homedir(), '.config', 'freebuff-desktop', 'perf-report.log');
function perfClient(ua) {
  ua = String(ua || '');
  if (/FreebuffMobile\//.test(ua)) return 'webview';
  if (/Firefox\//.test(ua)) return 'firefox';
  return 'browser';
}
function perfReport(ua, body) {
  try {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) { /* keep {} */ }
    fs.mkdirSync(path.dirname(PERF_REPORT_LOG), { recursive: true });
    fs.appendFileSync(PERF_REPORT_LOG, JSON.stringify({ ts: new Date().toISOString(), client: perfClient(ua), ...parsed }) + '\n');
  } catch (e) { /* probe logging must never break the proxy */ }
}
function perfTag() {
  try {
    const body = fs.readFileSync(PERF_PROBE_PATH, 'utf8');
    return `<script id="fb-perf-probe">${body}<\/script>`;
  } catch (e) {
    return '';
  }
}

// ---- ad request sniffer ----
// Logs every /api/ad/* request and response that flows through the proxy
// (browser -> orchestrator) so ad payloads can be cross-checked against the
// orchestrator's outbound auction sniffer. Same log file as the orchestrator
// side (kind prefix distinguishes the source).
const AD_SNIFF_LOG = path.join(os.homedir(), '.config', 'freebuff-desktop', 'ad-sniff.log');
function adSniff(kind, data) {
  try {
    fs.appendFileSync(AD_SNIFF_LOG, JSON.stringify({ ts: new Date().toISOString(), kind: kind, ...data }) + '\n');
  } catch (e) { /* sniffer must never break the proxy */ }
}

// ---- window.freebuffDesktop shim (browser fallbacks for the Electron preload bridge) ----
// The browser UI runs against the orchestrator on the SERVER, so "pick a
// folder" cannot use the browser's local filesystem (showDirectoryPicker
// would resolve to a local path the server never sees). Instead we open a
// server-side file browser backed by GET /api/fb/dirlist?path=... (the
// orchestrator's on-disk bundle carries that route; the proxy serves the
// same page and forwards the call upstream).
const SHIM = `(function () {
  if (window.freebuffDesktop) return;
  var virtualPick = function () {
    return new Promise(function (resolve) {
      var current = '/';
      var recents = [];
      function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      function joinPath(base, name) {
        var b = base === '/' ? '' : String(base).replace(/\/+$/, '');
        return b + '/' + name;
      }
      function parentOf(p) {
        var t = String(p).replace(/\/+$/, '');
        if (!t) return '/';
        var i = t.lastIndexOf('/');
        return i <= 0 ? '/' : t.slice(0, i);
      }
      function build() {
        var wrap = document.createElement('div');
        wrap.className = 'fb-pick-wrap';
        var style = document.createElement('style');
        style.textContent = '.fb-pick-wrap{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif}.fb-browse-box{width:min(100%,560px);max-height:82vh;display:flex;flex-direction:column;padding:18px;box-sizing:border-box;border:1px solid var(--border,#333);border-radius:14px;background:var(--bg,#111);color:var(--text,#eee);box-shadow:0 18px 44px rgba(0,0,0,.5)}.fb-browse-box h3{margin:0 0 10px;font-size:15px}.fb-browse-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:8px 10px;margin-bottom:8px;border:1px solid var(--border,#444);border-radius:9px;background:var(--surface-2,#1a1a1a);font-size:12.5px;overflow-x:auto;white-space:nowrap}.fb-crumb{background:none;border:none;color:var(--accent,#4ade80);cursor:pointer;font:inherit;font-size:12.5px;padding:2px 3px}.fb-crumb:hover{text-decoration:underline}.fb-crumb-sep{color:var(--muted,#777);user-select:none}.fb-browse-list{flex:1;overflow-y:auto;min-height:160px;max-height:46vh;border:1px solid var(--border,#333);border-radius:9px;background:var(--surface-2,#0d0d0d)}.fb-browse-item{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;box-sizing:border-box;border:none;background:none;color:var(--text,#eee);text-align:left;font:inherit;font-size:13px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)}.fb-browse-item:hover{background:rgba(78,222,128,.09)}.fb-browse-item .fb-ic{opacity:.85;flex:none}.fb-browse-item.file{color:var(--muted,#888);cursor:default}.fb-browse-item.file:hover{background:none}.fb-browse-msg{padding:14px;color:var(--muted,#999);font-size:13px}.fb-browse-recents{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.fb-browse-recents button{padding:6px 10px;border:1px solid var(--border,#444);border-radius:8px;background:var(--surface-2,#1a1a1a);color:var(--muted,#bbb);font:inherit;font-size:12px;cursor:pointer}.fb-browse-recents button:hover{color:var(--text,#eee);border-color:var(--accent,#4ade80)}.fb-pick-actions{display:flex;justify-content:space-between;gap:8px;margin-top:14px}.fb-pick-actions .fb-acts{display:flex;gap:8px}.fb-pick-actions button{min-width:80px;min-height:40px;padding:8px 14px;border:1px solid transparent;border-radius:9px;font:inherit;font-size:13px;font-weight:650;color:#fff;cursor:pointer}.fb-pick-ok{background:#2eaa62}.fb-pick-cancel{background:#555}.fb-pick-up{background:#444}@media(max-width:700px){.fb-browse-box h3{font-size:16px}.fb-pick-actions button{min-height:44px}}';
        wrap.appendChild(style);
        var box = document.createElement('div');
        box.className = 'fb-browse-box';
        var h = document.createElement('h3');
        h.textContent = 'Open project folder';
        var crumbs = document.createElement('div');
        crumbs.className = 'fb-browse-crumbs';
        var list = document.createElement('div');
        list.className = 'fb-browse-list';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', 'Server folders');
        var rec = document.createElement('div');
        rec.className = 'fb-browse-recents';
        var actions = document.createElement('div');
        actions.className = 'fb-pick-actions';
        var acts = document.createElement('div');
        acts.className = 'fb-acts';
        var up = document.createElement('button');
        up.type = 'button';
        up.className = 'fb-pick-up';
        up.textContent = 'Up';
        var home = document.createElement('button');
        home.type = 'button';
        home.className = 'fb-pick-up';
        home.textContent = 'Home';
        var ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'fb-pick-ok';
        ok.textContent = 'Select this folder';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'fb-pick-cancel';
        cancel.textContent = 'Cancel';
        box.appendChild(h);
        box.appendChild(crumbs);
        box.appendChild(list);
        if (recents.length) {
          recents.forEach(function (r) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = r;
            b.addEventListener('click', function () { current = r; load(); });
            rec.appendChild(b);
          });
          box.appendChild(rec);
        }
        acts.appendChild(up);
        acts.appendChild(home);
        actions.appendChild(acts);
        actions.appendChild(cancel);
        actions.appendChild(ok);
        box.appendChild(actions);
        wrap.appendChild(box);
        document.body.appendChild(wrap);
        up.addEventListener('click', function () { current = parentOf(current); load(); });
        home.addEventListener('click', function () { current = '/'; load(); });
        ok.addEventListener('click', function () {
          var v = String(current || '').trim();
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(v || null);
        });
        function cancelPick() {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(null);
        }
        cancel.addEventListener('click', cancelPick);
        wrap.addEventListener('click', function (ev) { if (ev.target === wrap) cancelPick(); });
        document.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') { ev.preventDefault(); cancelPick(); }
        }, { once: true });
        return { crumbs: crumbs, list: list };
      }
      function renderCrumbs(parts, holder) {
        holder.innerHTML = '';
        var root = document.createElement('button');
        root.type = 'button';
        root.className = 'fb-crumb';
        root.textContent = '/';
        root.setAttribute('aria-label', 'Go to root');
        root.addEventListener('click', function () { current = '/'; load(); });
        holder.appendChild(root);
        parts.forEach(function (seg, idx) {
          if (idx > 0) {
            var sep = document.createElement('span');
            sep.className = 'fb-crumb-sep';
            sep.textContent = '/';
            holder.appendChild(sep);
          }
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'fb-crumb';
          b.textContent = seg;
          b.addEventListener('click', function () { current = '/' + parts.slice(0, idx + 1).join('/'); load(); });
          holder.appendChild(b);
        });
      }
      function load() {
        var ui = window.__fbBrowseUi;
        if (!ui) return;
        ui.list.innerHTML = '<div class="fb-browse-msg">Loading ' + esc(current) + '…</div>';
        fetch('/api/fb/dirlist?path=' + encodeURIComponent(current), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.error) {
              ui.list.innerHTML = '<div class="fb-browse-msg">' + esc(d.error) + '</div>';
              return;
            }
            current = (d && d.path) || current;
            var parts = String(current).replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
            renderCrumbs(parts, ui.crumbs);
            var entries = (d && d.entries) || [];
            if (!entries.length) {
              ui.list.innerHTML = '<div class="fb-browse-msg">This folder is empty</div>';
              return;
            }
            ui.list.innerHTML = '';
            entries.forEach(function (e) {
              var row = document.createElement('button');
              row.type = 'button';
              row.className = 'fb-browse-item' + (e.dir ? '' : ' file');
              var ic = document.createElement('span');
              ic.className = 'fb-ic';
              ic.textContent = e.dir ? '📁' : '📄';
              var name = document.createElement('span');
              name.textContent = e.name;
              row.appendChild(ic);
              row.appendChild(name);
              if (e.dir) {
                row.setAttribute('role', 'option');
                row.addEventListener('click', function () { current = joinPath(current, e.name); load(); });
              }
              ui.list.appendChild(row);
            });
          })
          .catch(function () {
            ui.list.innerHTML = '<div class="fb-browse-msg">Could not list the folder on the server</div>';
          });
      }
      var ui = build();
      window.__fbBrowseUi = ui;
      fetch('/api/project/recents', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var list = (d && (d.paths || d.recentProjects)) || [];
          recents = list.slice(0, 6);
          if (list.length && !current || current === '/') current = String(list[0]);
          load();
        })
        .catch(function () { load(); });
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

function injectInto(html, withPerf) {
  const inject = mobileTag('css') + mobileTag('js') + (withPerf ? perfTag() : '') + `<script id="fb-desktop-shim">${SHIM}<\/script>`;
  if (html.includes('</head>')) return html.replace('</head>', inject + '</head>');
  return inject + html;
}

// ---- Bundle patch: boot home tab must never hijack the active thread ----
// The packaged UI's boot hook calls wy({pickProject:!1,home:!0}) on every
// page load. That routes into openTab(path, threadId, home=true), which in
// the stock bundle ALWAYS calls ve.createThread() — orphaning an empty
// "New thread" in the DB on every load. The earlier reuse patch fixed the
// leak but reused the FIRST HYDRATED restored tab as the home tab, which
// (a) wiped that thread's messages in the store, (b) left a duplicate tab
// id (home + phantom), and (c) let the phantom cleanup close the real tab
// and move activeId off the last chat. Fix both halves:
//   callback: prefer the existing home tab, else the pinned fb.homeThread
//   id; only create a fresh home thread when neither exists (and pin it).
//   setState: never wipe an existing thread entry, promote the reused tab
//   instead of duplicating it, and keep activeId untouched on the home
//   path (a reload must land on the thread the user was chatting in last).
// The callback must return the FULL thread object from the store, not a
// bare id: openTab wraps the result into the threads map, and a {id} stub
// replaces the real thread and crashes the thread view.
const CREATE_MARK =
  'lr(t,()=>ve.createThread(n,{inheritFromThreadId:i}),"Could not open tab")';
const CREATE_REUSE_V1 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const s=()=>{const ts=G.getState().tabs,lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,hb=ts.find(h=>h.home)||ts.find(x=>lv(x.id)),th=hb&&lv(hb.id)||(()=>{try{const k=localStorage.getItem("fb.homeThread");return k&&lv(k)}catch(e){}})();return th||(ts[0]&&lv(ts[0].id))},th=s();if(th)return th;return new Promise(q=>setTimeout(()=>{const th2=s();if(th2)return q(th2);const nt=ve.createThread(n,{inheritFromThreadId:i});try{localStorage.setItem("fb.homeThread",nt.id)}catch(e){}q(nt)},800))},"Could not open tab")';
const CREATE_REUSE =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const s=()=>{const ts=G.getState().tabs,lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,hb=ts.find(h=>h.home);if(hb&&lv(hb.id))return lv(hb.id);let k=null;try{k=localStorage.getItem("fb.homeThread")}catch(e){}if(k&&lv(k))return lv(k);return null},th=s();if(th)return th;return new Promise(q=>setTimeout(()=>{const th2=s();if(th2)return q(th2);const nt=ve.createThread(n,{inheritFromThreadId:i});try{localStorage.setItem("fb.homeThread",nt.id)}catch(e){}q(nt)},800))},"Could not open tab")';
const SETSTATE_MARK =
  'return s?(e(o=>{const c=r?o.tabs.find(h=>h.home):void 0,u={...o.threads,[s.id]:{thread:s,messages:[],items:[]}};return c&&delete u[c.id],{threads:u,tabs:r?[{id:s.id,projectPath:n,home:!0},...o.tabs.filter(h=>!h.home)]:[...o.tabs,{id:s.id,projectPath:n,openerId:i}],activeId:r&&o.activeId!==(c==null?void 0:c.id)?o.activeId:s.id}}),mi(),!0):!1}';
const SETSTATE_FIX =
  'return s?(e(o=>{const c=r?o.tabs.find(h=>h.home):void 0;let u={...o.threads};if(!r||!u[s.id])u[s.id]={thread:s,messages:[],items:[]};if(c&&c.id!==s.id)delete u[c.id];return{threads:u,tabs:r?[{id:s.id,projectPath:n,home:!0},...o.tabs.filter(h=>!h.home&&h.id!==s.id)]:[...o.tabs,{id:s.id,projectPath:n,openerId:i}],activeId:r?(o.activeId!=null&&o.activeId!==(c==null?void 0:c.id)?o.activeId:s.id):s.id}}),mi(),!0):!1}';

// ---- Bundle patch: thread switch always lands at the last message ----
// The chat scroll hook (VZ) scrolls .messages to the bottom inside a layout
// effect that only re-runs when the messages array identity changes. On a
// slow client (phone WebView, huge thread) layout can still be settling when
// that effect runs, so scrollTop ends up at 0 and nothing re-asserts it:
// switching threads then starts at the very first message. Patch the pinned
// branch to re-assert the bottom scroll one frame and 150ms later. Both
// guards re-check pinBottom (n.current) and the follow flag, so a user who
// scrolled up (or used "Scroll to latest") is never yanked back down.
const SCROLL_MARK =
  'L.useLayoutEffect(()=>{const v=t.current;if(v){if(n.current){i.current!=="follow"&&(v.scrollTop=v.scrollHeight);return}u(!0),o(Sv(v)<KT)}},[e]),';
const SCROLL_FIX =
  'L.useLayoutEffect(()=>{const v=t.current;if(v){if(n.current){i.current!=="follow"&&(v.scrollTop=v.scrollHeight);const q=()=>{const v2=t.current;if(v2&&n.current&&i.current!=="follow")v2.scrollTop=v2.scrollHeight};requestAnimationFrame(q),setTimeout(q,150);return}u(!0),o(Sv(v)<KT)}},[e]),';

// ---- Bundle patch: closing a phantom "New thread" tab must work ----
// The boot home-tab logic (hJ) mounts a home tab whose id can collide with
// the first restored tab, so the tab bar briefly holds two tabs with the
// same id: the real home tab (home:true) and a phantom duplicate that shows
// as an unclosable "New thread". closeTab looks the tab up by id and finds
// the home copy first, then refuses to close it (home tabs are protected),
// so the phantom never closes and the app's own phantom cleanup clicks the
// X to no effect. Patch closeTab to prefer a non-home tab with that id,
// keep the home tab AND its thread in the store when ids collide (the
// threads map is keyed by the same id, so a plain close would delete the
// home thread out from under the home tab), and skip the server-side
// thread delete when the id belongs to a home tab.
const CLOSE_MARK1 =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n);if(!i||i.home)return;';
const CLOSE_FIX1 =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n&&!u.home)||t().tabs.find(u=>u.id===n);if(!i||i.home)return;';
const CLOSE_MARK2 =
  'const h=u.tabs.filter(_=>!o.has(_.id)),{[n]:p,...f}=u.threads;';
const CLOSE_FIX2 =
  'const h=u.tabs.filter(_=>!o.has(_.id)||(_.home&&_.id===n)),k2=u.tabs.some(_=>_.home&&_.id===n),f=(()=>{if(k2)return u.threads;const g={...u.threads};delete g[n];return g})();';
const CLOSE_MARK3 =
  'i.file||await ve.close(n).catch(()=>{})},setActive(n){';
const CLOSE_FIX3 =
  'i.file||await Promise.resolve().then(()=>t().tabs.some(u=>u.home&&u.id===n)||ve.close(n)).catch(()=>{})},setActive(n){';

function patchBundle(body) {
  let out = body;
  if (out.includes(CREATE_MARK)) out = out.split(CREATE_MARK).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V1)) out = out.split(CREATE_REUSE_V1).join(CREATE_REUSE);
  if (out.includes(SETSTATE_MARK)) out = out.split(SETSTATE_MARK).join(SETSTATE_FIX);
  if (out.includes(SCROLL_MARK)) out = out.split(SCROLL_MARK).join(SCROLL_FIX);
  if (out.includes(CLOSE_MARK1)) out = out.split(CLOSE_MARK1).join(CLOSE_FIX1);
  if (out.includes(CLOSE_MARK2)) out = out.split(CLOSE_MARK2).join(CLOSE_FIX2);
  if (out.includes(CLOSE_MARK3)) out = out.split(CLOSE_MARK3).join(CLOSE_FIX3);
  return out;
}

function createProxyServer(options = {}) {
  const upstream = options.upstream || process.env.FREEBUFF_UPSTREAM || 'http://127.0.0.1:58060';
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  headers.host = up.host;
  if (headers.origin) {
    try { headers.origin = up.origin; } catch (e) { /* keep as-is */ }
  }
  headers['accept-encoding'] = 'identity';
  let pathname = req.url || '/';
  try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch (e) { /* keep raw */ }
  const sniffAd = pathname.startsWith('/api/ad/');
  if (sniffAd) adSniff('proxy-request', { path: pathname, method: req.method });
  // Perf probe reports are logged locally (not forwarded upstream): the
  // proxy is the origin the phone WebView sees, so its report must land here.
  if (req.method === 'POST' && pathname === '/api/fb/perf-report') {
    const perfChunks = [];
    req.on('data', (c) => perfChunks.push(c));
    req.on('end', () => {
      perfReport(req.headers['user-agent'], Buffer.concat(perfChunks).toString('utf8'));
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }
  const reqChunks = [];
  if (sniffAd) req.on('data', (c) => reqChunks.push(c));
  const preq = http.request({
    host: up.hostname,
    port: up.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, (pres) => {
    const type = String(pres.headers['content-type'] || '');
    if (sniffAd) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        adSniff('proxy-response', {
          path: pathname,
          status: pres.statusCode || 200,
          body: (() => { try { return JSON.parse(body); } catch (e) { return body.slice(0, 2000); } })(),
        });
        res.writeHead(pres.statusCode || 200, pres.headers);
        res.end(body);
      });
      pres.on('error', () => res.destroy());
      return;
    }
    if (type.includes('text/html')) {
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const out = injectInto(body, /fbperf/.test(req.url || ''));
        const outHeaders = { ...pres.headers };
        // The body is rewritten, so its byte length changes. Node re-encodes
        // the body itself once content-length is set; a leftover chunked
        // transfer-encoding (chunked upstream) would make the response invalid.
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(out);
        // The HTML is rewritten per request (shim + bundle patch + mobile
        // layer), so a cached copy can silently serve stale UI (e.g. the old
        // folder picker that opens the phone's own file browser). Force
        // revalidation on every load.
        outHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
        outHeaders.pragma = 'no-cache';
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
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(out);
        const isMainBundle = /\/assets\/index-[^/]+\.js$/.test(pathname);
        if (isMainBundle) {
          // The main bundle is patched per request. Cache it but always
          // revalidate so a patch or upstream update propagates; a 304 skips
          // re-downloading the ~1.5MB body.
          const etag = '"' + crypto.createHash('sha1').update(out).digest('hex') + '"';
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag: etag, 'cache-control': 'public, max-age=0, must-revalidate' });
            res.end();
            return;
          }
          outHeaders.etag = etag;
          outHeaders['cache-control'] = 'public, max-age=0, must-revalidate';
        } else {
          // Lazy JS chunks are content-hashed and never patched.
          outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        }
        res.writeHead(pres.statusCode || 200, outHeaders);
        res.end(out);
      });
      pres.on('error', () => res.destroy());
      return;
    }
    const passHeaders = { ...pres.headers };
    if (pathname.startsWith('/assets/')) {
      // Hashed static assets (CSS, fonts, images, audio) are immutable.
      passHeaders['cache-control'] = 'public, max-age=31536000, immutable';
    } else if (pathname.startsWith('/api/')) {
      passHeaders['cache-control'] = 'no-store';
    }
    res.writeHead(pres.statusCode || 200, passHeaders);
    pres.pipe(res);
    pres.on('error', () => res.destroy());
  });
  preq.on('error', () => res.destroy());
  if (sniffAd) {
    req.on('end', () => preq.end(Buffer.concat(reqChunks)));
  } else {
    req.pipe(preq);
  }
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

  return server;
}

module.exports = {
  CREATE_MARK,
  CLOSE_FIX1,
  CLOSE_FIX2,
  CLOSE_FIX3,
  CLOSE_MARK1,
  CLOSE_MARK2,
  CLOSE_MARK3,
  CREATE_REUSE,
  CREATE_REUSE_V1,
  SCROLL_FIX,
  SCROLL_MARK,
  SETSTATE_FIX,
  SETSTATE_MARK,
  SHIM,
  createProxyServer,
  patchBundle,
};

if (require.main === module) {
  const server = createProxyServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`freebuff tailnet proxy on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
  });
}
