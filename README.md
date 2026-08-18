# Freebuff Gate

Freebuff Gate adapts the **Freebuff Desktop** UI for two uses:

- **Gate Desktop**: the full desktop UI in a plain web browser. The server
  exposes it on 127.0.0.1:58060, or through the tailnet proxy on 58061.
- **Gate Mobile**: the same UI adapted for phones and tablets. The tailnet
  proxy injects the mobile layer, and the Freebuff Gate Android/iOS apps
  provide the companion clients.

The project also includes folder-selection support. Freebuff Desktop can open
native folder dialogs. Browsers cannot, so the browser port uses web APIs. Its
configuration lives in (`freebuff-gate/.freebuff-gate.json`), with a reference
implementation in (`src/folder-select.js`).

## Contents

| Path | Purpose |
| --- | --- |
| `.freebuff-gate.json` | The dotfile configuration for the browser port (app, auth, workspace, UI prefs; `folderSelection` block is legacy documentation now that the picker is server-side). |
| `src/folder-select.js` | Reference implementation of the folder-selection tweak. |
| `src/check-ads.js` | Polls the Freebuff ad auction (codebuff.com) and reports when ads actually fill. |
| `src/mobile-ui.css` | Responsive adaptation for Gate Mobile on phones/tablets (injected by the tailnet proxy). |
| `src/mobile-ui.js` | Tiny Gate Mobile helpers: viewport meta patch + dynamic viewport height. |
| `src/mobile-ui-screenshot-fixture.html` | Deterministic native-UI fixture for Gate Mobile screenshot regression. |
| `src/mobile-ui-screenshot.test.js` | Chromium CDP screenshot/layout regression test for Gate Mobile. |
| `.env.example` | Non-secret env template. Real values go in a git-ignored `.env`. |
| `.gitignore` | Excludes every secret and piece of runtime state from the repo. |
| `AGENTS.md` | Project-scoped Caveman profile shared by Freebuff Desktop and CLI. |
| `src/install-caveman.js` | Safe installer for the project or global `~/.AGENTS.md` profile. |
| `src/mobile-connect-protocol.js` | Dependency-free pairing, token, URL, and validation helpers. |
| `src/mobile-connect-gateway.js` | First secure mobile pairing control plane for managed relay integration. |
| `src/mobile-connect-gateway.test.js` | Node test coverage for pairing, refresh, expiry, and revoke. |
| `src/mobile-connect-qr.js` | Dependency-free ANSI QR renderer for pairing payloads. |
| `src/mobile-connect-qr.test.js` | QR matrix, capacity, and terminal-render tests. |
| `src/mobile-connect-websocket.js` | Dependency-free relay WebSocket server framing. |
| `src/mobile-connect-relay.js` | Managed relay HTTP/SSE/WebSocket forwarding and cookie exchange. |
| `src/mobile-connect-agent.js` | Desktop outbound WSS connector and local UI bridge. |
| `src/install-mobile-connect.js` | Cross-platform installer for the Desktop mobile-connect companion (agent, proxy deploy, on-disk UI patches, verify). |
| `src/install-mobile-connect.test.js` | Installer safety, config, launcher, uninstall, UI-stack, and verify tests. |
| `src/freebuff-gate-setup.js` | Interactive setup wizard: detects the Desktop install, installs/upgrades the proxy + UI patches, re-applies the tailnet forward, verifies health. |
| `src/freebuff-gate-setup.test.js` | Wizard state/plan/parse and release-asset staging tests. |
| `src/freebuff-setup.js` | Standalone browser-first setup entrypoint with terminal fallback. |
| `src/freebuff-setup-wizard.js` | Loopback wizard server, session protection, and setup action controller. |
| `src/freebuff-setup-sea-entry.js` | Node SEA entrypoint; materializes versioned assets and hosts agent/proxy service modes. |
| `src/package-freebuff-setup.js` | Builds Linux, macOS, and Windows setup binaries plus manifests/checksums. |
| `.github/workflows/setup-binary.yml` | Native-runner setup binary build, smoke, metadata, and prerelease workflow. |
| `.github/workflows/identity-check.yml` | Rejects commits with unapproved author or committer identities. |
| `.github/workflows/docs-links.yml` | Checks local Markdown links and anchors in CI. |
| `src/check-doc-links.js` | Dependency-free local Markdown link checker. |
| `src/check-doc-links.test.js` | Tests local links, anchors, external links, and fenced code. |
| `docker/relay/` | Self-hosted mobile relay: Caddy/Let's Encrypt default, Tailscale private fallback. |
| `src/freebuff_tailnet_proxy.js` | Tailnet browser-port proxy: injects the mobile layer + shim, patches the UI bundle, cache headers, ad/perf probes, and auto-verifies UI patches. |
| `src/freebuff-tailnet-proxy.test.js` | Proxy ETag/cache and UI-patch watchdog tests. |
| `src/perf-probe.js` | Page-load/perf instrumentation injected by the proxy. |
| `install-release-apk.sh` | One-command release APK installer (download + SHA-256 verify + reinstall). |
| `ios/` | Freebuff Gate iOS companion app (XcodeGen project, pairing shell, icon set). |
| `src/package-mobile-connect-release.js` | Packages versioned agent assets, manifest, checksums, and release archive. |
| `src/package-mobile-connect-release.test.js` | Release asset, checksum, bootstrap, and archive tests. |
| `install-mobile-connect.sh` | Node 22-validated one-command release bootstrap. |
| `src/mobile-connect-relay.test.js` | Relay cookie, stream, and WebSocket integration tests. |
| `docker/relay/backup.sh` | Relay/Caddy volume backup, metadata validation, dry-run, and restore utility. |
| `src/mobile-connect-backup.test.js` | Backup metadata, checksum tamper, version, and project mismatch tests. |
| `src/mobile-connect-agent.test.js` | End-to-end desktop-agent forwarding test. |
| `src/mobile-connect-e2e-fixture.js` | Ephemeral HTTPS relay/desktop/upstream fixture used by Android CI pairing E2E. |
| `android/` | Native Android pairing/WebView scaffold. |
| `android/app/src/androidTest/java/com/freebuff/mobile/MobilePairingE2EInstrumentedTest.kt` | Emulator test for real claim, refresh, cookie exchange, and relay WebView load. |
| `.github/workflows/android.yml` | Builds/tests Android emulator, runs managed relay integration, and uploads artifacts. |
| `.github/workflows/ios.yml` | Builds/tests the iOS app, signs an IPA when secrets are set, and publishes rolling releases. |
| `.github/workflows/mobile-ui-screenshot.yml` | Runs mobile screenshot/layout regression and uploads the phone capture. |
| `npm/` | npm distribution: `freebuff-gate` metapackage plus per-platform binary packages. |
| `docs/` | User-facing guides: install guide, mobile adaptation, and historical planning notes. |

