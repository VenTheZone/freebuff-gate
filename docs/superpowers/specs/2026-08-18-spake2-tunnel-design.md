# SPAKE2 tunnel Phase 1 design

## Status

Approved for implementation on 2026-08-18. This is a protocol and integration spike, not a production security claim.

## Goal

Replace the existing X25519-plus-token construction in `src/mobile-connect-tunnel.js` with a standards-based SPAKE2 handshake, retain the blind relay path, prove the phone-to-agent HTTP path with a test phone client, and make the server-side folder picker display complete names.

## Scope

Included:

- SPAKE2-P256-SHA256-HKDF-HMAC using RFC 9382 P-256 M/N points.
- High-entropy rendezvous token mapped to SPAKE2 scalar `w` with a documented scrypt configuration.
- Mutual SPAKE2 HMAC confirmation before application data.
- HKDF-derived directional AES-256-GCM keys.
- Sequence-bound binary AEAD frames with bounded size, nonce, AAD, replay, and ordering checks.
- Existing blind relay rendezvous, `TunnelAgent` upstream HTTP bridge, and Node test phone loopback proxy.
- Unit and integration tests for handshake, key schedule, frame tampering/replay, and tunneled HTTP/SSE.
- Folder picker label and breadcrumb wrapping, full-text title/ARIA metadata, and regression coverage.

Excluded:

- Production deployment or claim of a completed security audit.
- Native Android/iOS SPAKE2 adapters, reconnect/rekey policy, and WebRTC transport.
- Changes to unrelated existing worktree edits.

## Crypto design

### SPAKE2

Use P-256 with the RFC 9382 fixed points:

- `M = 02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f`
- `N = 03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49`

The mobile/test-phone role is A and uses M. The desktop-agent role is B and uses N. Both sides generate a fresh uniform scalar for each handshake. The rendezvous token is processed with Node scrypt using a fixed protocol salt and a 48-byte output; the result is reduced modulo the P-256 order to form `w`. The exact method is shared by both test peers and is covered by a known-vector-style deterministic scalar test.

The token bytes are its UTF-8 encoding. Use scrypt `N=16384`, `r=8`, `p=1`, output length 48, and ASCII salt `freebuff-gate/tunnel/v1/spake2`; reject a zero scalar after reduction. The transcript uses explicit identities (`freebuff-gate/mobile` and `freebuff-gate/agent`), both encoded SPAKE2 messages, the derived group element K, and fixed-width big-endian `w`, with RFC 9382 little-endian 64-bit length prefixes. SHA-256 yields `Ke || Ka`; HKDF derives confirmation MAC keys from `Ka`. Each side sends and verifies its RFC confirmation MAC before becoming ready.

Point parsing must reject malformed, non-curve, and infinity points. Failed confirmation, wrong token, duplicate handshake messages, or invalid role/protocol closes the peer.

### Tunnel data keys

Let `T = SHA256(TT)`. HKDF-Extract uses salt `SHA256("freebuff-gate/tunnel/v1" || 0x00 || T)` and input key material `Ke`. HKDF-Expand uses info `"freebuff-gate/tunnel/v1" || 0x00 || direction`, where direction is `mobile-to-agent` or `agent-to-mobile`, to produce separate 32-byte AES-256-GCM keys. The rendezvous token is not directly concatenated into the data KDF; SPAKE2 authenticates it first.

### Frame format

Each WebSocket binary message contains one frame. The length is the number of bytes after the length field and must be at least the fixed header plus a 16-byte tag and no more than the configured 8 MiB frame limit:

```
4-byte big-endian frame length
4-byte ASCII magic/version: FBT1
8-byte big-endian sequence number
12-byte random nonce
ciphertext || 16-byte GCM tag
```

The magic, sequence, and nonce are GCM associated data. Receiver accepts only the next sequence number, rejects frames above the configured size limit, authenticates before JSON parsing, and closes on malformed/replayed/out-of-order data. The plaintext remains the existing JSON message vocabulary so HTTP/SSE multiplexing stays unchanged.

## Components and data flow

1. Agent and test phone connect to relay blind rendezvous endpoint.
2. `TunnelPeer` exchanges cleartext SPAKE2 public messages and HMAC confirmations.
3. Both peers derive directional data keys and accept application frames.
4. Test phone loopback proxy serializes HTTP requests into tunnel JSON.
5. `TunnelAgent` decrypts requests and forwards them to the local upstream UI.
6. Upstream responses stream back as encrypted response messages.

The relay only forwards opaque WebSocket payloads. It can drop or delay traffic but cannot derive keys or forge authenticated frames.

## Testing

- SPAKE2 handshake with matching token produces identical keys and both peers reach ready.
- Wrong token fails confirmation and never reaches ready.
- RFC P-256 M/N constants and deterministic scalar/transcript derivation are checked against independent literals.
- Directional keys differ; same-direction decrypt works; opposite direction fails.
- AEAD round trip succeeds; modified header, nonce, ciphertext, tag, length, replayed sequence, and out-of-order sequence fail.
- Full relay → test phone loopback → encrypted tunnel → agent → upstream path covers JSON, POST body, and SSE stream.
- Syntax and existing relevant Node suites remain green.
- Folder picker regression verifies wrapping rules and full label metadata are present in injected shim.

## Folder picker UX

Folder rows use flexible, wrapping text with `min-width: 0`, `overflow-wrap: anywhere`, and readable line height. Breadcrumbs wrap on narrow screens. Each row and breadcrumb also carries full text in `title`/accessible metadata, so the complete name remains discoverable even when the viewport is constrained. No ellipsis is used for selectable folder names.

## Risks and follow-up

This spike uses a third-party point-arithmetic library and a Node test phone. Before native mobile rollout, add an Android implementation using a reviewed provider/library and cross-check it against the Node vectors. Before production, complete independent crypto review, add reconnect/rekey limits, and decide whether the relay endpoint needs authenticated occupancy protection.
