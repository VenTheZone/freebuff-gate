// perf-probe.js — in-page page-load / asset-fetch waterfall.
// Injected by the tailnet proxy (dormant unless activated). Activation:
// append ?fbperf=1 (or #fbperf) to the URL. Collects Navigation Timing +
// Resource Timing, renders a waterfall overlay, and POSTs the same data to
// /api/fb/perf-report on the proxy, which logs it to
// ~/.config/freebuff-desktop/perf-report.log for side-by-side comparison
// (the proxy tags each line with a `client`: webview | firefox | browser).
(function () {
  'use strict';
  // Idempotence guard: the orchestrator injects this into index.html and the
  // tailnet proxy can inject it again on the same page. Run only the first copy.
  if (window.__fbPerfProbe) return;
  window.__fbPerfProbe = true;
  var activated = false;
  try {
    var q = location.search || '';
    var h = location.hash || '';
    activated = /(\?|&)fbperf(=|&|$)/.test(q) || /#fbperf/.test(h);
  } catch (e) {
    return;
  }
  if (!activated) return;

  var DONE = false;

  function navTiming() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        return {
          kind: 'document',
          name: location.href.split('#')[0],
          startTime: 0,
          duration: Math.round(nav.duration),
          redirect: Math.round(nav.redirectEnd - nav.redirectStart),
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          connect: Math.round(nav.connectEnd - nav.connectStart),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          response: Math.round(nav.responseEnd - nav.responseStart),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          transferSize: nav.transferSize || 0,
          encodedBodySize: nav.encodedBodySize || 0,
          decodedBodySize: nav.decodedBodySize || 0,
          protocol: nav.nextHopProtocol || ''
        };
      }
    } catch (e) { /* fall through to legacy timing */ }
    try {
      var t = performance.timing;
      if (t && t.navigationStart) {
        return {
          kind: 'document',
          name: location.href.split('#')[0],
          startTime: 0,
          duration: Math.round(t.loadEventEnd - t.navigationStart),
          redirect: Math.round(t.redirectEnd - t.redirectStart),
          dns: Math.round(t.domainLookupEnd - t.domainLookupStart),
          connect: Math.round(t.connectEnd - t.connectStart),
          ttfb: Math.round(t.responseStart - t.requestStart),
          response: Math.round(t.responseEnd - t.responseStart),
          domContentLoaded: Math.round(t.domContentLoadedEventEnd - t.navigationStart),
          load: Math.round(t.loadEventEnd - t.navigationStart),
          transferSize: 0,
          encodedBodySize: 0,
          decodedBodySize: 0,
          protocol: ''
        };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function collect() {
    var entries = [];
    var doc = navTiming();
    if (doc) entries.push(doc);
    try {
      performance.getEntriesByType('resource').forEach(function (r) {
        entries.push({
          kind: r.initiatorType || 'resource',
          name: r.name,
          startTime: Math.round(r.startTime),
          duration: Math.round(r.duration),
          ttfb: Math.round(r.responseStart - r.requestStart),
          transferSize: r.transferSize || 0,
          encodedBodySize: r.encodedBodySize || 0,
          decodedBodySize: r.decodedBodySize || 0,
          protocol: r.nextHopProtocol || ''
        });
      });
    } catch (e) { /* ignore */ }
    entries.sort(function (a, b) { return a.startTime - b.startTime; });
    return entries;
  }

  function fmtBytes(n) {
    if (!n) return '0';
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1048576).toFixed(2) + 'MB';
  }

  function shortName(name) {
    var s = String(name || '');
    try {
      var u = new URL(s);
      s = u.pathname || s;
    } catch (e) { /* keep raw */ }
    var i = s.lastIndexOf('/');
    if (i >= 0) s = s.slice(i + 1);
    if (s.length > 42) s = s.slice(0, 19) + '…' + s.slice(-20);
    return s;
  }

  function render(summary, entries) {
    var maxDur = 1;
    entries.forEach(function (e) { if (e.duration > maxDur) maxDur = e.duration; });

    var rows = entries.map(function (e) {
      var w = Math.max(0.6, (e.duration / maxDur) * 100).toFixed(1);
      return (
        '<div class="fbp-row">' +
        '<div class="fbp-name" title="' + String(e.name || '').replace(/"/g, '&quot;') + '">' +
        shortName(e.name) + '</div>' +
        '<div class="fbp-num">' + e.startTime + 'ms</div>' +
        '<div class="fbp-track"><div class="fbp-bar" style="width:' + w + '%"></div></div>' +
        '<div class="fbp-num fbp-dur">' + e.duration + 'ms</div>' +
        '<div class="fbp-num fbp-size">' + fmtBytes(e.transferSize) + '</div>' +
        '</div>'
      );
    }).join('');

    var doc = summary.document || {};
    var docLine = doc.duration != null
      ? 'TTFB ' + (doc.ttfb || 0) + 'ms · DNS ' + (doc.dns || 0) + 'ms · connect ' +
        (doc.connect || 0) + 'ms · DOM ' + (doc.domContentLoaded || 0) + 'ms · load ' +
        (doc.load || 0) + 'ms'
      : '';

    var host = document.createElement('div');
    host.id = 'fbp-overlay';
    host.innerHTML =
      '<div class="fbp-box">' +
      '<div class="fbp-head">' +
      '<span>Perf waterfall</span>' +
      '<span class="fbp-actions">' +
      '<button type="button" data-fbp="copy">Copy JSON</button>' +
      '<button type="button" data-fbp="close">×</button>' +
      '</span>' +
      '</div>' +
      '<div class="fbp-summary">' +
      'load ' + (doc.duration || 0) + 'ms · ' + summary.count + ' requests · ' +
      fmtBytes(summary.totalTransferSize) + ' transferred<br>' +
      '<span class="fbp-muted">' + docLine + '</span>' +
      '</div>' +
      '<div class="fbp-cols"><span>resource</span><span>start</span><span></span>' +
      '<span>dur</span><span>bytes</span></div>' +
      '<div class="fbp-rows">' + rows + '</div>' +
      '<div class="fbp-foot">logged to perf-report.log</div>' +
      '</div>';
    var style = document.createElement('style');
    style.textContent =
      '#fbp-overlay{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(0,0,0,.6);font:12px/1.4 system-ui,-apple-system,sans-serif}' +
      '.fbp-box{width:min(100%,760px);max-height:86vh;display:flex;flex-direction:column;padding:14px;box-sizing:border-box;border:1px solid #333;border-radius:12px;background:#101114;color:#e8eaed}' +
      '.fbp-head{display:flex;justify-content:space-between;align-items:center;font-weight:650;font-size:14px}' +
      '.fbp-actions{display:flex;gap:8px}' +
      '.fbp-actions button{min-height:30px;padding:4px 10px;border:1px solid #3a3d42;border-radius:7px;background:#1c1e22;color:#e8eaed;font:inherit;cursor:pointer}' +
      '.fbp-actions button:hover{background:#26282d}' +
      '.fbp-summary{margin:10px 0;color:#d6d9dd}' +
      '.fbp-muted{color:#8a8f96;font-size:11px}' +
      '.fbp-cols,.fbp-row{display:grid;grid-template-columns:1fr 64px 1fr 64px 64px;gap:6px;align-items:center}' +
      '.fbp-cols{color:#8a8f96;font-size:10.5px;margin-top:4px;padding:0 2px}' +
      '.fbp-rows{flex:1;overflow-y:auto;min-height:120px;border-top:1px solid #26282d;margin-top:2px}' +
      '.fbp-row{padding:3px 2px;border-bottom:1px solid rgba(255,255,255,.04)}' +
      '.fbp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8eaed}' +
      '.fbp-num{text-align:right;color:#9aa0a6;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '.fbp-dur{color:#d6d9dd}' +
      '.fbp-size{color:#7fce9a}' +
      '.fbp-track{height:8px;border-radius:4px;background:#1c1e22;overflow:hidden}' +
      '.fbp-bar{height:100%;background:linear-gradient(90deg,#3b82f6,#7fce9a);border-radius:4px}' +
      '.fbp-foot{margin-top:10px;color:#6f757c;font-size:11px}';
    (document.body || document.documentElement).appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    var btn = host.querySelector('[data-fbp="copy"]');
    var close = host.querySelector('[data-fbp="close"]');
    if (btn) {
      btn.addEventListener('click', function () {
        try {
          var payload = JSON.stringify({ summary: summary, entries: entries });
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(payload).catch(function () { /* noop */ });
          }
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy JSON'; }, 1500);
        } catch (e) { /* noop */ }
      });
    }
    if (close) close.addEventListener('click', function () { host.remove(); });
  }

  function run() {
    if (DONE) return;
    DONE = true;
    var entries = collect();
    var totalTransfer = 0;
    entries.forEach(function (e) { totalTransfer += e.transferSize || 0; });
    var summary = {
      ua: navigator.userAgent,
      url: location.href.split('#')[0],
      collectedAt: Date.now(),
      count: entries.length,
      totalTransferSize: totalTransfer,
      document: entries[0] && entries[0].kind === 'document' ? entries[0] : null
    };
    try {
      fetch('/api/fb/perf-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: summary, entries: entries })
      }).catch(function () { /* noop */ });
    } catch (e) { /* noop */ }
    render(summary, entries);
  }

  var grace = 1600;
  if (document.readyState === 'complete') {
    setTimeout(run, grace);
  } else {
    window.addEventListener('load', function () { setTimeout(run, grace); });
  }
  // Safety net: never leave the probe hanging if the load event was missed.
  setTimeout(run, 9000);
})();
