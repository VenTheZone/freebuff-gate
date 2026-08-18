# E2E tunnel for the mobile ↔ desktop data path

**Status:** Phase 1 spike implemented; native mobile adapter and production hardening remain.

**Goal:** stop trusting the managed relay with the mobile session cookie and with
every byte of mobile ↔ desktop traffic, and later let phones connect peer-to-peer
when NAT allows. Inspired by the croc model (rendezvous relay + password-authenticated
key exchange + end-to-end encrypted tunnel, with WebRTC P2P and relay fallback).

**TL;DR:** Phase 1 keeps the existing relay but demotes it to a *blind rendezvous*:
the phone and the desktop agent run a SPAKE2 key exchange through it, then all app
traffic (including the session cookie) rides an AEAD-encrypted tunnel the relay
cannot read. Phase 2 adds WebRTC hole-punching so the data path bypasses the relay
entirely when NAT allows, with the relay (or croc's) as opaque fallback.

---

## 1. Current architecture and data flow

Four components, three ports on the desktop:

| Component | File | Role |
|---|---|---|
| Gateway (8794) | `src/mobile-connect-gateway.js` | Local pairing control plane. `PairingStore`: pairing IDs/tokens, device claim, device registry, access-token rotation, admin device list/revoke. |
| Relay (8795) | `src/mobile-connect-relay.js` | Managed server. Terminates WSS/TLS, provisions connector tokens, issues the **mobile session cookie**, and multiplexes HTTP/SSE/WebSocket between phone and desktop connector. |
| Agent | `src/mobile-connect-agent.js` | Desktop outbound WSS connector to the relay (`/v1/relay/desktop`). Registers as a connector, bridges relay `http.request`/`ws.open` to the local UI (58061) and streams responses back. |
| Mobile app | `android/`, `ios/` | Scans QR, claims pairing, then points its WebView at the relay and installs the relay-issued session cookie. |

Off-tailnet phone flow today:

```
phone WebView ──HTTPS/WSS──► relay (8795) ◄──outbound WSS── agent (desktop) ──HTTP/WS──► local UI (58061)
```

Concretely (Android):

1. QR scan → `POST /v1/pairings/claim` → `PairingSession` (deviceId, accessToken, relayUrl, uiUrl).
2. WebView target = `session.uiUrl` (https) or relay URL; origin guard checks it matches the configured web origin.
3. `POST /v1/mobile/session` with the access token → relay returns a **Set-Cookie** (`__Host-freebuff_session`) → installed into the WebView.
4. WebView loads the relay origin with that cookie; the relay authorizes with the cookie and proxies every request/SSE/WS to the connector → agent → local UI.
5. `TurnNotificationService` streams `/v1/mobile/events` (SSE) with `Bearer <accessToken>`.
6. `ReconnectController` rotates access tokens via `/v1/sessions/refresh`.

## 2. The trust problem today

The relay is the WebView's origin **and** its auth boundary:

- It terminates TLS, so it sees every request/response/SSE/WS frame in plaintext.
- It issues and stores the session cookie, so it can impersonate the phone.
- Its own usage text says: *"It is not end-to-end encrypted from relay operators."*

Whoever runs the relay can read the conversation and act as the user. The pairing
control plane (device registry, revocation) is fine to keep at a server — the data
path is the problem.

## 3. Goals / non-goals

**Goals**

- Relay never sees plaintext app traffic or the session cookie.
- Relay cannot impersonate either peer (mutual auth via PAKE + session keys).
- Forward secrecy: a leaked relay/credential does not decrypt past sessions.
- Keep the pairing UX (QR, device registry, push, revocation) working.
- No change for on-tailnet phones (they already go direct via `tailscale serve`).

**Non-goals (Phase 1)**

- No new native mobile tunnel stack in the smallest step (see §7 for the mobile
  integration that *does* require native code; it is unavoidable for a real E2E
  tunnel, but the protocol is designed so the native surface is small).
- Not interop with the `croc` CLI / e2ecp.com in Phase 1 (we control both ends; see
  §11 for when croc's exact protocol becomes relevant).

## 4. Threat model after Phase 1

| Capability | Relay today | Relay after |
|---|---|---|
| Read app traffic | yes | no (AEAD ciphertext only) |
| Read session cookie | yes | no (cookie never transits the relay) |
| Impersonate phone | yes (owns cookie) | no (PAKE + session keys) |
| Forge/modify traffic | yes (MITM TLS) | no (AEAD, per-message nonce) |
| Drop / delay traffic | yes | yes (still a network hop) |
| Deny service | yes | yes (unavoidable) |

The relay is reduced to a blind rendezvous + opaque relay: it can disrupt but
cannot read or forge.

## 5. Phase 1 — E2E tunnel, relay as blind rendezvous

### 5.1 Components

- **`src/mobile-connect-tunnel.js`**: SPAKE2 handshake, HKDF key schedule,
  sequence-bound AEAD framing, blind relay peer, and HTTP bridge.
- **Agent**: `TunnelAgent` sits between the relay socket and the existing
  upstream bridge.
- **Test phone**: `TunnelPeer` plus a Node loopback HTTP proxy exercises the
  phone → relay → agent → local UI path. Native Android/iOS adapters remain
  follow-up work.

### 5.2 Rendezvous (blind)

- A pairing/rendezvous round carries a high-entropy 32-byte `rendezvousToken`
  (derived from the QR pairing secret) and an ephemeral `sessionId`.
- Both peers open a long-lived WSS to the relay's `/v1/tunnel` rendezvous
  endpoint, presenting the `sessionId`. The relay pairs them and thereafter forwards
  **opaque tunnel bytes** between the two sockets. It never parses them.
- The relay keeps its existing connector/device registry (control plane); it just
  stops being the data-plane origin.

### 5.3 PAKE: SPAKE2 (not croc's custom PAKE)

- Use **SPAKE2** (RFC 9382) over **P-256**, not croc's bespoke construction.
  Rationale: SPAKE2 is a published standard with audited implementations, and we
  control both endpoints so there is no interop constraint with the croc CLI.
- Password input = UTF-8 `rendezvousToken`, mapped to `w` with the documented
  scrypt parameters. SPAKE2 gives mutual authentication and fresh ephemeral keys.
- Message flow through the relay:
  1. both sides send SPAKE2 messages (blinded public keys) → relay relays them.
  2. both derive the same shared secret and RFC confirmation keys.
  3. each side sends a cleartext confirmation MAC; mismatch closes the tunnel.

### 5.4 Crypto spec

| Item | Choice |
|---|---|
| Group | P-256 |
| PAKE | SPAKE2 (RFC 9382), M/N points per spec |
| Token scalar | UTF-8 token → scrypt `N=16384,r=8,p=1`, 48-byte output, fixed protocol salt, reduced modulo P-256 order |
| KDF | RFC transcript `Ke || Ka`; HKDF-SHA256 data keys with context and explicit direction |
| AEAD | AES-256-GCM; frame header (`FBT1`, sequence, nonce) is AAD |
| Nonce | 96-bit random per frame; receiver accepts only next 64-bit sequence |
| Frame limit | 8 MiB including header, ciphertext, and tag after length prefix |
| Forward secrecy | fresh ephemeral P-256 scalar per tunnel; token authenticates the exchange |

### 5.5 Framing and multiplexing

- Reuse the existing `mobile-connect-protocol.js` message vocabulary
  (`http.request`, `http.response.start/chunk/end`, `http.error`, `http.cancel`,
  `ws.open/message/close/error`, `connector.heartbeat`).
- Each binary tunnel frame is `[4-byte length][FBT1][8-byte sequence][12-byte nonce][ciphertext||tag]`.
  The plaintext is a JSON message exactly as today. Multiplexing ids already exist
  (`r_…`, `w_…`), so HTTP and SSE share one stream correctly — the tunnel encrypts
  that stream.
- Add tunnel-only control messages: `tunnel.hello`, `tunnel.heartbeat`,
  `tunnel.rekey`, `tunnel.error`.

### 5.6 Auth and cookie changes (the important simplification)

- **Stop issuing the session cookie at the relay.** The phone's local proxy sends
  the WebView's requests through the tunnel to the agent; the agent forwards them
  to the orchestrator (58060), so the WebView receives the **desktop's own**
  session cookie from the orchestrator's normal login flow — exactly like a
  desktop browser. The relay never sees it.
- The WebView origin becomes the **loopback proxy origin** (the app pins it, as it
  already pins the configured web origin), not the relay. The origin guard in
  `RestrictedWebViewClient`/`GateBrowserEngine` is updated accordingly.
- `/v1/mobile/session` and the relay cookie machinery are retired for tunnel mode
  (kept only for legacy non-tunnel clients during rollout).

### 5.7 Reconnect / keepalive

- Reuse the agent's existing reconnect/backoff (`RETRY_MAX_MS`, jittered expo
  backoff) and heartbeat cadence.
- On tunnel loss: tear down, re-run SPAKE2 with a fresh ephemeral key (new forward
  secrecy), re-establish the tunnel, then replay in-flight HTTP/WS ids. Same
  semantics the agent already has for relay disconnects.

### 5.8 Backward compatibility / rollout

- Protocol versioning: current relay framing = v1; tunnel = v2.
- Phase 1 uses `fb-tunnel-v1` inside the existing blind relay endpoint. Native
  clients can be added later without changing the frame or key schedule.

## 6. Phase 2 — WebRTC P2P with relay fallback

- After the SPAKE2 rendezvous, both sides attempt a **WebRTC data channel**
  (STUN for hole-punching; TURN only if both sides are symmetric NAT).
- If the data channel opens, all tunnel frames flow P2P — the relay stops carrying
  data bytes entirely and is pure rendezvous.
- If hole-punching fails, fall back to relaying the same opaque ciphertext through
  the relay (Phase 1 path). Same framing, same crypto — only the transport
  changes, so P2P vs relay is a drop-in switch.

**Desktop-side cost:** the agent is Node. WebRTC in Node requires a library —
`node-datachannel` (native, fast) or `werift` (pure JS, slower). This is the main
new dependency and the main risk in Phase 2. Mobile WebRTC is native and
well-supported.

## 7. croc / e2ecp.com as the rendezvous (optional, Phase 2)

- `croc` is MIT, and `e2ecp.com` is its browser front-end over the same model.
  No reverse engineering is needed — it can be vendored or run as a subprocess.
- Option A: keep our WSS relay as rendezvous (zero new infra, already deployed).
- Option B: run croc's relay (self-hosted, or `croc.schollz.com`) as the
  rendezvous. Tradeoffs: croc's relay is raw TCP (mobile clients prefer WSS/TLS
  termination), and we would adopt croc's rendezvous wire protocol, which is
  small but means a second protocol to maintain.
