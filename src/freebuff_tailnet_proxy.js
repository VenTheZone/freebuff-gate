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

// ---- ad broadcast cache ----
// Last known non-empty ad fill per placement, captured from /api/ad/slot
// responses that pass through the proxy. When a later auction returns empty
// (gravity no-fill), the proxy substitutes the cached ad so a fill seen on
// one surface is re-broadcast to all of them (Gate Desktop direct, CLI, and
// Gate Mobile via relay -> agent -> proxy all share this one interception
// point). In-memory: a fresh proxy process starts with no cache, and the
// next real fill repopulates it.
const lastAds = new Map();

// ---- dev ad broadcaster ----
// FB_AD_DEV_BROADCAST=1 makes the proxy substitute this clearly-marked
// placeholder into every EMPTY /api/ad/slot response, so the ad card render
// path can be exercised end-to-end on Gate Desktop and Gate Mobile before
// the gravity auction ever fills. Shape matches what the UI renderer reads
// (title, url, clickUrl||url, impUrl, favicon, adText||cta) plus the
// orchestrator's keep filter (title && url). Responses carry `dev: true` so
// a placeholder can never be mistaken for a real fill. Off by default.
const DEV_AD = {
  title: 'Freebuff Gate dev ad',
  brandName: 'Freebuff Gate',
  adText: 'Placeholder ad for testing the Gate Desktop and Gate Mobile ad card. Enable with FB_AD_DEV_BROADCAST=1 on the tailnet proxy.',
  cta: 'Learn more',
  url: 'https://github.com/VenTheZone/freebuff-gate',
  clickUrl: 'https://github.com/VenTheZone/freebuff-gate',
  impUrl: 'https://dev.local/freebuff-gate/ad-impression',
  favicon: '',
};
function devAdBroadcastEnabled() {
  return process.env.FB_AD_DEV_BROADCAST === '1';
}
const MOBILE_JS_PATH = path.join(REPO, 'mobile-ui.js');
const PERF_PROBE_PATH = path.join(REPO, 'perf-probe.js');
// Attached files uploaded from the browser (desktop or mobile WebView) land
// here on the server; the composer sends the returned path to the agent just
// like a native Electron attachment. The on-disk orchestrator patch writes to
// the same directory so 58060-direct and 58061-proxied clients agree on it.
const UPLOADS_DIR = process.env.FB_UPLOADS_DIR
  || path.join(os.homedir(), '.local', 'share', 'freebuff', 'uploads');
