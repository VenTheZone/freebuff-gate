'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.FB_UI_PATCH_STATUS_FILE = path.join(os.tmpdir(), `fb-ui-patch-status-${process.pid}.json`);

const { createProxyServer, patchBundle, CREATE_REUSE, CREATE_REUSE_V2, CREATE_REUSE_V3, CLOSE_FIX1, CLOSE_FIX1_V1, CLOSE_FIX1_V2_BUGGY, CLOSE_FIX2, CLOSE_FIX2_V1, CLOSE_FIX3, CLOSE_FIX3_V1, SETSTATE_FIX, SCROLL_FIX, checkUiPatches, UI_PATCH_STATUS_FILE } = require('./freebuff_tailnet_proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sha1Of(text) {
  return `"${crypto.createHash('sha1').update(text).digest('hex')}"`;
}

// A fake orchestrator that serves one main bundle, one lazy chunk, and a page.
// `state.bundle` is mutable so tests can simulate an upstream rebuild.
function createUpstream(state) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/assets/index-BC09OLJz.js') {
      res.writeHead(200, { 'content-type': 'text/javascript;charset=utf-8' });
      res.end(state.bundle);
      return;
    }
    if (pathname === '/assets/chunk-0.js') {
      res.writeHead(200, { 'content-type': 'text/javascript;charset=utf-8' });
      res.end('console.log("chunk");');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('proxy bundle route serves an ETag and honors If-None-Match', async () => {
  const state = { bundle: 'const APP_BOOT = () => { "index-BC09OLJz"; };' };
  const upstream = createUpstream(state);
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const bundleUrl = `http://127.0.0.1:${proxyPort}/assets/index-BC09OLJz.js`;

    // First request: full body plus a strong ETag over the patched bytes.
    const first = await fetch(bundleUrl);
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    assert.equal(firstBody, state.bundle);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'bundle response carries an ETag');
    assert.equal(etag, sha1Of(firstBody), 'ETag is the sha1 of the served body');
    assert.equal(
      first.headers.get('cache-control'),
      'public, max-age=0, must-revalidate',
      'main bundle revalidates on every load',
    );

    // A matching If-None-Match short-circuits to 304 with no body re-download.
    const revalidated = await fetch(bundleUrl, { headers: { 'if-none-match': etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), '');
    assert.equal(revalidated.headers.get('etag'), etag);

    // A stale If-None-Match gets the full body again.
    const stale = await fetch(bundleUrl, { headers: { 'if-none-match': '"deadbeef"' } });
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), state.bundle);

    // The ETag is stable across identical upstream bodies.
    const again = await fetch(bundleUrl);
    assert.equal(again.headers.get('etag'), etag);

    // An upstream rebuild changes the ETag, and the old ETag no longer 304s.
    state.bundle = 'const APP_BOOT = () => { "index-BC09OLJz"; }; const V2 = true;';
    const rebuilt = await fetch(bundleUrl);
    assert.equal(rebuilt.status, 200);
    const rebuiltBody = await rebuilt.text();
    const rebuiltEtag = rebuilt.headers.get('etag');
    assert.equal(rebuiltBody, state.bundle);
    assert.notEqual(rebuiltEtag, etag);
    assert.equal(rebuiltEtag, sha1Of(rebuiltBody));
    const oldTag = await fetch(bundleUrl, { headers: { 'if-none-match': etag } });
    assert.equal(oldTag.status, 200);

    // Lazy chunks are immutable and carry no ETag.
    const chunk = await fetch(`http://127.0.0.1:${proxyPort}/assets/chunk-0.js`);
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(chunk.headers.get('etag'), null);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('patchBundle rewrites the home-tab mark and leaves unknown bytes alone', () => {
  const mark = 'lr(t,()=>ve.createThread(n,{inheritFromThreadId:i}),"Could not open tab")';
  const patched = patchBundle(`head;${mark};tail;`);
  assert.ok(!patched.includes(mark), 'original create-thread mark is gone');
  assert.ok(patched.includes('fb.homeThread'), 'reuse callback pins the home thread');
  assert.equal(patchBundle('plain javascript'), 'plain javascript');
});

// Upstream fixture for the UI-patch watchdog: serves a page, a bundle, and
// the two injected routes. `state` selects healthy vs regressed content.
function createWatchUpstream(state) {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/') {
      const shim = state.healthy ? '<script id="fb-desktop-shim">window.freebuffDesktop={};</script>' : '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head>${shim}<script src="assets/index-ABC.js"></script></head></html>`);
      return;
    }
    if (pathname === '/assets/index-ABC.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(state.healthy
        ? `${CREATE_REUSE}${SETSTATE_FIX}${SCROLL_FIX}${CLOSE_FIX1}${CLOSE_FIX2}${CLOSE_FIX3}`
        : 'var x = 1;');
      return;
    }
    if (pathname === '/api/fb/dirlist' || pathname === '/api/fb/perf-report') {
      res.writeHead(state.healthy ? 200 : 404, { 'content-type': 'application/json' });
      res.end(state.healthy ? '{}' : '');
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('ui-patch watchdog reports healthy when all markers and routes are present', async () => {
  const upstream = createWatchUpstream({ healthy: true });
  const port = await listen(upstream);
  try {
    const report = await checkUiPatches(new URL(`http://127.0.0.1:${port}`), () => {});
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.bundle, 'assets/index-ABC.js');
    // Status file recorded.
    const onDisk = JSON.parse(fs.readFileSync(UI_PATCH_STATUS_FILE, 'utf8'));
    assert.equal(onDisk.ok, true);
  } finally {
    await close(upstream);
  }
});