- Option C (only if we want real `croc` CLI / e2ecp.com interop): adopt croc's
  exact PAKE + relay protocol end-to-end. Not recommended for Phase 1 — SPAKE2 is
  the better crypto and we own both peers.

## 8. Protocol message table (tunnel, v2)

| Message | Direction | Purpose |
|---|---|---|
| `tunnel.hello` | both | AEAD-confirmed key check, protocol version, nonce seed |
| `http.request` / `http.response.*` / `http.error` / `http.cancel` | both | unchanged vocabulary from v1, now inside AEAD |
| `ws.open` / `ws.message` / `ws.close` / `ws.error` | both | unchanged vocabulary from v1 |
| `connector.heartbeat` + ack | both | keepalive |
| `tunnel.heartbeat` | both | tunnel liveness (distinct from connector heartbeat) |
| `tunnel.rekey` | both | rotate keys after threshold |
| `tunnel.error` | both | fatal tunnel error; triggers reconnect |

## 9. Migration checklist

- [x] `src/mobile-connect-tunnel.js`: SPAKE2 + HKDF + AEAD framing + unit tests
      (RFC vector, replay/order rejection, tamper rejection).
- [x] Agent: Phase 1 tunnel mode behind the relay socket.
- [x] Relay: blind `/v1/tunnel` rendezvous remains compatible with opaque frames.
- [ ] Android: tunnel client + loopback proxy; WebView origin → loopback; retire
      relay cookie install; keep origin pinning.