const FB_MAX_UPLOAD_BYTES = Number(process.env.FB_MAX_UPLOAD_BYTES || 256 * 1024 * 1024);

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
const AD_SNIFF_LOG = process.env.FB_AD_SNIFF_LOG || path.join(os.homedir(), '.config', 'freebuff-desktop', 'ad-sniff.log');
// Header values that must never land in the debug log verbatim. The header
// NAME is kept (so the shape of the exchange stays visible) but the value is
// replaced, matching the existing behavior of logging `auth: present` rather
// than the token itself.
const SNIFF_REDACT_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'set-cookie',
]);
function sniffHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = SNIFF_REDACT_HEADERS.has(String(key).toLowerCase())
      ? '<redacted>'
      : String(value);
  }
  return out;
}
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
        var b = base === '/' ? '' : String(base).replace(/\\/+$/, '');
        return b + '/' + name;
      }
      function parentOf(p) {
        var t = String(p).replace(/\\/+$/, '');
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
            var parts = String(current).replace(/^\\/+/, '').replace(/\\/+$/, '').split('/').filter(Boolean);
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
  // Attach files from the browser: pick local files with a hidden input,
  // upload each to /api/fb/upload (the proxy/orchestrator stores it on the
  // server and returns a real path), and hand the paths back in the same
  // { path, name, isDirectory } shape the native Electron picker returns.
  var uploadOne = function (file) {
    return fetch('/api/fb/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then(function (r) {
      if (!r.ok) throw new Error('upload failed: ' + r.status);
      return r.json();
    }).then(function (d) {
      return { path: d.path, name: d.name || file.name, isDirectory: false };
    });
  };
  var pickAttachments = function () {
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      var settled = false;
      var finish = function (value) {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onFocus);
        input.remove();
        resolve(value);
      };
      var onFocus = function () {
        // File inputs have no cancel event; when the dialog closes without a
        // 'change', resolve empty shortly after the window regains focus.
        setTimeout(function () { finish([]); }, 800);
      };
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) { finish([]); return; }
        Promise.all(files.map(uploadOne)).then(finish).catch(function (err) {
          console.error('Freebuff attach failed', err);
          finish([]);
        });
      });
      window.addEventListener('focus', onFocus);
      document.body.appendChild(input);
      input.click();
    });
  };
  // Preview an image attachment: the path lives on the server, so fetch it
  // through /api/fb/read-file and return a data URL for the <img> src.
  var readImage = function (filePath) {
    return fetch('/api/fb/read-file?path=' + encodeURIComponent(filePath)).then(function (r) {
      if (!r.ok) throw new Error('read failed: ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { resolve(null); };
        reader.readAsDataURL(blob);
      });
    });
  };
  window.freebuffDesktop = {
    platform: 'browser',
    pickDirectory: virtualPick,
    pickAttachments: pickAttachments,
    readImage: readImage,
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
    // openExternal intentionally absent: the UI's guards fall through to
    // window.open in a browser. readImage + pickAttachments are the browser
    // equivalents for image preview and file attach.
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
const CREATE_REUSE_V2 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const s=()=>{const ts=G.getState().tabs,lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,hb=ts.find(h=>h.home);if(hb&&lv(hb.id))return lv(hb.id);let k=null;try{k=localStorage.getItem("fb.homeThread")}catch(e){}if(k&&lv(k))return lv(k);return null},th=s();if(th)return th;return new Promise(q=>setTimeout(()=>{const th2=s();if(th2)return q(th2);const nt=ve.createThread(n,{inheritFromThreadId:i});try{localStorage.setItem("fb.homeThread",nt.id)}catch(e){}q(nt)},800))},"Could not open tab")';
// V3: ve.createThread is an async API call (returns a Promise), so reading
// nt.id off the returned promise stores the literal string "undefined" and
// the pin never matches. Resolve the thread first, then pin its real id &
// hand the resolved thread to q. Without this every reload sees no pin and
// creates a fresh empty home thread, stacking "New thread" tabs.
const CREATE_REUSE_V3 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const s=()=>{const ts=G.getState().tabs,lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,hb=ts.find(h=>h.home);if(hb&&lv(hb.id))return lv(hb.id);let k=null;try{k=localStorage.getItem("fb.homeThread")}catch(e){}if(k&&lv(k))return lv(k);return null},th=s();if(th)return th;return new Promise(q=>setTimeout(()=>{const th2=s();if(th2)return q(th2);ve.createThread(n,{inheritFromThreadId:i}).then(nt=>{let id=null;try{id=nt&&nt.id||null}catch(e){}if(id){try{localStorage.setItem("fb.homeThread",id)}catch(e){}}q(nt||id)},()=>{try{localStorage.removeItem("fb.homeThread")}catch(e){}})},800))},"Could not open tab")';
// V4: on a phone the relay path hydrates the store slowly, so at boot the
// pinned thread is not in G.getState().threads yet and V3's single 800ms
// retry misses it, then creates a NEW thread and re-pins it. Every connect
// (fresh page load) therefore stacked another empty "New thread". V4 keeps
// polling for the pinned thread while it exists, and only creates a fresh
// one when no pin exists at all (a genuinely new browser) or the pinned
// thread was deleted server-side.
// V4 (superseded): polled for the pinned thread with a 30x200ms (6s) cap,
// then gave up, created a fresh thread and re-pinned. On the phone's slow
// relay path 6s was shorter than a cold connect, so every connect stacked
// another empty "New thread". Keep the exact string so bundles that
// already carry V4 can be upgraded to V5 in place.
const CREATE_REUSE_V4 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,home=()=>{const hb=G.getState().tabs.find(h=>h.home);return hb&&lv(hb.id)},pin=()=>{try{return localStorage.getItem("fb.homeThread")}catch(e){return null}};const s=()=>{const k=pin();if(home())return lv(G.getState().tabs.find(h=>h.home).id);if(k&&lv(k))return lv(k);return k?0:null},th=s();if(th&&th!==0)return th;return new Promise(q=>{const create=()=>ve.createThread(n,{inheritFromThreadId:i}).then(nt=>{let id=null;try{id=nt&&nt.id||null}catch(e){}if(id){try{localStorage.setItem("fb.homeThread",id)}catch(e){}}q(nt||id)},()=>{try{localStorage.removeItem("fb.homeThread")}catch(e){}});if(!pin())return create();let tries=0;const step=()=>{const st=s();if(st&&st!==0)return q(st);tries++;if(tries>30)return create();setTimeout(step,200)};step()})},"Could not open tab")';
// V5: never give up while a pin exists and the store is still hydrating.
// The phone's relay path hydrates slowly, and the V4 30x200ms (6s) cap was
// shorter than a cold phone connect, so it gave up, created a fresh thread
// and re-pinned — every connect stacked another empty "New thread".
// Distinguish "not hydrated yet" from "pin is stale": once the store has
// restored its tabs and the pinned thread is not among them, the thread was
// deleted (or the pin belongs to another browser) — create fresh. Serialize
// creates through a shared promise so concurrent boot-hook calls (mount +
// re-render) can never both create. Keep the exact string so bundles that
// already carry V5 can be upgraded to V6 in place.
const CREATE_REUSE_V5 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,home=()=>{const hb=G.getState().tabs.find(h=>h.home);return hb&&lv(hb.id)},pin=()=>{try{return localStorage.getItem("fb.homeThread")}catch(e){return null}};const s=()=>{const k=pin();if(home())return lv(G.getState().tabs.find(h=>h.home).id);if(k&&lv(k))return lv(k);if(!k)return null;return G.getState().tabs.length?null:0},th=s();if(th&&th!==0)return th;return new Promise(q=>{let inflight=null;const create=()=>{if(!inflight)inflight=ve.createThread(n,{inheritFromThreadId:i}).then(nt=>{let id=null;try{id=nt&&nt.id||null}catch(e){}if(id){try{localStorage.setItem("fb.homeThread",id)}catch(e){}}return nt||id},()=>{try{localStorage.removeItem("fb.homeThread")}catch(e){}return null}).finally(()=>{inflight=null});return inflight};if(!pin())return create().then(v=>q(v));const step=()=>{const st=s();if(st&&st!==0)return q(st);if(st===null)return create().then(v=>q(v));setTimeout(step,250)};step()})},"Could not open tab")';
// V6 (superseded): join the thread the user last sent a message on, not a
// fresh one, ranking hydrated threads by last activity — but its no-pin
// hydration wait was capped at 24x250ms (6s). On a slow relay path (DERP
// relay, e.g. a tablet connected through hkg with 500ms+ latency) the store
// can still be empty when the cap expires, so boot gave up and created a
// fresh empty "New thread" — the stacking bug again. Keep the exact string
// so bundles that already carry V6 can be upgraded to V7 in place.
const CREATE_REUSE_V6 =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,cand=x=>{const t=lv(x);return t&&!t.archivedAt&&t.status!=="closed"&&t.projectPath===n?t:null},act=x=>{const t=cand(x);return t?Math.max(t.lastPromptAt??0,t.lastTurnFinishedAt??0):0},best=()=>{let id=null,bt=0;for(const k in G.getState().threads){const a=act(k);if(a>bt){bt=a;id=k}}return id},newest=()=>{let id=null,bt=-1;for(const k in G.getState().threads){const t=cand(k);if(t&&t.createdAt>bt){bt=t.createdAt;id=k}}return id},home=()=>{const hb=G.getState().tabs.find(h=>h.home);return hb&&lv(hb.id)},pin=()=>{try{return localStorage.getItem("fb.homeThread")}catch(e){return null}};const s=()=>{const h=home();if(h)return h;const la=best();if(la)return lv(la);const k=pin();if(k&&lv(k))return lv(k);const c=newest();if(c)return lv(c);return G.getState().tabs.length||Object.keys(G.getState().threads).length?null:0},th=s();if(th&&th!==0)return th;return new Promise(q=>{let inflight=null,tries=0;const create=()=>{if(!inflight)inflight=ve.createThread(n,{inheritFromThreadId:i}).then(nt=>{let id=null;try{id=nt&&nt.id||null}catch(e){}if(id){try{localStorage.setItem("fb.homeThread",id)}catch(e){}}return nt||id},()=>{try{localStorage.removeItem("fb.homeThread")}catch(e){}return null}).finally(()=>{inflight=null});return inflight};const step=()=>{const st=s();if(st&&st!==0)return q(st);if(st===null)return create().then(v=>q(v));if(pin()||++tries<24)setTimeout(step,250);else create().then(v=>q(v))};step()})},"Could not open tab")';
// V7: same last-message ranking as V6, but boot no longer races hydration.
// V6 created whenever the store looked settled: an empty store (no tabs, no
// threads) created after just 6s — shorter than a slow-relay cold connect —
// and a store with tabs but no loaded threads (st===null) created
// immediately. Both stacked empty "New thread" rows on slow-relay devices.
// V7 treats "nothing to reuse yet" as "still hydrating": it keeps waiting
// (up to a 60x250ms = 15s cap) while the store is empty OR while tabs exist
// but no thread objects have loaded, and only creates once the store is
// settled — threads loaded and nothing reusable (st===null with thread
// entries), or the cap expired. A brand-new user (genuinely no threads)
// creates after the cap. Creates stay serialized through a shared promise.
const CREATE_REUSE =
  'lr(t,()=>{if(!r)return ve.createThread(n,{inheritFromThreadId:i});const lv=x=>G.getState().threads[x]&&G.getState().threads[x].thread,cand=x=>{const t=lv(x);return t&&!t.archivedAt&&t.status!=="closed"&&t.projectPath===n?t:null},act=x=>{const t=cand(x);return t?Math.max(t.lastPromptAt??0,t.lastTurnFinishedAt??0):0},best=()=>{let id=null,bt=0;for(const k in G.getState().threads){const a=act(k);if(a>bt){bt=a;id=k}}return id},newest=()=>{let id=null,bt=-1;for(const k in G.getState().threads){const t=cand(k);if(t&&t.createdAt>bt){bt=t.createdAt;id=k}}return id},home=()=>{const hb=G.getState().tabs.find(h=>h.home);return hb&&lv(hb.id)},pin=()=>{try{return localStorage.getItem("fb.homeThread")}catch(e){return null}};const s=()=>{const h=home();if(h)return h;const la=best();if(la)return lv(la);const k=pin();if(k&&lv(k))return lv(k);const c=newest();if(c)return lv(c);return G.getState().tabs.length||Object.keys(G.getState().threads).length?null:0},th=s();if(th&&th!==0)return th;return new Promise(q=>{let inflight=null,tries=0;const create=()=>{if(!inflight)inflight=ve.createThread(n,{inheritFromThreadId:i}).then(nt=>{let id=null;try{id=nt&&nt.id||null}catch(e){}if(id){try{localStorage.setItem("fb.homeThread",id)}catch(e){}}return nt||id},()=>{try{localStorage.removeItem("fb.homeThread")}catch(e){}return null}).finally(()=>{inflight=null});return inflight};const step=()=>{const st=s();if(st&&st!==0)return q(st);if(st!==null){if(++tries<60)return setTimeout(step,250);return create().then(v=>q(v));}if(Object.keys(G.getState().threads).length)return create().then(v=>q(v));if(++tries<60)return setTimeout(step,250);return create().then(v=>q(v))};step()})},"Could not open tab")';
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
const CLOSE_FIX1_V1 =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n&&!u.home)||t().tabs.find(u=>u.id===n);if(!i||i.home)return;';
// V2: closing a home tab used to be refused outright, so a stray empty
// "New thread" home tab (pinned by an older bug) could never be closed.
// Allow it when the thread has no messages; only protect home tabs that
// still hold a real conversation.
const CLOSE_FIX1_V2 =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n&&!u.home)||t().tabs.find(u=>u.id===n);if(!i)return;if(i.home){const g=G.getState(),th=g.threads[n],empty=!th||!th.messages||!th.messages.length;if(!empty)return}';
// V2 buggy: an early draft of CLOSE_FIX1 ended the home guard with a
// double brace, closing the whole closeTab body right there and making
// everything after (the store removal, server delete) dead code. Bundles
// already carrying that string must be repaired, not left as-is.
const CLOSE_FIX1_V2_BUGGY =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n&&!u.home)||t().tabs.find(u=>u.id===n);if(!i)return;if(i.home){const g=G.getState(),th=g.threads[n],empty=!th||!th.messages||!th.messages.length;if(!empty)return}}';
// V3: compute emptiness once for EVERY closed tab, then let CLOSE_FIX3
// delete the thread server-side when it is empty instead of merely marking
// it closed. Empty "New thread" rows must not survive closing; threads with
// messages still close (and can be reopened) as before.
const CLOSE_FIX1 =
  'async closeTab(n){const i=t().tabs.find(u=>u.id===n&&!u.home)||t().tabs.find(u=>u.id===n);if(!i)return;const fbEmpty=(()=>{const th=G.getState().threads[n];return !th||!th.messages||!th.messages.length})();if(i.home&&!fbEmpty)return;';