## Caveman profile

The project `AGENTS.md` enables the Caveman response profile in Freebuff
Desktop and CLI. To apply it to every project, preview then install the
home-level file:

```bash
node src/install-caveman.js --global --dry-run
node src/install-caveman.js --global
```

`--remove` deletes only the managed block. Restart Desktop/CLI sessions after
changing instruction files. If `~/.knowledge.md` exists, it takes precedence
and must be updated or removed for the global profile to apply.

## Mobile pairing gateway

The gateway provides secure pairing for the managed Freebuff relay. It keeps
Tailscale, IPv6, port forwarding, and firewall setup out of the normal user
flow.

Start local gateway on loopback:

```bash
node src/mobile-connect-gateway.js serve
```

Create one-use pairing payload:

```bash
node src/mobile-connect-gateway.js pair --ttl 600
```

The command renders an ANSI QR code plus an HTTPS pairing URL whose token lives
in the URL fragment; the token alone is the pairing secret, so keep the pairing
URL private. The Android scanner reads the QR directly; `--no-qr` keeps
URL-only output for CI or piped logs. The Android scanner scaffold lives under
`android/`.

Manage paired devices:

```bash
node src/mobile-connect-gateway.js devices
node src/mobile-connect-gateway.js revoke --device d_...
```

Gateway behavior:

