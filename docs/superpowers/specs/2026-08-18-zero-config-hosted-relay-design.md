# Zero-config Freebuff-hosted relay onboarding

## Status

Proposed implementation plan based on approved product direction:

- Freebuff hosts the default multi-tenant relay.
- Desktop is bound to a Freebuff account and signs in once.
- Mobile pairs by QR and does not need a separate account login.
- Tailscale, relay URLs, enrollment tokens, and inbound ports stay out of the normal flow.
- Self-hosted relay and direct Tailscale remain advanced modes.

This document is a plan, not an authorization to claim production readiness or
to switch the current legacy relay transport to end-to-end encryption.

## Product outcome

Fresh user path:

1. Install/open Freebuff Desktop.
2. Sign in to Freebuff once, if needed.
3. Choose **Pair mobile**.
4. Desktop shows a short-lived QR code.
5. Install/open Freebuff Mobile and scan it.
6. Mobile claims pairing and opens the Desktop UI.

User never enters a relay URL, enrollment token, port, firewall rule, or
Tailscale configuration. Desktop maintains an outbound connection to the
hosted relay, so NAT and inbound firewall rules do not become setup work.

## Architecture

```text
Freebuff account service
          │ account/device authorization
          ▼
Desktop app ── local companion ── outbound WSS ──► Freebuff hosted relay
     │                                                │
     │ Pair mobile                                  │ tenant-scoped pairing,
     │                                                │ device registry, streams
     ▼                                                ▼
  QR: fixed app origin + one-time secret      Mobile HTTPS/WSS session
                                                        │
                                                        ▼
                                                Desktop local UI
```

The hosted control plane owns tenant, connector, pairing, device, and session
records. Relay workers handle live connector/mobile streams. A shared durable
store is required; the current in-memory `RelayHub`/`PairingStore` remains valid
for local tests and self-hosted mode only.

The hosted relay exposes a fixed public origin. Client requests may advertise
capabilities, but clients do not select arbitrary relay or UI URLs in the normal
flow. The server returns the canonical origin and the selected transport.

## Shared hosted contract

All hosted responses carry `protocolVersion: 2` while the existing local/self-
hosted contract remains version 1. The contract module validates and normalizes
responses on Desktop, relay tests, and mobile fixtures. Secrets are never
included in logs or QR display text.

### Desktop authorization

Use a Freebuff account device-authorization flow, modeled on OAuth's device
authorization pattern so the companion does not need to read browser cookies or
handle an account password.

```http
POST /v2/desktop/device-auth/start
```

```json
{
  "deviceCode": "local-only-device-code",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://freebuff.com/device",
  "expiresAt": "2026-08-18T12:10:00Z",
  "intervalSeconds": 5
}
```

The Desktop UI opens `verificationUri`, the user signs in and approves the
Desktop, and the local companion polls:

```http
POST /v2/desktop/device-auth/poll
```

On approval, the hosted service returns a connector identity and scoped
credentials. The device code is single-use and never enters the QR:

```json
{
  "tenantId": "t_opaque",
  "connectorId": "c_opaque",
  "accessToken": "short-lived-token",
  "refreshToken": "rotating-token",
  "accessTokenExpiresAt": "2026-08-18T12:20:00Z",
  "relayHttpUrl": "https://relay.freebuff.com",
  "relayWsUrl": "wss://relay.freebuff.com"
}
```

The account service, not the client, assigns `tenantId`. Connector tokens carry
the minimum scopes needed for connection and pairing creation. Managed Desktop
stores refresh credentials in the OS credential store; the current protected
credential file remains the self-hosted fallback.

### Pairing creation

```http
POST /v2/pairings
Authorization: Bearer <connector-access-token>
```

Request contains only optional display name, TTL within server bounds, and
transport capabilities. The server derives tenant, connector, relay origin,
and app origin from authenticated state.

```json
{
  "deviceLabel": "Maya's phone",
  "ttlSeconds": 600,
  "transports": ["relay-v1", "tunnel-v1"]
}
```

Response:

```json
{
  "protocolVersion": 2,
  "pairingId": "p_opaque",
  "pairingUrl": "https://mobile.freebuff.com/pair#pairingId=p_opaque&token=one-time-secret",
  "expiresAt": "2026-08-18T12:10:00Z",
  "transport": {
    "selected": "relay-v1",
    "capabilities": ["relay-v1"],
    "endToEnd": false
  }
}
```

The QR encodes only `pairingUrl`. It never contains account, connector,
provider, Tailscale, or refresh credentials. The URL fragment is stripped from
the mobile address/navigation state immediately after parsing.

### Mobile claim and refresh

```http
POST /v2/pairings/claim
```

```json
{
  "pairingId": "p_opaque",
  "token": "one-time-secret",
  "deviceName": "Pixel 9",
  "devicePublicKey": "base64url-public-key",
  "client": {
    "platform": "android",
    "version": "1.0.0",
    "transports": ["relay-v1", "tunnel-v1"]
  }
}
```