const CLOSE_MARK2 =
  'const h=u.tabs.filter(_=>!o.has(_.id)),{[n]:p,...f}=u.threads;';
const CLOSE_FIX2_V1 =
  'const h=u.tabs.filter(_=>!o.has(_.id)||(_.home&&_.id===n)),k2=u.tabs.some(_=>_.home&&_.id===n),f=(()=>{if(k2)return u.threads;const g={...u.threads};delete g[n];return g})();';
// V2: keep the home tab (and its thread) only when it still has messages.
// An empty home thread is dropped from the tab bar and the store, matching
// the server-side delete in CLOSE_FIX3.
const CLOSE_FIX2 =
  'const h=u.tabs.filter(_=>!o.has(_.id)||(_.home&&_.id===n&&(u.threads[n]&&u.threads[n].messages||[]).length)),k2=u.tabs.some(_=>_.home&&_.id===n&&(u.threads[n]&&u.threads[n].messages||[]).length),f=(()=>{if(k2)return u.threads;const g={...u.threads};delete g[n];return g})();';
const CLOSE_MARK3 =
  'i.file||await ve.close(n).catch(()=>{})},setActive(n){';
const CLOSE_FIX3_V1 =
  'i.file||await Promise.resolve().then(()=>t().tabs.some(u=>u.home&&u.id===n)||ve.close(n)).catch(()=>{})},setActive(n){';
