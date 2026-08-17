#!/usr/bin/env node
/**
 * patch-ad-sniffer.js — (re)apply the ad request/response sniffer to the
 * installed Freebuff Desktop orchestrator.
 *
 * The sniffer wraps the Ads class post() call so every outbound ad exchange
 * (browser -> orchestrator is captured by the tailnet proxy in
 * freebuff_tailnet_proxy.js; this is the orchestrator -> codebuff.com half)
 * appends a JSON line to ~/.config/freebuff-desktop/ad-sniff.log. The
 * version applied here also records the FULL request and response headers
 * (token and cookie values redacted), so the whole HTTP exchange is visible
 * without replaying anything.
 *
 * The packaged orchestrator is overwritten on every Freebuff Desktop update,
 * so re-run this after an update (idempotent: already-patched is left alone,
 * and a patch whose anchors no longer match fails LOUDLY instead of silently
 * shipping a stock orchestrator).
 *
 * Usage:
 *   node src/patch-ad-sniffer.js             # apply / report state
 *   node src/patch-ad-sniffer.js --desktop-dir <path>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { findFreebuffDesktop, orchestratorDirOf } = require('./install-mobile-connect');

// Request sniff: add the exact headers the outbound fetch sends, with the
// bearer token value redacted (matches the existing `auth: present` posture).
const REQUEST_MARK =
  'adSniff("request", { path: path22, body: body2, auth: token ? "present" : "none" });';
const REQUEST_FIX =
  'adSniff("request", { path: path22, body: body2, auth: token ? "present" : "none", headers: { Authorization: token ? "Bearer <redacted>" : "(none)", "content-type": "application/json", "User-Agent": DESKTOP_AD_REQUEST_USER_AGENT } });';

// Response sniff: add every response header. set-cookie is dropped from the
// map because the existing sniff already logs its value in the `setCookie`
// field; the rest of the headers show the exchange shape (server, cache,
// vary, rate limits, ...).
const RESPONSE_MARK =
  'contentType: res.headers.get("content-type") ?? null,\n          body: (() => { try { return JSON.parse(sniffBody); } catch { return sniffBody.slice(0, 2000); } })()';
const RESPONSE_FIX =
  'contentType: res.headers.get("content-type") ?? null,\n          headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== "set-cookie")),\n          body: (() => { try { return JSON.parse(sniffBody); } catch { return sniffBody.slice(0, 2000); } })()';

function parseArgs(argv) {
  const args = { desktopDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--desktop-dir') args.desktopDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node src/patch-ad-sniffer.js [--desktop-dir <path>]');
      process.exit(0);
    }
  }
  return args;
}

function writeAtomically(file, body) {
  const tmp = `${file}.fb-sniff.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tmp, file);
}

function apply(file) {
  const body = fs.readFileSync(file, 'utf8');
  if (body.includes(REQUEST_FIX) && body.includes(RESPONSE_FIX)) {
    return { file, outcome: 'already-patched' };
  }
  let out = body;
  let changed = false;
  if (out.includes(REQUEST_MARK)) {
    out = out.split(REQUEST_MARK).join(REQUEST_FIX);
    changed = true;
  } else if (!out.includes(REQUEST_FIX)) {
    throw new Error(`ad request sniff anchor missing (app updated?): ${file}`);
  }
  if (out.includes(RESPONSE_MARK)) {
    out = out.split(RESPONSE_MARK).join(RESPONSE_FIX);
    changed = true;
  } else if (!out.includes(RESPONSE_FIX)) {
    throw new Error(`ad response sniff anchor missing (app updated?): ${file}`);
  }
  if (!changed) return { file, outcome: 'already-patched' };
  writeAtomically(file, out);
  return { file, outcome: 'patched' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const desktopDir = findFreebuffDesktop({ desktopDir: args.desktopDir });
  const orchestratorDir = orchestratorDirOf(desktopDir);
  const file = path.join(orchestratorDir, 'orchestrator.js');
  if (!fs.existsSync(file)) throw new Error(`orchestrator.js not found: ${file}`);
  const result = apply(file);
  console.log(`Freebuff Desktop: ${desktopDir}`);
  console.log(`ad sniffer: ${result.outcome} — ${file}`);
  if (result.outcome === 'patched') {
    console.log('Restart the orchestrator service to load the updated sniffer.');
  }
  return result.outcome === 'patched' ? 0 : 0;
}

if (require.main === module) {
  main();
}

module.exports = { apply, applyAdSnifferPatch: apply, REQUEST_FIX, RESPONSE_FIX };
