'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.FB_UI_PATCH_STATUS_FILE = path.join(os.tmpdir(), `fb-ui-patch-status-${process.pid}.json`);
// Ad sniffing must never write to the production ~/.config log during tests.
process.env.FB_AD_SNIFF_LOG = path.join(os.tmpdir(), `fb-ad-sniff-${process.pid}.log`);
// Attach uploads must never write to the real ~/.local/share tree.
process.env.FB_UPLOADS_DIR = path.join(os.tmpdir(), `fb-uploads-${process.pid}`);

const { createProxyServer, patchBundle, CREATE_REUSE, CREATE_REUSE_V2, CREATE_REUSE_V3, CREATE_REUSE_V4, CREATE_REUSE_V5, CREATE_REUSE_V6, CLOSE_BTN_FIX, CLOSE_BTN_MARK, CLOSE_FIX1, CLOSE_FIX1_V1, CLOSE_FIX1_V2, CLOSE_FIX1_V2_BUGGY, CLOSE_FIX2, CLOSE_FIX2_V1, CLOSE_FIX3, CLOSE_FIX3_V1, CLOSE_FIX3_V2, SETSTATE_FIX, SCROLL_FIX, OPEN_THREAD_FIX, OPEN_THREAD_MARK, checkUiPatches, UI_PATCH_STATUS_FILE, UPLOADS_DIR } = require('./freebuff_tailnet_proxy');

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