// V2: after the store update above, a home tab survives only when it has
// messages, so "home tab still present" already means "keep it". Delete
// server-side otherwise and drop the pin when it pointed at the closed
// thread, so empty home threads do not pile up.
const CLOSE_FIX3_V2 =
  'i.file||await Promise.resolve().then(()=>{const g=G.getState();return g.tabs.some(u=>u.home&&u.id===n)?null:ve.close(n)}).then(()=>{try{if(localStorage.getItem("fb.homeThread")===n)localStorage.removeItem("fb.homeThread")}catch(e){}}).catch(()=>{})},setActive(n){';
// V3: empty threads are deleted server-side (ve.deleteThread) instead of
// merely marked closed, so closing an empty "New thread" removes the row
// from the history. Non-empty threads still close normally.
const CLOSE_FIX3 =
  'i.file||await Promise.resolve().then(()=>{const g=G.getState();if(g.tabs.some(u=>u.home&&u.id===n))return null;return fbEmpty?ve.deleteThread(n):ve.close(n)}).then(()=>{try{if(localStorage.getItem("fb.homeThread")===n)localStorage.removeItem("fb.homeThread")}catch(e){}}).catch(()=>{})},setActive(n){';

// ---- Bundle patch: home tabs render a close button when the thread is empty ----
// The vanilla tab bar hides the close (and popout) buttons on home tabs with
// a `!i&&` guard, so an empty pinned home thread could never be closed even
// though the patched closeTab would delete it. Render the close button on
// home tabs too when the thread holds no messages; clicking it hits the
// patched closeTab, which removes the empty row server-side. The store entry
// shape is { thread, messages, items }, so emptiness reads the wrapper's
// messages array (G.getState() is available on the component's store hook).
const CLOSE_BTN_MARK =
  '!i&&g.jsx("button",{className:"tab-close"';