Response returns an opaque device identity, short-lived access token, rotating
device refresh token, canonical relay/UI origin, and selected transport. It
does not return account credentials or unrelated tenant data.

```json
{
  "protocolVersion": 2,
  "deviceId": "d_opaque",
  "deviceToken": "rotating-device-token",
  "accessToken": "short-lived-access-token",
  "accessTokenExpiresAt": "2026-08-18T12:30:00Z",
  "deviceExpiresAt": "2026-11-16T12:00:00Z",
  "relayUrl": "wss://relay.freebuff.com",
  "uiUrl": "https://relay.freebuff.com",
  "transport": {
    "selected": "relay-v1",
    "endToEnd": false
  }
}
```

`POST /v2/sessions/refresh` rotates the mobile access credential and refresh
credential. A short previous-token grace window handles simultaneous foreground
and notification refreshes. Revoke invalidates active sessions and disconnects
live streams.

### Account device administration

Account-authenticated Desktop surfaces use:

- `GET /v2/devices` — list only devices in the account tenant.
- `POST /v2/devices/:deviceId/revoke` — revoke device, refresh credentials,
  active relay sessions, and pending tunnel sessions.

Mobile recovery does not require a mobile account login in this phase: reinstall
or lost-device recovery uses a new Desktop QR. Account-level recovery and
cross-Desktop device management can be added after the first hosted rollout.

## Tenant and relay security

- Every connector, pairing, device, HTTP request, SSE stream, and WebSocket is
  resolved from authenticated tenant claims, never from client-supplied tenant
  IDs.
- Pairings expire after ten minutes, are single-use, and lock after five failed
  token attempts.
- Pairing and device secrets are stored as hashes where the service does not
  need plaintext. Tunnel rendezvous secrets remain control-plane-only and are
  never logged.
- Connector access tokens expire quickly; refresh tokens rotate and are bound to
  connector identity, tenant, and token family.
- Mobile access tokens are short-lived; device refresh tokens are revocable and
  bound to the registered public key.
- Rate limits apply independently by IP, account, connector, pairing, and
  device. Abuse responses do not reveal whether another tenant exists.
- Audit records contain opaque IDs, action, outcome, timestamp, and coarse
  request metadata. They exclude QR fragments, bearer tokens, cookies, request
  bodies, prompts, and provider credentials.
- TLS terminates at the hosted relay. Legacy `relay-v1` remains relay-readable
  and must be labeled accordingly. `tunnel-v1` may claim end-to-end transport
  only after native Android/iOS implementation and review pass.

## User experience states

### Desktop

- `Needs sign-in`: **Sign in to connect mobile**.
- `Authorizing`: verification URL/code, copy/open action, bounded polling.
- `Ready`: **Pair mobile**, QR, expiry countdown, regenerate, cancel.
- `Waiting`: **Waiting for phone** with expiry and cancel.
- `Connected`: device name, last seen, disconnect/revoke.
- `Offline`: connector reconnecting; retry does not regenerate credentials.
- `Account revoked`: sign in again; existing device sessions are cleared.

Advanced settings contain self-hosted relay URL, enrollment token, and direct
Tailscale mode. They are not rendered in the default setup path.

### Mobile

- First screen: **Scan Desktop QR** and optional camera permission explanation.
- Claiming: **Connecting to Freebuff** with cancel.
- Success: open Desktop UI automatically.
- Expired/used QR: **QR expired — ask Desktop to show a new code**.
- Revoked: **This phone was disconnected — scan a new QR**.
- Offline: preserve session and retry with bounded backoff.
- Advanced custom relay entry is hidden behind an explicit developer/self-hosted
  setting.

## Implementation plan

### 1. Contract and compatibility layer

Files:

- Add `src/mobile-connect-hosted-contract.js` with strict schema validation,
  redaction helpers, transport negotiation, and version adapters.
- Extend `src/mobile-connect-protocol.js` only for shared URL/token primitives;
  do not mix hosted tenant policy into local URL validation.
- Add JSON fixtures for successful, expired, revoked, unsupported-transport,
  and malformed responses.

Tests:

- Contract round trips preserve required fields and reject unknown security
  shapes where appropriate.
- QR parser rejects credentials outside the fragment and strips fragment data
  from the returned navigation target.
- Version 1 self-hosted responses remain accepted by the compatibility adapter.

### 2. Hosted account/device authorization

Files:

- Add a hosted control-plane client used by the managed Desktop companion.
- Extend `src/mobile-connect-agent.js` with `hosted login`, `hosted logout`,
  credential refresh, and status commands; keep existing `serve` and `pair`
  flags for self-hosted mode.
- Extend `src/install-mobile-connect.js` so managed install defaults to the
  fixed Freebuff origin and launches account device authorization instead of
  asking for enrollment credentials.

Tests:

- Device-code start/poll success, waiting, denial, expiry, cancellation, and
  account revocation.
- Refresh rotation, stale-token grace, missing credential, and secure-storage
  fallback behavior.
- Managed mode never writes relay enrollment tokens or account passwords.

Dependency:

- Freebuff account service must provide the device authorization and connector
  credential exchange endpoints before managed install can leave beta.

### 3. Hosted relay control plane and tenant isolation

Files/services:

- Add a hosted adapter around the current pairing operations rather than
  changing local `PairingStore` semantics in place.
- Add durable tenant-scoped records for accounts, connectors, pairings, devices,
  token families, sessions, and audit events.
- Update relay authentication to validate signed/scoped connector and device
  tokens and to bind live connections to tenant claims.
- Keep `/v1/*` local/self-hosted compatibility routes; expose `/v2/*` hosted
  routes with canonical origins and explicit transport metadata.

Tests:

- Two tenants cannot list, claim, revoke, or stream through each other's
  resources, including guessed IDs.
- Pairing one-use/expiry/attempt limits, revoke propagation, connector refresh,
  relay restart recovery, and duplicate connector handling.
- Logs and error payloads contain no secrets or cross-tenant existence leaks.

### 4. Desktop Pair mobile experience

Files:

- Add a local companion control seam so the injected UI can request pairing
  without receiving the account refresh token. Prefer a loopback authenticated
  endpoint or OS IPC; do not pass credentials through query strings or QR.
- Extend `src/mobile-ui.js` / `src/mobile-ui.css` with sign-in/link, pairing QR,
  expiry, waiting, and connected-device states.
- Reuse the existing QR matrix logic through a browser-safe SVG/canvas renderer;
  do not make users copy terminal output.
- Add a Desktop settings/device list entry that calls hosted list/revoke APIs.

Tests:

- Chromium fixture covers first-run sign-in, QR render, countdown, regenerate,
  cancel, connected, offline, and revoked states.
- Accessibility tree includes state, expiry, device name, and actionable error
  text; QR image has a text/copy fallback.
- Browser cannot read or display connector refresh credentials.

### 5. Mobile fixed-origin claim flow

Files:

- Android: update `PairingModels.kt`, `PairingApi`, `MainActivity.kt`,
  `RestrictedWebViewClient`, and `SecureSessionStore` for hosted v2 fields and
  fixed-origin defaults.
- iOS: mirror the same claim/session/transport contract and origin allowlist.
- Hide relay URL and custom-origin fields in normal UI; expose them only in an
  explicit self-hosted/developer mode.
- Keep app-generated device key registration and secure session storage.

Tests:

- Android/iOS parser fixtures accept hosted v2 and legacy v1 compatibility data.
- Instrumented test scans a hosted-origin QR, claims without manual URL input,
  loads the UI, refreshes, survives reconnect, and handles revoke.
- Reject wrong-origin QR, malformed fragment, expired pairing, replayed claim,
  and insecure transport.

### 6. Transport negotiation and tunnel rollout

Files:

- Add `transport.selected`, `transport.capabilities`, and `endToEnd` to the
  hosted contract and mobile session model.
- Keep `relay-v1` as the initial hosted default so onboarding can ship before
  native tunnel parity.
- Select `tunnel-v1` only when Desktop, relay, Android, and iOS all advertise
  support and server policy enables it.
- Retain the existing SPAKE2 tunnel tests; add hosted relay rendezvous tests and
  explicit legacy privacy labeling.

Release gate:

- Do not market hosted legacy relay as end-to-end encrypted.
- Promote tunnel transport only after native cross-platform vectors, reconnect,
  replay, key rotation, battery/background, and independent security review pass.

### 7. Operations, rollout, and documentation

- Add feature flags for hosted onboarding and transport selection.
- Ship an internal tenant allowlist first, then a small percentage rollout.
- Track pairing start/claim success, time-to-connect, refresh failures, relay
  disconnects, revoke latency, and transport selection without message content.
- Define data retention, region, quota, incident response, and account deletion
  behavior before public launch.
- Keep self-hosted/Tailscale documentation separate from default onboarding.
- Publish migration instructions for existing connector credential files and
  existing mobile sessions; support legacy clients until the retirement date.
- Add rollback: disable hosted v2 issuance, continue accepting v1 sessions, and
  preserve device revocation.

## Acceptance criteria

- A new user can install Desktop, sign in once, click Pair mobile, scan one QR,
  and reach the Desktop UI without Tailscale or manual networking configuration.
- No normal UI asks for relay URL, enrollment token, port, firewall rule, or
  account password inside the connector.
- QR and API responses never expose account refresh credentials or provider
  secrets.
- Tenant isolation, one-use QR, expiry, refresh, revoke, and reconnect are
  covered by automated tests.
- Self-hosted relay and direct Tailscale mode remain functional as advanced
  options.
- Transport privacy is accurately labeled, and E2E claims are gated on native
  tunnel readiness.

## Open dependencies before implementation approval

- Freebuff account service device-authorization API and connector-token claims.
- Hosted durable storage and relay deployment ownership.
- Desktop local control seam (loopback IPC or native app bridge).
- Browser QR rendering choice compatible with the existing dependency policy.
- Hosted privacy, retention, quota, and regional-routing policy.