- Default bind is `127.0.0.1:8794`; non-loopback binding refuses to start unless
  `FB_MOBILE_ADMIN_TOKEN` is set.
- Pairing expires after 10 minutes, caps failed claims at five attempts, and is
  consumed after one successful claim.
- Persisted state stores only hashes of pairing/device/access secrets. State is
  written atomically with restrictive permissions outside the repository by
  default (`~/.config/freebuff/mobile-connect.json`).
- Successful claim returns a device refresh credential and short-lived access
  credential. Normal reconnect refreshes access without another QR scan.
- `devices` and `revoke` are admin-only. Revocation immediately blocks refresh.
- `FB_MOBILE_RELAY_URL` and UI URL are returned as connection metadata. The
  managed relay implementation lives in `src/mobile-connect-relay.js` and
  forwards HTTP/SSE/WebSocket traffic over the desktop agent's outbound WSS.
- `POST /v1/relay/enroll` accepts a relay-side bootstrap token and returns a
  15-minute connector token plus 90-day refresh token; only token hashes are
  persisted by relay.
- `POST /v1/relay/refresh` rotates connector token without reinstalling Desktop.
- `GET /v1/mobile/session` exchanges the app access token for a Secure,
  HttpOnly, SameSite session cookie before WebView navigation.

Configure non-secret names in `.env.example`. Never put provider credentials,
permanent tokens, connector enrollment tokens, or Tailscale auth keys in QR data
or source control.

Run managed relay locally:

```bash
FB_MOBILE_RELAY_CONNECTOR_TOKEN=local-secret \
node src/mobile-connect-relay.js serve --http-url http://127.0.0.1:8795 --ws-url ws://127.0.0.1:8795

FB_MOBILE_RELAY_CONNECTOR_TOKEN=local-secret \
node src/mobile-connect-agent.js serve \
  --relay-http-url http://127.0.0.1:8795 \
  --relay-ws-url ws://127.0.0.1:8795 \
  --upstream-url http://127.0.0.1:58061

FB_MOBILE_RELAY_CONNECTOR_TOKEN=local-secret \
node src/mobile-connect-agent.js pair --relay-http-url http://127.0.0.1:8795
```

Production relay must terminate HTTPS/WSS at a trusted public origin. The
relay operator can read proxied payloads; WSS protects network transit, not
relay end-to-end confidentiality. The desktop agent currently uses Node 22's
built-in WebSocket client; native Freebuff CLI integration remains separate.

## Standalone setup binary

The setup binary is a companion launcher, not a replacement for Freebuff
Desktop. It embeds Node and setup assets, opens a loopback browser wizard, and
installs per-user agent and proxy registrations without administrator access.

Targets: Linux x64/arm64, macOS x64/arm64, and Windows x64. Run the matching
`freebuff-setup-vX.Y.Z-<target>` artifact. `--no-browser` uses terminal setup;
`--dry-run` inspects without changes; `--version` prints artifact version.
Artifacts include JSON manifest and SHA-256 sidecar. Prerelease artifacts are
currently unsigned; signing remains release gate before production distribution.

Build on matching native runner:

```bash
node src/package-freebuff-setup.js --version v0.2.0 --target linux-x64 --output dist
node src/package-freebuff-setup.js --metadata --version v0.2.0 --output dist
```

Wizard currently uses existing local setup and advanced Tailscale path.
Freebuff-hosted relay onboarding stays unavailable until hosted control-plane
deployment is live; wizard reports that state instead of claiming readiness.

## npm distribution

The setup binary also ships as `freebuff-gate` on npm, with per-platform
optional packages (`freebuff-gate-linux-x64`, `freebuff-gate-darwin-arm64`,
and friends). Installing `freebuff-gate` on the matching platform pulls the
right binary and exposes the `freebuff-setup` launcher:

```bash
npm install -g freebuff-gate
freebuff-setup --version
freebuff-setup --dry-run
```

Build the six tarballs from release binaries and validate checksums before
publishing:

```bash
node src/package-freebuff-npm.js --version v0.2.0 --artifacts-dir dist --pack-destination /tmp/npm-check
```