const CLOSE_BTN_FIX =
  '(!i||(G.getState().threads[e]&&G.getState().threads[e].messages||[]).length===0)&&g.jsx("button",{className:"tab-close"';

// ---- Bundle patch: expose the native open-thread action to the mobile layer ----
// The app's store is module-private, so the mobile UI can only reopen a
// closed session by clicking a row in the home catalog. That catalog only
// renders inside the welcome section of an EMPTY home thread, so once the
// home thread holds a conversation (the normal case) Recent sessions and the
// Thread history sheet can never be opened. Rq is the app's own open-thread
// action (what every catalog row click calls); expose it on window.__fbOpenThread
// at module load so the mobile layer can open a closed session as a tab
// directly. The anchor is the bundle's final render statement, which runs
// after all module-scope declarations are hoisted.
const OPEN_THREAD_MARK =
  'T5.createRoot(document.getElementById("root")).render(g.jsx(L.StrictMode,{children:g.jsx(eu,{children:g.jsx(L5,{children:g.jsx(cJ,{})})})}));';
const OPEN_THREAD_FIX =
  OPEN_THREAD_MARK + 'window.__fbOpenThread=Rq;';

function patchBundle(body) {
  let out = body;
  if (out.includes(CREATE_MARK)) out = out.split(CREATE_MARK).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V1)) out = out.split(CREATE_REUSE_V1).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V2)) out = out.split(CREATE_REUSE_V2).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V3)) out = out.split(CREATE_REUSE_V3).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V4)) out = out.split(CREATE_REUSE_V4).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V5)) out = out.split(CREATE_REUSE_V5).join(CREATE_REUSE);
  else if (out.includes(CREATE_REUSE_V6)) out = out.split(CREATE_REUSE_V6).join(CREATE_REUSE);
  if (out.includes(SETSTATE_MARK)) out = out.split(SETSTATE_MARK).join(SETSTATE_FIX);
  if (out.includes(SCROLL_MARK)) out = out.split(SCROLL_MARK).join(SCROLL_FIX);
  if (out.includes(CLOSE_MARK1)) out = out.split(CLOSE_MARK1).join(CLOSE_FIX1);
  else if (out.includes(CLOSE_FIX1_V1)) out = out.split(CLOSE_FIX1_V1).join(CLOSE_FIX1);
  else if (out.includes(CLOSE_FIX1_V2_BUGGY)) out = out.split(CLOSE_FIX1_V2_BUGGY).join(CLOSE_FIX1);
  else if (out.includes(CLOSE_FIX1_V2)) out = out.split(CLOSE_FIX1_V2).join(CLOSE_FIX1);
  if (out.includes(CLOSE_MARK2)) out = out.split(CLOSE_MARK2).join(CLOSE_FIX2);
  else if (out.includes(CLOSE_FIX2_V1)) out = out.split(CLOSE_FIX2_V1).join(CLOSE_FIX2);
  if (out.includes(CLOSE_MARK3)) out = out.split(CLOSE_MARK3).join(CLOSE_FIX3);
  else if (out.includes(CLOSE_FIX3_V1)) out = out.split(CLOSE_FIX3_V1).join(CLOSE_FIX3);
  else if (out.includes(CLOSE_FIX3_V2)) out = out.split(CLOSE_FIX3_V2).join(CLOSE_FIX3);
  if (out.includes(CLOSE_BTN_MARK)) out = out.split(CLOSE_BTN_MARK).join(CLOSE_BTN_FIX);
  // OPEN_THREAD_FIX contains its own anchor (the render statement), so an
  // already-patched bundle (installer patched it on disk, proxy re-patches at
  // serve time) must be recognized and left alone, or the assignment would be
  // appended a second time.
  if (out.includes(OPEN_THREAD_FIX)) { /* already applied */ }
  else if (out.includes(OPEN_THREAD_MARK)) out = out.split(OPEN_THREAD_MARK).join(OPEN_THREAD_FIX);
  return out;
}