test('ui-patch watchdog flags every missing marker after a simulated update', async () => {
  const upstream = createWatchUpstream({ healthy: false });
  const port = await listen(upstream);
  try {
    const report = await checkUiPatches(new URL(`http://127.0.0.1:${port}`), () => {});
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes('fb-desktop-shim')), 'shim loss reported');
    assert.ok(report.errors.some((e) => e.includes('index-ABC.js') && e.includes('CREATE_REUSE')), 'bundle marker loss reported');
    assert.ok(report.errors.some((e) => e.includes('dirlist')), 'dirlist route loss reported');
  } finally {
    await close(upstream);
  }
});

test('patchBundle pins the resolved thread id, not the createThread promise', () => {
  const patched = patchBundle(CREATE_REUSE_V2);
  // V3 must resolve createThread before reading .id; reading it off the
  // Promise stores the literal string "undefined" and breaks the pin.
  assert.ok(!patched.includes('setItem("fb.homeThread",nt.id)'), 'must not pin the un-awaited promise id');
  assert.ok(patched.includes('.then(nt=>{let id=null;try{id=nt&&nt.id||null}'), 'must resolve the thread before pinning');
  assert.ok(patched.includes('setItem("fb.homeThread",id)'), 'pins the resolved thread id');
  // an already-V2-patched bundle upgrades to V3
  assert.notEqual(patched, CREATE_REUSE_V2, 'V2 bundle is upgraded in place');
});

test('patchBundle upgrades V3 home-thread reuse to V4 (wait for hydration, do not stack)', () => {
  const patched = patchBundle(CREATE_REUSE_V3);
  assert.notEqual(patched, CREATE_REUSE_V3, 'V3 bundle is upgraded in place');
  // V4 polls for the pinned thread instead of creating a new one when the
  // store has not hydrated it yet, and only creates when no pin exists.
  assert.ok(patched.includes('k?0:null'), 'pinned-but-unhydrated signals "wait", not "create"');
  assert.ok(patched.includes('if(!pin())return create()'), 'creates only when no pin exists');
  assert.ok(patched.includes('setTimeout(step,200)'), 'polls for hydration');
});

test('patchBundle upgrades close patches so empty home threads can close and delete', () => {
  const patched = patchBundle(`${CLOSE_FIX1_V1}${CLOSE_FIX2_V1}${CLOSE_FIX3_V1}`);
  // V1 close refused all home tabs; V2 allows closing an EMPTY home thread.
  assert.ok(!patched.includes(CLOSE_FIX1_V1), 'CLOSE_FIX1 V1 replaced');
  assert.ok(patched.includes(CLOSE_FIX1), 'CLOSE_FIX1 upgraded to allow empty-home close');
  assert.ok(patched.includes('if(!empty)return'), 'protects home threads that still have messages');
  assert.ok(patched.includes('(u.threads[n]&&u.threads[n].messages||[]).length'), 'CLOSE_FIX2 keeps home tab only when it has messages');
  assert.ok(patched.includes('g.tabs.some(u=>u.home&&u.id===n)?null:ve.close(n)'), 'CLOSE_FIX3 deletes server-side when the home thread is gone');
  assert.ok(patched.includes('localStorage.removeItem("fb.homeThread")'), 'CLOSE_FIX3 drops the pin of a deleted home thread');
});

test('patchBundle repairs the buggy V2 closeTab whose double brace closed the body early', () => {
  // A bad intermediate CLOSE_FIX1 ended the home guard with }} which closed
  // the whole function, leaving the store removal + server delete as dead
  // code. Bundles already carrying it must be repaired in place.
  const patched = patchBundle(`${CLOSE_FIX1_V2_BUGGY}${CLOSE_FIX2}${CLOSE_FIX3}`);
  assert.ok(!patched.includes(CLOSE_FIX1_V2_BUGGY), 'buggy V2 closeTab replaced');
  assert.ok(patched.includes(CLOSE_FIX1), 'fixed CLOSE_FIX1 present');
  assert.ok(!patched.includes('if(!empty)return}}'), 'no double-brace early close remains');
});