Publish to the `next` dist-tag (platform packages first, then the
metapackage):

```bash
node src/package-freebuff-npm.js --version v0.2.0 --artifacts-dir dist --publish --npm-tag next
```

CI runs this in the `publish-npm-prerelease` job gated on `NPM_TOKEN`; the
`smoke-npm-platforms` matrix then installs the published package on Linux,
macOS, and Windows runners and checks the launcher.

## Self-host the relay with Docker

The relay runs as a container with a Caddy sidecar that terminates HTTPS/WSS
via Let's Encrypt, or a Tailscale sidecar for private tailnet exposure.
Prebuilt images publish to `ghcr.io/venthezone/freebuff-gate-relay` (`latest`,
`next`, and `vX.Y.Z` tags; linux/amd64 and linux/arm64):

```bash
cd docker/relay
cp .env.example .env
$EDITOR .env   # RELAY_DOMAIN, RELAY_ENROLLMENT_TOKEN, RELAY_ADMIN_TOKEN
docker compose up -d
```

Compose pulls the published image and falls back to building from source when
it is not published yet. Backup/restore for the state and certificate volumes
lives in `docker/relay/backup.sh`. Full self-hosting guide:
`docker/relay/README.md`.

## Freebuff Desktop mobile-connect installer

Install companion connector without modifying compiled Freebuff Desktop files:

### One-command release install

After a tagged release, users can install the verified companion with one
command:

```bash
curl -fsSL https://github.com/VenTheZone/freebuff-gate/releases/download/v0.1.11/install-mobile-connect.sh \\
  | bash -s -- \\
      --relay-http-url https://relay.example.com \\
      --enrollment-token '<relay-bootstrap-token>'
```

Pin the release tag instead of using a moving `main` URL. Before downloading
code the bootstrap locates the Freebuff Desktop install, checks Node 22+,
`curl`, and `sha256sum`/`shasum`, and offers to install anything missing
(`--check` for a report only, `-y` to install unprompted, `--no-prompt` to
fail instead of asking, `--skip-checks` to bypass). It then fetches versioned
agent files from the same release, validates the release manifest, verifies
SHA-256 checksums, and only then runs the existing Node installer. It does not
elevate privileges.

The bootstrap also accepts `--version v1.2.3` and
`--release-base-url https://mirror.example.com/freebuff/v1.2.3` for private
release mirrors. Keep enrollment tokens out of shell history when possible.

Build release assets locally:

```bash
node src/package-mobile-connect-release.js --version v0.1.11 --archive
```

The command writes `dist/freebuff-mobile-connect-v0.1.11/` with the
bootstrap, versioned JavaScript files, JSON manifest, SHA-256 sidecar, and a
`.tar.gz` archive. Publish those assets with GitHub CLI after reviewing them:

```bash
gh release create v0.1.11 \\
  dist/freebuff-mobile-connect-v0.1.11/* \\
  --title "Freebuff mobile-connect v0.1.11" \\
  --generate-notes
```

Tag pushes do not run a separate packaging workflow; the release assets are
built and uploaded locally (the command above) or from any CI that publishes
the release.

```bash
node src/install-mobile-connect.js install \
  --relay-http-url https://relay.example.com \
  --relay-ws-url wss://relay.example.com
```

Installer copies only required Node agent files, creates a launcher named
`freebuff-mobile-connect`, and writes relay/UI configuration under user
config/data directories. With UI patches enabled (`--ui-patches` is default)
it also deploys the tailnet proxy + systemd unit and re-applies the on-disk
bundle/shim/orchestrator patches idempotently, so `curl | bash` builds the
whole browser port. After a Freebuff Desktop update, run
`node src/install-mobile-connect.js verify` (or `install-mobile-connect.sh --verify`)
to check the on-disk markers and exit non-zero on regressions; the proxy also
auto-verifies itself on a timer and writes `~/.local/share/freebuff/ui-patch-status.json`.
Preferred one-time provisioning:

```bash
node src/install-mobile-connect.js install \
  --relay-http-url https://relay.example.com \
  --enrollment-token '<relay-bootstrap-token>'
```