// ---- Auto-verify: detect + surface post-update UI patch regressions ----
// The proxy is the always-on desktop service that serves the patched UI, so
// it is the natural watchdog: after a Freebuff Desktop update replaces ui/,
// the patch markers silently vanish and the mobile layer + file browser
// stop working. The watcher fetches the raw upstream page and bundle itself
// (bypassing its own injection) and checks the on-disk patch markers: shim
// tag in index.html, bundle markers after a server-side patch pass, and the
// /api/fb/dirlist + /api/fb/perf-report routes. It runs on a timer, reacts
// to a bundle identity change (an app update), and writes a JSON status file
// plus loud journal lines so a regression is caught instead of served.
const UI_PATCH_STATUS_FILE = process.env.FB_UI_PATCH_STATUS_FILE
  || path.join(os.homedir(), '.local', 'share', 'freebuff', 'ui-patch-status.json');
const UI_PATCH_CHECK_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.FB_UI_PATCH_CHECK_INTERVAL_MS || 10 * 60 * 1000),
);

const UI_PATCH_MARKERS = [
  ['CREATE_REUSE', CREATE_REUSE],
  ['SETSTATE_FIX', SETSTATE_FIX],
  ['SCROLL_FIX', SCROLL_FIX],
  ['CLOSE_FIX1', CLOSE_FIX1],
  ['CLOSE_FIX2', CLOSE_FIX2],
  ['CLOSE_FIX3', CLOSE_FIX3],
  ['CLOSE_BTN', CLOSE_BTN_FIX],
  ['OPEN_THREAD', OPEN_THREAD_FIX],
];

