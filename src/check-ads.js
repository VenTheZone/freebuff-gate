#!/usr/bin/env node
/**
 * check-ads.js — poll the Freebuff ad auction and report when ads fill.
 *
 * Freebuff Desktop serves ads by auctioning placements against the Codebuff
 * ads API (https://www.codebuff.com/api/v1/ads). The auction can legitimately
 * return an empty `ads` array ("no fill") — nothing to render. This script
 * polls that same endpoint, with the same request shape and auth the desktop
 * app uses, and exits as soon as the network actually returns an ad.
 *
 * Usage:
 *   node src/check-ads.js                 # poll every 60s until an ad fills
 *   node src/check-ads.js --once          # single auction, report, exit
 *   node src/check-ads.js --interval 10   # poll every 10 seconds
 *   node src/check-ads.js --max-polls 5   # give up after 5 polls (exit 1)
 *   node src/check-ads.js --placement Desktop-Below-Chat
 *   node src/check-ads.js --quiet         # only print fills / errors
 *
 * Auth is read from ~/.config/freebuff-desktop/state.json
 * (authSessions["https://www.codebuff.com"].token), or from the
 * CODEBUFF_API_KEY env var. Override the state file with --state-file.
 *
 * Exit codes:
 *   0  an ad came back from the auction
 *   1  polled N times with no fill (--max-polls) or --once saw no fill
 *   2  no auth token available
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADS_ENDPOINT = "https://www.codebuff.com/api/v1/ads";
const STATE_FILE_DEFAULT = path.join(
  os.homedir(),
  ".config",
  "freebuff-desktop",
  "state.json",
);
const API_HOST = "https://www.codebuff.com";
const REQUEST_TIMEOUT_MS = 15_000;
// Mirror the browser-like UA the desktop app sends to ad providers.
const AD_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PLACEMENTS = [
  { placementId: "Desktop-Below-Chat", surface: undefined },
  { placementId: "Desktop-Inline-Chat", surface: "cli_chat" },
];

function parseArgs(argv) {
  const args = {
    interval: 60,
    maxPolls: Infinity,
    once: false,
    quiet: false,
    stateFile: STATE_FILE_DEFAULT,
    placements: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--once":
        args.once = true;
        args.maxPolls = 1;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      case "--interval":
        args.interval = Number(argv[++i]);
        break;
      case "--max-polls":
        args.maxPolls = Number(argv[++i]);
        break;
      case "--state-file":
        args.stateFile = argv[++i];
        break;
      case "--placement": {
        const id = argv[++i];
        const match = PLACEMENTS.find(
          (p) => p.placementId === id || (p.surface && p.surface === id),
        );
        if (!match) {
          console.error(
            `Unknown placement "${id}". Use one of: ${PLACEMENTS.map(
              (p) => p.placementId,
            ).join(", ")}`,
          );
          process.exit(2);
        }
        args.placements = args.placements ?? [];
        args.placements.push(match.placementId);
        break;
      }
      default:
        console.error(`Unknown option: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

function readToken(args) {
  const envToken = process.env.CODEBUFF_API_KEY;
  if (envToken) return envToken;
  try {
    const state = JSON.parse(fs.readFileSync(args.stateFile, "utf8"));
    const session = state.authSessions?.[API_HOST];
    if (session?.token) return session.token;
  } catch {
    // fall through to the error below
  }
  return null;
}

function deviceInfo() {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  return {
    os:
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux",
    timezone: resolved.timeZone,
    locale: resolved.locale,
  };
}

async function auction(token, placement, sessionId) {
  const body = {
    ...(placement.surface ? { surface: placement.surface } : {}),
    placementId: placement.placementId,
    messages: [],
    sessionId,
    device: deviceInfo(),
    userAgent: AD_UA,
  };
  let res;
  try {
    res = await fetch(ADS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "User-Agent": `Freebuff-Desktop/${process.env.FREEBUFF_APP_VERSION ?? "dev"}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `request failed: ${err.message}` };
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body; surface it raw
  }

  const ads = Array.isArray(json?.ads) ? json.ads : [];
  return {
    status: res.status,
    ok: res.ok,
    provider: json?.provider ?? null,
    count: ads.length,
    ads,
    raw: text,
  };
}

function formatAd(ad) {
  return `${ad.title} — ${ad.url} (imp ${ad.impUrl})`;
}

async function pollOnce(token, args, sessionId) {
  const placements = PLACEMENTS.filter(
    (p) => !args.placements || args.placements.includes(p.placementId),
  );
  let filled = false;
  for (const placement of placements) {
    const r = await auction(token, placement, sessionId);
    const stamp = new Date().toISOString();
    if (r.error) {
      if (!args.quiet) console.log(`[${stamp}] ${placement.placementId}: ${r.error}`);
      continue;
    }
    if (!r.ok) {
      console.log(
        `[${stamp}] ${placement.placementId}: HTTP ${r.status} (provider ${r.provider ?? "?"}) — ${r.raw.slice(0, 200)}`,
      );
      continue;
    }
    const summary = `HTTP ${r.status}, provider ${r.provider ?? "?"}, ${r.count} ad(s)`;
    if (r.count > 0) {
      console.log(
        `[${stamp}] ${placement.placementId}: FILL — ${summary}\n  ${r.ads.map(formatAd).join("\n  ")}`,
      );
      filled = true;
    } else if (!args.quiet) {
      console.log(`[${stamp}] ${placement.placementId}: no fill — ${summary}`);
    }
  }
  return filled;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = readToken(args);
  if (!token) {
    console.error(
      `No auth token found. Looked in ${args.stateFile} (authSessions["${API_HOST}"]) and $CODEBUFF_API_KEY.`,
    );
    process.exit(2);
  }

  const sessionId = `check-ads-${process.pid}`;
  const started = Date.now();
  let poll = 0;

  for (;;) {
    poll++;
    const filled = await pollOnce(token, args, sessionId);
    if (filled) {
      console.log(`Ad fill confirmed on poll ${poll}.`);
      process.exit(0);
    }
    if (poll >= args.maxPolls) {
      if (args.once) {
        console.log("No fill — the auction returned no ads.");
      } else {
        console.log(
          `No fill after ${poll} poll(s) over ${Math.round((Date.now() - started) / 1000)}s.`,
        );
      }
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, args.interval * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