Installer stores issued connector and refresh tokens only in a protected local
credential file. It never stores provider credentials or bootstrap token. Keep
bootstrap token server-side and rotate it after provisioning. After
provisioning, no connector environment variable is needed:

```bash
freebuff-mobile-connect serve
freebuff-mobile-connect pair
```

Legacy shared-token mode remains available with
`FB_MOBILE_RELAY_CONNECTOR_TOKEN`.

### Optional Desktop auto-start

Auto-start is disabled by default. Enable it explicitly during install:

```bash
node src/install-mobile-connect.js install \\
  --relay-http-url https://relay.example.com \\
  --enrollment-token '<relay-bootstrap-token>' \\
  --auto-start
```

The installer creates a per-user registration without administrator access:

- Linux: `~/.config/systemd/user/freebuff-mobile-connect.service`, enabled and
  restarted with `systemctl --user`.
- macOS: `~/Library/LaunchAgents/com.freebuff.mobile-connect.plist`, loaded with
  `launchctl` for current GUI user.
- Windows: `Freebuff Mobile Connect` Task Scheduler task, `ONLOGON` trigger at
  `LIMITED` run level.

Disable it later with `--no-auto-start`. Reinstall without either flag keeps an
existing auto-start choice; new installs stay off. `uninstall` disables and
removes only the managed registration. `--dry-run` never calls systemd,
launchctl, or Task Scheduler.

`--relay-ws-url` is derived from HTTPS URL when omitted. Desktop UI defaults to
`http://127.0.0.1:58061`; override with `--upstream-url`. Use
`--dry-run` before writing, `uninstall` to remove installed agent files, and
`uninstall --purge` only when config/state should also be removed. The installer refuses insecure non-loopback relay URLs, refuses unmanaged
destination collisions, rotates short-lived connector tokens through the
relay, and never stores provider credentials. Node 22 is required because the
agent uses a built-in WebSocket. Keep the bootstrap token out of shell history
where possible; rotate it after provisioning.

This is a companion process, not a patch to Freebuff's compiled native CLI.
Run it beside Desktop until Freebuff exposes a supported connector/plugin
boundary.

Run gateway, installer, release-packaging, and relay tests with:

```bash
node --test src/package-mobile-connect-release.test.js src/install-mobile-connect.test.js src/mobile-connect-gateway.test.js src/mobile-connect-qr.test.js src/mobile-connect-relay.test.js src/mobile-connect-agent.test.js
```

## Android + iOS mobile app scaffold

`android/` contains a Kotlin Android shell around the gateway contract; `ios/` holds the iOS companion (XcodeGen project). The Android APK is published automatically to the `mobile-debug-latest` GitHub release (debug key, checksum sidecar) on every push to main; `mobile-gecko-latest` carries the GeckoView/Firefox-engine spike build. See `android/README.md` and `docs/install.md`.

The Android shell provides:

- CameraX + ML Kit QR scanner reads pairing URL fragments.
- Six-digit terminal code completes pairing.
- EC device identity and AES-GCM session storage use Android Keystore.
- Network callbacks plus jittered exponential backoff drive reconnect states.
- WebView calls relay `/v1/mobile/session` natively, installs the Secure/HttpOnly
  cookie, then allows JavaScript for Freebuff UI while blocking cleartext, file
  access, SSL bypasses, downloads, arbitrary origins, and native JavaScript
  bridges.
- CI/production builds can pin `DEFAULT_PAIRING_ORIGIN` and
  `DEFAULT_WEB_ORIGIN` with Gradle properties `freebuffPairingOrigin` and
  `freebuffWebOrigin`. Generic test builds leave them empty: pairing then trusts
  only the exact HTTPS origin in the scanned QR, binds WebView navigation to the
  same relay origin returned by the claim, and still rejects HTTP, credentials,
  and cross-origin navigation. Use pinned origins for managed production builds.