- [ ] iOS: same as Android.
- [ ] Push (`/v1/mobile/events`) rides the tunnel for tunnel-mode devices.
- [x] End-to-end test: Node test phone ↔ tunneled agent ↔ upstream, including
      JSON, POST body, and SSE streaming.
- [x] Docs: Phase 1 implementation status recorded here.

## 10. Risks and open questions

- **Native mobile tunnel client** is the biggest new surface (Kotlin + Swift).
  Mitigate: keep it a thin loopback proxy; all crypto in the shared spec, not
  reimplemented per platform.
- **WebRTC in Node** (Phase 2) is the main dependency risk.
- **Cookie semantics**: the WebView now talks to the orchestrator's real login.
  Needs a UX pass (the phone currently never logs in; it inherits the desktop
  session). Decide: auto-login via the desktop's session through the tunnel, or an
  explicit in-WebView login.
- **Replay window** sizing for out-of-order tunnel frames over the relay.
- **Battery/idle** behavior for a persistent tunnel matches the current WSS agent;
  reuse its pauses.

## 11. References

- RFC 9382 — SPAKE2, a Password-Authenticated Key Exchange.
- https://github.com/schollz/croc (MIT) — rendezvous relay + PAKE + WebRTC model.
- https://e2ecp.com — croc's browser front-end (same model).
- `src/mobile-connect-relay.js`, `src/mobile-connect-agent.js`,
  `src/mobile-connect-gateway.js`, `src/mobile-connect-protocol.js`,
  `android/app/src/main/java/com/freebuff/mobile/` — current implementation.