function fetchUpstream(up, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: up.hostname, port: up.port || 80, path: pathname }, (res) => {
      if ((res.statusCode || 0) >= 500) {
        res.resume();
        reject(new Error(`upstream ${pathname} returned ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

function writeUiPatchStatus(report) {
  try {
    fs.mkdirSync(path.dirname(UI_PATCH_STATUS_FILE), { recursive: true });
    const tmp = `${UI_PATCH_STATUS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(tmp, UI_PATCH_STATUS_FILE);
  } catch (error) {
    console.error(`[freebuff ui-patch] could not write status file: ${error.message}`);
  }
}

// Fetches the raw upstream HTML + bundle, re-applies the patch pass (which is
// exactly what the proxy serves), and probes the injected routes. Returns a
// normalized report; never throws.
async function checkUiPatches(up, log) {
  const report = {
    product: 'freebuff-gate',
    ok: false,
    checkedAt: new Date().toISOString(),
    bundle: null,
    errors: [],
    warnings: [],
  };
  try {
    const html = await fetchUpstream(up, '/');
    const shimOk = /<script id="fb-desktop-shim">/.test(html.body);
    if (!shimOk) report.errors.push('index.html: fb-desktop-shim tag missing (app update replaced index.html; re-run install)');
    const match = html.body.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    const bundleName = match ? match[0] : null;
    if (!bundleName) {
      report.warnings.push('could not locate main bundle in upstream index.html');
    } else {
      report.bundle = bundleName;
      const bundle = await fetchUpstream(up, '/' + bundleName);
      const patched = patchBundle(bundle.body);
      const missing = UI_PATCH_MARKERS.filter(([name, mark]) => !patched.includes(mark)).map(([name]) => name);
      // A fresh patched bundle after an update would contain the V3 create
      // marker; an unpatched rebuilt bundle fails the create marker check.
      if (missing.length > 0) {
        report.errors.push(`bundle ${bundleName}: missing patch marker(s): ${missing.join(', ')} (app update likely replaced it; re-run install)`);
      }
    }
    for (const route of ['/api/fb/dirlist?path=/', '/api/fb/perf-report']) {
      try {
        const probe = await fetchUpstream(up, route);
        if (probe.status === 404) report.errors.push(`${route} route missing (app update replaced orchestrator.js; re-run install)`);
      } catch (error) {
        report.warnings.push(`${route} probe failed: ${error.message}`);
      }
    }
  } catch (error) {
    report.warnings.push(`upstream unreachable: ${error.message}`);
  }
  report.ok = report.errors.length === 0;
  writeUiPatchStatus(report);
  const summary = report.ok ? 'OK' : 'REGRESSED';
  const lines = [`[freebuff ui-patch] verify ${summary}: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`];
  for (const error of report.errors) lines.push(`  [error] ${error}`);
  for (const warning of report.warnings) lines.push(`  [warn] ${warning}`);
  (log || console.log)(lines.join('\n'));
  return report;
}

let lastProbeAt = 0;
let lastBundleName = null;
let lastEtag = null;
let probeInFlight = null;
let lastProbeReport = null;

function maybeProbeUiPatches(up, force) {
  // One probe in flight at a time; skip if we just ran one (unless forced).
  if (probeInFlight) return probeInFlight;
  if (!force && Date.now() - lastProbeAt < 10_000) return null;
  lastProbeAt = Date.now();
  probeInFlight = checkUiPatches(up, null)
    .then((report) => {
      probeInFlight = null;
      lastProbeReport = report;
      return report;
    })
    .catch((error) => {
      probeInFlight = null;
      console.error(`[freebuff ui-patch] probe failed: ${error.message}`);
    });
  return probeInFlight;
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
  if (req.method === 'GET' && pathname === '/api/fb/ui-patch-status') {
    // Surface the last auto-verify result to any client (browser, agent,
    // installer) without rerunning the probe.
    const report = lastProbeReport || (() => {
      try {
        return JSON.parse(fs.readFileSync(UI_PATCH_STATUS_FILE, 'utf8'));
      } catch (e) {
        return { ok: null, errors: [], warnings: ['no UI patch status recorded yet'] };
      }
    })();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(report));
    return;
  }
  const sniffAd = pathname.startsWith('/api/ad/');
  if (sniffAd) adSniff('proxy-request', { path: pathname, method: req.method, headers: sniffHeaders(req.headers) });
  if (req.method === 'GET' && pathname === '/api/fb/last-ad') {
    // Broadcast inspection: every placement's last known ad (desktop, CLI,
    // or mobile — whichever surface filled last), so any client can see what
    // the proxy would substitute when the upstream auction comes back empty.
    const snapshot = {};
    for (const [placementId, entry] of lastAds) {
      snapshot[placementId] = { ad: entry.ad, at: entry.at };
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ placements: snapshot }));
    return;
  }
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
  // Attach: store an uploaded file from the browser (desktop or mobile
  // WebView) on the server and return its real path so the composer can send
  // it like a native Electron attachment. read-file serves it back for image
  // preview. Handled locally (not forwarded) so mobile uploads land on the
  // desktop even though the orchestrator only has the on-disk route after an
  // installer re-run.
  if (req.method === 'POST' && pathname === '/api/fb/upload') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= FB_MAX_UPLOAD_BYTES) chunks.push(c);
    });
    req.on('end', () => {
      if (size > FB_MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upload too large' }));
        return;
      }
      let rawName = '';
      try { rawName = new URL(req.url || '/', 'http://x').searchParams.get('name') || ''; } catch (e) { /* keep empty */ }
      const name = path.basename(String(rawName).replace(/[\\/]/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'upload';
      try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const file = path.join(UPLOADS_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${name}`);
        fs.writeFileSync(file, Buffer.concat(chunks));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ path: file, name }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    req.on('error', () => res.destroy());
    return;
  }
  if (req.method === 'GET' && pathname === '/api/fb/read-file') {
    let requested = '';
    try { requested = new URL(req.url || '/', 'http://x').searchParams.get('path') || ''; } catch (e) { /* keep empty */ }
    const root = path.resolve(UPLOADS_DIR) + path.sep;
    const full = path.resolve(requested);
    if (!requested || !full.startsWith(root)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden path' }));
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
    return;
  }
  const reqChunks = [];
  if (sniffAd) req.on('data', (c) => reqChunks.push(c));
  let adPlacementId = null;
  if (sniffAd && pathname === '/api/ad/slot') {
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(reqChunks).toString('utf8'));
        if (typeof parsed.placementId === 'string') adPlacementId = parsed.placementId;
      } catch (e) { /* keep null */ }
    });
  }
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
        let body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* keep raw */ }
        // Ad broadcast: remember the last non-empty slot fill per placement,
        // and when the auction comes back empty, serve the cached ad so a
        // fill seen on any surface (Gate Desktop, CLI, Gate Mobile) is
        // re-broadcast to every surface until a fresher one arrives. The
        // substitute is flagged `stale` so callers can tell it from a live
        // fill, and a content-length mismatch is avoided by letting Node
        // re-encode the (possibly different-length) body.
        // A real fill counts when it has a destination to open: the live
        // waiting_room ads carry url:"" with a populated clickUrl, so accept
        // either (the UI renderer reads href = clickUrl || url).
        if (pathname === '/api/ad/slot' && parsed && typeof parsed === 'object') {
          const key = adPlacementId || 'default';
          const live = parsed.ad && typeof parsed.ad === 'object' && parsed.ad.title && (parsed.ad.url || parsed.ad.clickUrl);
          if (live) {
            lastAds.set(key, { ad: parsed.ad, at: Date.now() });
          } else if (devAdBroadcastEnabled()) {
            // Dev mode: fill every empty slot with the placeholder so the
            // render path is always exercised. Takes precedence over the
            // cached-broadcast substitute below.
            parsed = { ad: DEV_AD, dev: true };
            body = JSON.stringify(parsed);
            delete pres.headers['content-length'];
            adSniff('dev-broadcast', { placementId: key });
          } else if (lastAds.has(key)) {
            const entry = lastAds.get(key);
            parsed = { ad: entry.ad, stale: true };
            body = JSON.stringify(parsed);
            delete pres.headers['content-length'];
            adSniff('broadcast-fill', { placementId: key, at: entry.at, ageMs: Date.now() - entry.at });
          }
        }
        adSniff('proxy-response', {
          path: pathname,
          status: pres.statusCode || 200,
          headers: sniffHeaders(pres.headers),
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
          // Detect an upstream bundle replacement (an app update swaps
          // index-*.js) and re-run the UI-patch probe: a fresh unpatched
          // bundle after an update is exactly the regression we must surface.
          const thisEtag = '"' + crypto.createHash('sha1').update(out).digest('hex') + '"';
          const name = pathname.split('/').pop();
          if (lastBundleName !== name || lastEtag !== thisEtag) {
            lastBundleName = name;
            lastEtag = thisEtag;
            maybeProbeUiPatches(up, true);
          }
          if (req.headers['if-none-match'] === thisEtag) {
            res.writeHead(304, { etag: thisEtag, 'cache-control': 'public, max-age=0, must-revalidate' });
            res.end();
            return;
          }
          outHeaders.etag = thisEtag;
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

  // Auto-verify watchdog: probe once shortly after startup (the desktop may
  // start before this service) and then on the check interval. The interval
  // catches an app update that happens while the phone is idle.
  server.uiPatches = {
    probeNow: () => maybeProbeUiPatches(up, true),
    lastReport: () => lastProbeReport,
  };
  // Run the first probe after the server is listening (deferred).
  server.once('listening', () => {
    maybeProbeUiPatches(up, false);
  });
  const ownProbeTimer = setInterval(() => maybeProbeUiPatches(up, false), UI_PATCH_CHECK_INTERVAL_MS);
  ownProbeTimer.unref();
  // Stop the watchdog when the server closes, so tests and restarts do not
  // leak probes against a dead upstream.
  const savedClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(ownProbeTimer);
    return savedClose(cb);
  };

  return server;
}

module.exports = {
  CREATE_MARK,
  CLOSE_FIX1,
  CLOSE_FIX1_V1,
  CLOSE_FIX1_V2_BUGGY,
  CLOSE_FIX1_V2,
  CLOSE_FIX2,
  CLOSE_FIX2_V1,
  CLOSE_FIX3,
  CLOSE_FIX3_V1,
  CLOSE_FIX3_V2,
  CLOSE_BTN_FIX,
  CLOSE_BTN_MARK,
  OPEN_THREAD_FIX,
  OPEN_THREAD_MARK,
  CLOSE_MARK1,
  CLOSE_MARK2,
  CLOSE_MARK3,
  CREATE_REUSE,
  CREATE_REUSE_V1,
  CREATE_REUSE_V6,
  CREATE_REUSE_V2,
  CREATE_REUSE_V3,
  CREATE_REUSE_V4,
  CREATE_REUSE_V5,
  SCROLL_FIX,
  SCROLL_MARK,
  SETSTATE_FIX,
  SETSTATE_MARK,
  SHIM,
  UI_PATCH_MARKERS,
  UI_PATCH_STATUS_FILE,
  UPLOADS_DIR,
  FB_MAX_UPLOAD_BYTES,
  checkUiPatches,
  createProxyServer,
  patchBundle,
};

if (require.main === module) {
  const server = createProxyServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`freebuff tailnet proxy on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
  });
}