A clean checkout needs Android SDK and Gradle; use Android Studio, CI, or the
project-local tools described in `android/README.md`. This workspace built the
debug APK with local Gradle 8.9 and API 35 tools. Generic debug builds can be
used with any HTTPS relay URL carried by a terminal QR; they still require a
reachable relay and a private, unexpired pairing URL. `.github/workflows/android.yml`
installs
Java 17, Android API 35/build tools, Gradle 8.9, runs lint plus debug assembly,
boots API 35 Google APIs x86_64 emulator for instrumentation tests, verifies the
AGP-generated debug signature, smoke-tests the published artifact, and publishes
the APK + checksum to the `mobile-debug-latest` GitHub release on main. Before
building, CI creates a one-day self-signed certificate trusted only by the debug
variant, starts an ephemeral HTTPS relay plus desktop connector and test page,
then `MobilePairingE2EInstrumentedTest` performs claim, access refresh, cookie
exchange, and authenticated WebView load through the emulator's `10.0.2.2`
host mapping. Managed relay deployment still needs a real HTTPS/WSS public origin
and connector enrollment token. The same workflow also runs Node 22 relay/agent
integration tests and uploads TAP output.

## Folder selection

The deployed picker is a server-side file browser. The tailnet proxy shim opens
a dialog listing the server's folders through the orchestrator's
`/api/fb/dirlist` route; users do not need to type paths or use a local picker.
See `docs/install.md` for setup details. `src/folder-select.js` is the older
client-side reference implementation (File System Access API with
`webkitdirectory` fallback, IndexedDB handle persistence, last-folder restore,
virtual paths) and documents the `folderSelection` block in
`.freebuff-gate.json`, which the live server-side picker ignores.

## Ads in Gate Desktop and Gate Mobile

Gate Desktop and Gate Mobile show the same sponsored ads as the native
desktop window. There is no forwarding toggle. The UI fetches a banner ad
from the orchestrator (`POST /api/ad/slot`) and renders inline ad cards
inside long assistant responses; the orchestrator auctions both placements
server-side against `https://www.codebuff.com/api/v1/ads` using the auth
token in `~/.config/freebuff-desktop/state.json`. If the network returns an
empty `ads` array (no fill), nothing renders. That is expected, not a config
issue.

All surfaces use the tailnet proxy: Gate Desktop directly, the CLI, and Gate
Mobile through relay → agent → proxy. The proxy caches the last non-empty ad
fill for each placement and sends it to a surface when its next auction is
empty. Cached fills are marked `stale`. Inspect the cache with:

```bash
curl -s http://127.0.0.1:58061/api/fb/last-ad
```

`src/check-ads.js` polls the auction directly so you can watch for real
fill:

```bash
node src/check-ads.js            # poll every 60s until an ad fills
node src/check-ads.js --once     # single auction check
```

## Gate Mobile

Gate Mobile adapts Gate Desktop to a phone or tablet. The desktop layout
targets a mouse and a wide window; on a phone it falls apart.
`src/mobile-ui.css` + `src/mobile-ui.js` fix that for narrow viewports: the
chat goes full-bleed, the composer stays docked, the tab strip collapses into
a slim header with a session switcher, the model picker becomes a full-screen
sheet, and floating pills keep model/reasoning/time controls above the
message box. Full detail in [docs/mobile.md](docs/mobile.md).

## Secrets

Keep secrets out of this repository. `.gitignore` excludes `.env*`,
`state.json`, keypair, key, and token files, databases, logs, and runtime state.

- Real values always live in a local, git-ignored `.env`, never in
  `.freebuff-gate.json`.
- The Freebuff Desktop `state.json` (which holds auth tokens) is mirrored in
  shape only; the real file stays outside the repo.
- The `auth.tokenEnv` setting names the env var the browser port reads at
  runtime; no token is ever inline.

## Quick reference

Install guides: [docs/install.md](docs/install.md) (full stack, also a
copy-paste setup prompt for an AI coding agent such as Buffy or Codebuff),
[docs/mobile.md](docs/mobile.md) (phone/tablet adaptation),
[docker/relay/README.md](docker/relay/README.md) (self-hosted relay),
[android/README.md](android/README.md) and [ios/README.md](ios/README.md)
(mobile apps). One-command installers: `install-mobile-connect.sh` (Desktop
companion), `install-release-apk.sh` (Android release APK).