test('patchBundle exposes the native open-thread action to the mobile layer', () => {
  const patched = patchBundle(`head;${OPEN_THREAD_MARK};tail;`);
  assert.ok(
    patched.includes('window.__fbOpenThread=Rq;'),
    'bundle must expose window.__fbOpenThread after the render statement',
  );
  assert.ok(!patched.includes(`${OPEN_THREAD_MARK};tail;`), 'render statement is not duplicated');
  // Idempotent: the installer patches the bundle on disk and the proxy
  // re-patches at serve time, so a second pass must not append the
  // assignment again.
  const repatched = patchBundle(patched);
  assert.equal(
    (repatched.match(/window\.__fbOpenThread=Rq;/g) || []).length,
    1,
    're-patching an already-patched bundle must not duplicate the assignment',
  );
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
        ? `${CREATE_REUSE}${SETSTATE_FIX}${SCROLL_FIX}${CLOSE_FIX1}${CLOSE_FIX2}${CLOSE_FIX3}${CLOSE_BTN_FIX}${OPEN_THREAD_FIX}`
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

test('attach upload + read-file routes store and serve browser attachments', async () => {
  const server = createProxyServer({ upstream: 'http://127.0.0.1:1' });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = Buffer.from('hello attachment');
    const upload = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/fb/upload?name=note.txt`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.payload.name, 'note.txt');
    assert.ok(upload.payload.path.startsWith(UPLOADS_DIR + path.sep), 'upload lands in the uploads dir');
    assert.equal(fs.readFileSync(upload.payload.path, 'utf8'), 'hello attachment');

    const read = await new Promise((resolve, reject) => {
      http.get(`${base}/api/fb/read-file?path=${encodeURIComponent(upload.payload.path)}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.equal(read.status, 200);
    assert.equal(read.body, 'hello attachment');

    const forbidden = await new Promise((resolve, reject) => {
      http.get(`${base}/api/fb/read-file?path=${encodeURIComponent('/etc/passwd')}`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(forbidden, 403);
  } finally {
    await close(server);
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
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

test('patchBundle upgrades V3 home-thread reuse to V7 (wait for hydration, never double-create)', () => {
  const patched = patchBundle(CREATE_REUSE_V3);
  assert.notEqual(patched, CREATE_REUSE_V3, 'V3 bundle is upgraded in place');
  // V7 treats "nothing reusable yet" as "still hydrating": an empty store
  // (no tabs, no threads) and a store with tabs but no loaded threads both
  // poll up to the cap instead of creating, so a slow relay path never
  // stacks an empty thread while the last-message thread is hydrating.
  assert.ok(patched.includes('G.getState().tabs.length||Object.keys(G.getState().threads).length?null:0'), 'unhydrated store signals "wait", hydrated-without-pin signals "create"');
  assert.ok(patched.includes('lastPromptAt'), 'ranks threads by last-message activity');
  assert.ok(patched.includes('Object.keys(G.getState().threads).length)return create'), 'creates only when the store is settled (thread entries loaded, none reusable)');
  assert.ok(patched.includes('tries<60'), 'bounded hydration wait (15s cap), never a give-up that re-creates');
  assert.ok(patched.includes('setTimeout(step,250)'), 'polls for hydration');
  assert.ok(!patched.includes('tries>30'), 'no old bounded give-up that re-creates on a slow phone');
  assert.ok(!patched.includes('tries<24'), '6s no-pin cap removed');
  assert.ok(patched.includes('inflight'), 'serializes concurrent boot-hook creates');
});

test('patchBundle upgrades an already-V4-patched bundle to V7 (slow-phone stacking fix)', () => {
  // V4 shipped with a 6s give-up that re-created + re-pinned on slow phone
  // connects, stacking empties. On-disk bundles still carry it; patchBundle
  // must upgrade it in place rather than leaving it as-is.
  const patched = patchBundle(CREATE_REUSE_V4);
  assert.notEqual(patched, CREATE_REUSE_V4, 'V4 bundle is upgraded in place');
  assert.ok(patched.includes(CREATE_REUSE), 'V7 present');
  assert.ok(!patched.includes('tries>30'), '6s give-up removed');
});

test('patchBundle upgrades an already-V5-patched bundle to V7 (join last-message thread across surfaces)', () => {
  const patched = patchBundle(CREATE_REUSE_V5);
  assert.notEqual(patched, CREATE_REUSE_V5, 'V5 bundle is upgraded in place');
  assert.ok(patched.includes(CREATE_REUSE), 'V7 present');
  assert.ok(!patched.includes(CREATE_REUSE_V5), 'V5 gone');
  // V7 core: open the thread where the user last sent a message so Gate
  // Desktop and Gate Mobile converge instead of each pinning their own.
  assert.ok(patched.includes('lastPromptAt'), 'activity ranking present');
  assert.ok(patched.includes('projectPath===n'), 'candidates restricted to this project');
  assert.ok(patched.includes('t.archivedAt'), 'archived threads excluded');
  assert.ok(patched.includes('newest()'), 'no-activity surfaces converge on the newest thread');
});

test('patchBundle upgrades an already-V6-patched bundle to V7 (wait for hydration to settle instead of 6s give-up)', () => {
  const patched = patchBundle(CREATE_REUSE_V6);
  assert.notEqual(patched, CREATE_REUSE_V6, 'V6 bundle is upgraded in place');
  assert.ok(patched.includes(CREATE_REUSE), 'V7 present');
  assert.ok(!patched.includes(CREATE_REUSE_V6), 'V6 gone');
  assert.ok(!patched.includes('tries<24'), '6s no-pin give-up removed');
  assert.ok(patched.includes('Object.keys(G.getState().threads).length)return create'), 'creates once the store is settled with loaded threads and nothing reusable');
  assert.ok(patched.includes('tries<60'), 'bounded 15s hydration cap');
});

test('patchBundle upgrades close patches so empty threads close and DELETE server-side', () => {
  const patched = patchBundle(`${CLOSE_FIX1_V1}${CLOSE_FIX2_V1}${CLOSE_FIX3_V1}`);
  // V1 close refused all home tabs; V2 allows closing an EMPTY home thread.
  assert.ok(!patched.includes(CLOSE_FIX1_V1), 'CLOSE_FIX1 V1 replaced');
  assert.ok(patched.includes(CLOSE_FIX1), 'CLOSE_FIX1 upgraded to allow empty-home close');
  assert.ok(patched.includes('if(i.home&&!fbEmpty)return'), 'protects home threads that still have messages');
  assert.ok(patched.includes('fbEmpty'), 'emptiness captured for every closed tab');
  assert.ok(patched.includes('(u.threads[n]&&u.threads[n].messages||[]).length'), 'CLOSE_FIX2 keeps home tab only when it has messages');
  assert.ok(patched.includes('fbEmpty?ve.deleteThread(n):ve.close(n)'), 'CLOSE_FIX3 deletes empty threads, closes non-empty ones');
  assert.ok(patched.includes('localStorage.removeItem("fb.homeThread")'), 'CLOSE_FIX3 drops the pin of a deleted home thread');
});

test('patchBundle upgrades an already-V2-patched bundle to the V3 delete-on-close', () => {
  const patched = patchBundle(`${CLOSE_FIX1_V2}${CLOSE_FIX2}${CLOSE_FIX3_V2}`);
  assert.notEqual(patched, `${CLOSE_FIX1_V2}${CLOSE_FIX2}${CLOSE_FIX3_V2}`, 'V2 bundle is upgraded in place');
  assert.ok(patched.includes(CLOSE_FIX1), 'CLOSE_FIX1 upgraded to V3');
  assert.ok(patched.includes(CLOSE_FIX3), 'CLOSE_FIX3 upgraded to V3');
  assert.ok(!patched.includes('g.tabs.some(u=>u.home&&u.id===n)?null:ve.close(n)'), 'old V2 close path replaced');
});

test('patchBundle adds a close button to empty home tabs (CLOSE_BTN)', () => {
  // The vanilla tab bar hides the close button on home tabs (!i&& guard), so
  // an empty pinned home thread could never be closed even with the store
  // patch in place. The render patch must expose the button when the thread
  // has no messages and leave non-home tabs unchanged.
  const patched = patchBundle(CLOSE_BTN_MARK);
  assert.ok(!patched.includes(CLOSE_BTN_MARK), 'vanilla guard replaced');
  assert.ok(patched.includes(CLOSE_BTN_FIX), 'home-close button patch present');
  assert.ok(
    patched.includes('(G.getState().threads[e]&&G.getState().threads[e].messages||[]).length===0'),
    'home close button renders only for empty threads',
  );
  // Idempotent: re-patching the fixed string does not double-wrap it.
  assert.equal(patchBundle(patched), patched);
});

test('proxy re-broadcasts the last known ad when the slot auction comes back empty', async () => {
  // Gravity often returns no fill. Once ANY surface gets a real ad through
  // the proxy, the proxy caches it per placement and serves it back to
  // every surface (Gate Desktop, CLI, Gate Mobile all share this proxy)
  // until a fresher fill arrives.
  const FILL = {
    ad: { title: 'Gravity fill', url: 'https://trygravity.test/c', impUrl: 'https://trygravity.test/i' },
  };
  const EMPTY = { ad: null };
  let responses = [FILL, EMPTY, EMPTY];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(responses[0])) });
    res.end(JSON.stringify(responses.shift()));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const slot = (body) =>
      fetch(`http://127.0.0.1:${proxyPort}/api/ad/slot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const first = await slot({ placementId: 'Desktop-Below-Chat' });
    assert.deepEqual(first, FILL, 'first call passes through the live fill');

    const second = await slot({ placementId: 'Desktop-Below-Chat' });
    assert.equal(second.ad.title, FILL.ad.title, 'empty auction is filled from cache');
    assert.equal(second.stale, true, 'substitute is flagged stale');

    // A different placement has its own slot and is not cross-contaminated.
    const third = await slot({ placementId: 'Desktop-Inline-Chat' });
    assert.equal(third.ad, null, 'unknown placement stays empty until it fills');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('proxy re-broadcasts a real waiting_room ad (url empty, clickUrl set)', async () => {
  // Live waiting_room fills carry url:"" with a populated clickUrl (Google
  // Cloud via BuySellAds). The broadcast cache must accept those as a real
  // fill so the ad is re-broadcast to every surface (Gate Mobile included)
  // when a later auction comes back empty.
  const FILL = {
    ad: {
      adText: 'Sub-second maintenance. 2x read/write performance.',
      title: 'Google Cloud',
      cta: 'Start Free',
      url: '',
      clickUrl: 'https://srv.buysellads.com/ads/click/x/GTND427YCYAICKQYCES4YKQUFTSIV5QUCKSIKZ3JCAAD5K77CTADCK7KC6SDCK7WC6BI65QJCTBDP2JWCEYDP5Q7HEYI553NF6BIC2JECTNCYBZ52K',
      impUrl: 'https://srv.buysellads.com/ads/imp/x/GTND427YCYAICKQYCES4YKQUFTSIV5QUCKSIKZ3JCAAD5K77CTADCK7KC6SDCK7WC6BI65QJCTBDP2JWCEYDP5Q7HEYI553NF6BIC2JECTNCLSZE5QLUCASQ2RUT',
    },
  };
  const EMPTY = { ad: null };
  let responses = [FILL, EMPTY, EMPTY];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(JSON.stringify(responses[0])) });
    res.end(JSON.stringify(responses.shift()));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const slot = (body) =>
      fetch(`http://127.0.0.1:${proxyPort}/api/ad/slot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const first = await slot({ placementId: 'Desktop-Below-Chat' });
    assert.deepEqual(first, FILL, 'first call passes through the live clickUrl-only fill');

    const second = await slot({ placementId: 'Desktop-Below-Chat' });
    assert.equal(second.ad.title, FILL.ad.title, 'clickUrl-only fill is cached and re-broadcast on empty');
    assert.equal(second.stale, true, 'substitute is flagged stale');
    assert.equal(second.ad.url, '', 'url stays empty');
    assert.equal(second.ad.clickUrl, FILL.ad.clickUrl, 'clickUrl survives the broadcast');

    // A different placement is not cross-contaminated.
    const third = await slot({ placementId: 'Desktop-Inline-Chat' });
    assert.equal(third.ad, null, 'unknown placement stays empty until it fills');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('proxy fills empty slots with a dev placeholder when FB_AD_DEV_BROADCAST is set', async () => {
  // Dev-only render-path testing: with the env flag on, every empty
  // /api/ad/slot response carries a clearly-marked placeholder so the ad
  // card can be seen end-to-end before gravity ever fills.
  const EMPTY_BODY = '{"ad":null}';
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(EMPTY_BODY) });
    res.end(EMPTY_BODY);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  const slot = () =>
    fetch(`http://127.0.0.1:${proxyPort}/api/ad/slot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ placementId: 'Dev-Test-Slot' }),
    }).then((r) => r.json());

  process.env.FB_AD_DEV_BROADCAST = '1';
  try {
    const dev = await slot();
    assert.equal(dev.dev, true, 'placeholder response is flagged dev');
    assert.equal(dev.ad.title, 'Freebuff Gate dev ad', 'placeholder title');
    assert.ok(dev.ad.url && dev.ad.impUrl && dev.ad.clickUrl, 'placeholder carries url + impression/click URLs');
    assert.ok(dev.ad.adText, 'placeholder carries ad copy (adText||cta fallback)');
  } finally {
    delete process.env.FB_AD_DEV_BROADCAST;
  }

  // Flag off: empty auction passes through untouched.
  const off = await slot();
  assert.equal(off.ad, null, 'without the flag the empty auction is passed through');
  await close(proxy);
  await close(upstream);
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
