# Ads zero-fill troubleshooting

**Symptom:** Gate Desktop and Gate Mobile never show an ad. Every auction returns `{"ads":[],"provider":"gravity"}`, the UI receives `{"ad":null}`, and no ad card renders.

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

Log history: ~1,500 auctions, ~1,100 responses, **all HTTP 200, zero non-200, zero
real ad objects ever**.

## Root cause

The ads endpoint validates `surface` against a strict enum —
`"waiting_room" | "freebuff_web_chat" | "chat_assistant" | "cli_chat"` — and only
`waiting_room` has live campaigns today (4 real ads: Google Cloud via BuySellAds).
The desktop slot sends **no surface at all**; the CLI sends `cli_chat`. Neither has
campaigns. Placement ID is ignored; `surface` is the only differentiator.

Secondary bug: the real `waiting_room` ads carry `url: ""` with a populated
`clickUrl`, but the orchestrator's keep-filter requires `title && url`, so even a
real fill would be dropped before reaching the UI. The UI renderer already handles
`href = clickUrl || url`, so the filter is simply too strict.

## Fix options

1. **In our control:** patch the orchestrator so `slotAd()` / `inlineAd()` pass
   `surface: "waiting_room"`, and relax the keep-filter to `title && (url || clickUrl)`.
2. **Ask Codebuff:** add live campaigns to `freebuff_web_chat` (purpose-built for
   Gate Desktop) or `cli_chat` in their gravity dashboard.

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
  gravity fills.
- `GET http://127.0.0.1:58061/api/fb/last-ad` — last non-empty fill per placement
  that the proxy would broadcast to every surface.
