# Ads zero-fill troubleshooting

**Symptom:** Gate Desktop and Gate Mobile never show an ad. Every auction returns `{"ads":[],"provider":"gravity"}`, the UI receives `{"ad":null}`, and no ad card renders.

## Status: RESOLVED (real ads filling end-to-end)

Both in-our-control blockers are fixed and verified live:

1. **Orchestrator patch** — `slotAd()` / `inlineAd()` now send `surface: "waiting_room"`
   (the only surface with live campaigns), and the keep-filter is relaxed to
   `title && (url || clickUrl)`.
2. **Proxy broadcast fix** — the broadcast cache check is relaxed to
   `title && (url || clickUrl)` (committed in `src/freebuff_tailnet_proxy.js`), so
   `url:""` + `clickUrl` fills are cached and re-broadcast to every surface.

Verified against the live stack:

```
POST /api/v1/ads  surface:"waiting_room"  →  200, provider: carbon, ads: 4
auction: {surface:"waiting_room", placementId:"Desktop-Below-Chat"}
         returned=4  kept=4  dropped=0      ← all 4 Google Cloud ads kept
ad: Google Cloud | url="" | clickUrl=true   ← real fill survives the keep-filter

GET  /api/ad/slot (proxy, dev-broadcast off)
call 1 (real fill)  → Google Cloud (cached)
call 2 (empty)      → Google Cloud, stale=true, href = clickUrl   ← re-broadcast
GET  /api/fb/last-ad → placements: ["Desktop-Below-Chat"]
```

## Flow (where ads are intercepted)

```
Gate Desktop UI ──POST /api/ad/slot──► tailnet proxy (58061) ──► orchestrator (58060)
Gate Mobile    ──relay → agent──► same proxy ──► same orchestrator
                                          └─► POST https://www.codebuff.com/api/v1/ads
                                              (Authorization: Bearer <api-key>)
                                              ◄─ {"ads":[],"provider":"gravity"}
```

Both surfaces share the same proxy and orchestrator, so there is one interception
point. The proxy sniffs every `/api/ad/*` exchange and the orchestrator sniffs every
outbound `/api/v1/ads` exchange to `~/.config/freebuff-desktop/ad-sniff.log`. Since a
header-capture patch landed, each line also records the full request and response
headers, so any dump shows the complete HTTP exchange with no replay needed.

## What is ruled out

| Suspect | Verdict | Evidence |
|---|---|---|
| Invalid API token | No | `GET /api/v1/me` → 200 for account kytusdevenn@gmail.com; no token → 401, bad token → 401 `Invalid Codebuff API key` |
| Bad placement IDs | No | `Desktop-Below-Chat` and `Desktop-Inline-Chat` are sent correctly; a bogus ID returns the identical empty response — the API does not validate placements at all |
| Bot / IP / UA filtering | No | Replayed with mobile UAs, residential-looking device payloads, and header variants from the same server — all empty. The response headers show a clean 200 with zero diagnostic signal |
| Lost / malformed traffic | No | The sniffer captures the request and response bodies in full; a direct replay that bypasses the whole Gate stack returns the same empty result |

Log history (pre-fix): ~1,500 auctions, ~1,100 responses, **all HTTP 200, zero
non-200, zero real ad objects ever** — because the desktop slot sent no surface (and
the CLI sent `cli_chat`), and the keep-filter dropped `clickUrl`-only fills.

## Root cause (pre-fix)

The ads endpoint validates `surface` against a strict enum —
`"waiting_room" | "freebuff_web_chat" | "chat_assistant" | "cli_chat"` — and only
`waiting_room` has live campaigns today (4 real ads: Google Cloud via BuySellAds).
The desktop slot sent **no surface at all**; the CLI sent `cli_chat`. Neither has
campaigns. Placement ID is ignored; `surface` is the only differentiator.

Secondary bug: the real `waiting_room` ads carry `url: ""` with a populated
`clickUrl`, so the orchestrator's keep-filter (`title && url`) dropped every real
fill before it reached the UI, and the proxy broadcast cache (`title && url`) never
cached one for re-broadcast. The UI renderer already handles `href = clickUrl || url`.

## Fixes applied (in our control)

1. **Orchestrator patch** (installed app, re-apply after every Freebuff Desktop update):
   - `inlineAd()` → `surface: "waiting_room"` (was `cli_chat`).
   - `slotAd()` → `surface: "waiting_room"` (was none).
   - keep-filter → `title && (url || clickUrl)`.
   - **Inline ads disabled** — the mid-stream `emit({type:"ad"})` path now
     short-circuits, so the ad stays in one fixed below-chat slot and never
     appears at random points in the chat feed (the feed-bloat fix). The
     `/api/ad/slot` placement is unaffected.
   - Re-apply with the same string replacements used in `docs/ads-zero-fill.md`; the
     patch is not yet a script — roll it by hand or script it when the anchors move.
2. **Proxy broadcast fix** (this repo, committed): cache check → `title && (url || clickUrl)`
   in `src/freebuff_tailnet_proxy.js`, with a regression test in
   `src/freebuff-tailnet-proxy.test.js` using the exact live Google Cloud ad shape.

## Still open (not in our control)

- Ask Codebuff to add live campaigns to `freebuff_web_chat` (purpose-built for Gate
  Desktop) or `cli_chat` in their gravity dashboard, so the desktop can fill without
  borrowing the `waiting_room` surface.

## Support contacts

- Codebuff — report that the placements `Desktop-Below-Chat` / `Desktop-Inline-Chat`
  return zero fills and ask whether the placements are registered on the publisher
  account, whether the integration is live, and whether a `waiting_room`-only fill
  is intended.
- Gravity — `support@trygravity.ai` (per Gravity docs, a 204-empty can also mean
  "no ad matches the context or the request is filtered as a bot").

## Debug tooling

- `node src/patch-ad-sniffer.js` — (re)apply the orchestrator sniffer with header
  capture after a Freebuff Desktop update (idempotent, fails loudly if anchors move).
- `FB_AD_DEV_BROADCAST=1` on the proxy — substitute a marked placeholder ad into
  empty `/api/ad/slot` responses so the render path is testable end-to-end before
  gravity fills. Note: when set, it masks real fills too — turn it off to verify a
  live fill (as done above).
- `GET http://127.0.0.1:58061/api/fb/last-ad` — last non-empty fill per placement
  that the proxy would broadcast to every surface.
- `node src/check-ads.js --once` — poll the live auction; `waiting_room` currently
  fills, other surfaces return zero.
