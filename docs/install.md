# Freebuff Gate installation guide

This guide is formatted as a copy-paste prompt for an AI coding agent such as
Buffy or Codebuff. The prompt sets up the Freebuff Gate stack on one machine:
the desktop orchestrator, tailnet proxy, mobile UI patches, server-side folder
browser, and optional mobile relay and connector.

## Quick start: pair a phone

The whole phone path in one place. Three pieces are involved: **Freebuff
Desktop** on the PC (already installed), the **Gate stack** on the PC
(companion installer below), and the **Gate app** on the phone (Android APK
or iOS build).

### The two URLs — do not mix them up

| URL | Looks like | Open with | What it does |
| --- | --- | --- | --- |
| **Pairing URL** | `https://<relay>/pair#pairingId=…&token=…` (token after `#`) | The **Gate app** (its QR scanner or paste field) | Claims the device, stores credentials, connects. One-use, expires in 10 minutes. |
| **Browser link** | `https://<host>…/?fb_gate=<token>` | A **phone/desktop browser** (Chrome, Safari) | Sets an HttpOnly cookie and lands on the Gate home screen. No app involved. |

The app rejects a browser link with *"Pairing URL has no token fragment"* —
that means the wrong URL type was pasted. Generate the right one with the
pair command below.

### 1. Install the Gate app on the phone

- **Android**: download and install the APK from the
  [`mobile-debug-latest` release](https://github.com/youlianvr/freebuff-gate/releases/tag/mobile-debug-latest)
  (tap the `.apk`, allow installation from this browser/file manager when
  Android asks, then Open). From a PC with `adb`:
  `bash install-release-apk.sh` downloads, verifies the SHA-256 checksum and
  installs it. The app is not on Play Store — the APK **is** the app.
- **iOS**: build `ios/` with Xcode (see `ios/README.md`) or use the
  `ios-debug-latest` CI build.

Leave the app on its "Pair device" screen — it is now waiting for a QR.

### 2. Install the Gate stack on the PC

One command (needs Node 22+; the script checks and can install it):

```bash
curl -fsSL https://github.com/VenTheZone/freebuff-gate/releases/download/v0.2.2/install-mobile-connect.sh | bash
```

or run `node src/freebuff-gate-setup.js` from a repo checkout — it detects
the Desktop install and repairs whatever is missing. Details and flags:
[Install with freebuff-setup](#install-with-freebuff-setup) below.

### 3. Connect the phone to the PC

The phone must reach the PC's proxy (`58061`). Two supported ways:

- **Tailscale (recommended, private).** Install Tailscale on the PC and the
  phone, log both into the same tailnet. Then expose the proxy:
  `tailscale serve --bg --https=443 http://127.0.0.1:58061` and use
  `https://<host>.<tailnet>.ts.net` as the public URL. DNS troubleshooting
  (phone says "address not found"): enable "Use Tailscale DNS" in the phone's
  Tailscale app and set Android Private DNS to Off/Automatic — or use the
  bare-IP variant `tailscale serve --bg --tcp=8061 tcp://127.0.0.1:58061` →
  `http://<tailscale-ip>:8061`.
- **Public relay (self-hosted).** `docker compose up -d` from `docker/relay/`
  gives a public `https://<domain>` (Caddy + Let's Encrypt). Heavier setup;
  see `docker/relay/README.md`.

### 4. Generate the pairing QR — this is the command

```bash
freebuff-mobile-connect pair        # installed launcher
# or, from a repo checkout:
node src/mobile-connect-agent.js pair
```

It prints an ANSI QR code and the pairing URL (the one with
`#pairingId=…&token=…`). The URL is the secret — anyone holding it can claim
the device, so don't post it. `--ttl 600` sets expiry, `--no-qr` prints the
URL only.

### 5. Scan it with the Gate app

In the Gate app: **Pair device → Scan QR** (or paste the URL). Scan the QR
with the **Gate app's scanner — not with the phone camera and not in Chrome**;
a camera/Chrome scan opens the URL in a browser instead of feeding it to the
app. After a successful claim the app connects and loads the UI; reconnects
later need no new QR.

### Does Freebuff need to be running?

The PC is the host and the phone is a remote screen, so the PC stack
(Desktop + Gate stack) must be up whenever the phone connects. **Pairing is
one-time** — the device credential persists and reconnects automatically —
but a fresh pairing QR is needed only when adding a new device or after a
revocation. Enable auto-start during install
(`freebuff-gate-connect` / `install-mobile-connect.js install --auto-start`)
so the stack survives reboots.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| App says *"Pairing URL has no token fragment"* | A browser link (`?fb_gate=…`) or bare URL was pasted — wrong URL type | Run `freebuff-mobile-connect pair` and scan/paste **that** URL (it ends in `#pairingId=…&token=…`) |
| *"Pairing URL fragment is incomplete"* | URL fragment missing `pairingId` or `token` params (truncated copy/paste) | Copy the full URL or re-scan the QR; regenerating is easiest |
| Pairing QR expired / already used | Pairings are one-use and expire in 10 minutes | Run the pair command again |
| Agent says "there is no app" or produces a cookie link | Agent worked from the wrong docs section | Point it at **this** guide (Quick start above); the app is the APK from the release |
| Agent says "Desktop is too new (0.0.154, gate supports 0.0.151)" | Misreading of verify output — the Gate supports Desktop **0.0.151 and newer** (launch guard handled) | Nothing to downgrade. `N patch(es) obsolete for this app version (skipped)` in verify output is **expected** on 0.0.126+ (those fixes are native in Desktop now) — it is not an incompatibility |
| Verify reports missing shim/markers after a Desktop update | App updates overwrite the patched files | Re-run the install command (or `node src/freebuff-gate-setup.js --yes`) to re-apply |
| Phone can't reach the host | Tailscale DNS / Android Private DNS | See step 3 DNS notes above |

---

## Install with freebuff-setup

`freebuff-setup` is a Node single-executable companion binary. Users do not
need to install Node. The binary supports Linux x64/arm64, macOS x64/arm64,
and Windows x64. It embeds setup assets, opens a loopback browser wizard, and
creates per-user agent and proxy registrations. Freebuff Desktop must already
be installed.

### Download

Download the artifact for your platform with its checksum and manifest
sidecars. Names follow `freebuff-setup-<version>-<target>`. Targets are
`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and
`windows-x64.exe`. For example, a release contains
`freebuff-setup-v0.2.0-linux-x64`, `freebuff-setup-v0.2.0-SHA256SUMS`, and
`freebuff-setup-v0.2.0-manifest.json`.

Local builds go under `dist/freebuff-setup-<version>/`. GitHub prereleases use
the same artifacts from the setup-binary workflow.

The binary also ships on npm as `freebuff-gate` (per-platform optional
packages carry the binaries, so the metapackage resolves the right one):

```bash
npm install -g freebuff-gate
freebuff-setup --version
```

### Verify checksums

```bash
sha256sum -c freebuff-setup-v0.2.0-SHA256SUMS   # ...: OK
./freebuff-setup-v0.2.0-linux-x64 --version     # freebuff-setup v0.2.0
```

Prerelease binaries are unsigned: macOS Gatekeeper and Windows SmartScreen
warn on first launch (right-click → Open on macOS). CI signs and notarizes
macOS/Windows artifacts automatically when the signing secrets are configured.

### First run

```bash
chmod +x freebuff-setup-v0.2.0-linux-x64
./freebuff-setup-v0.2.0-linux-x64
```

On first run, the binary materializes its assets in the per-user cache
(`~/.cache/freebuff/setup-assets/<version>` on Linux), starts a loopback-only
wizard on `127.0.0.1` using a random port, and opens the default browser. The
wizard inspects Desktop and the companion stack, shows **Ready** or lists the
required actions, and applies them when you select **Apply setup**.
**Advanced setup** selects the self-hosted/Tailscale path. **Exit** stops the
wizard. Hosted-relay onboarding remains unavailable until the hosted control
plane is live; the wizard reports that state.

Running the binary again repeats inspection and applies only missing changes.
Existing credentials and configuration remain in place. Use these terminal
alternatives:

```bash
./freebuff-setup-v0.2.0-linux-x64 --no-browser   # existing terminal wizard
./freebuff-setup-v0.2.0-linux-x64 --dry-run      # report + plan, change nothing
./freebuff-setup-v0.2.0-linux-x64 --advanced     # prefer self-hosted path
```

---

## Copy from here

```text
You are setting up the Freebuff Gate stack on this machine. Follow these
steps in order and verify each one. The app is Freebuff Desktop, a packaged
Electron-style app whose orchestrator (a Bun server) serves Gate Desktop
(the browser UI); Gate Mobile is the same UI adapted for phones and tablets.

### Prerequisites
- Node.js 22+ and Bun (Bun ships inside the app at
  ~/.local/share/freebuff-desktop/squashfs-root/resources/bun/bun; use that
  binary for sqlite access).
- Tailscale installed, logged in, and the machine on the user's tailnet.
- The Freebuff Desktop app installed at ~/.local/share/freebuff-desktop/ and
  the freebuff-gate repo cloned at ~/freebuff-gate (this guide lives at
  docs/install.md in that repo).
- The app may already be running as a service; do not stop it.

### Installer can find the stack and check dependencies
install-mobile-connect.sh (the one-command bootstrap) locates the Freebuff
Desktop install automatically, checks Node 22+, curl, and SHA-256 tooling,
and offers to install anything missing before it runs the companion
installer. Useful flags:
- bash install-mobile-connect.sh --check        # readiness report only
- bash install-mobile-connect.sh --skip-checks  # bypass discovery/checks
- bash install-mobile-connect.sh -y             # install missing deps unprompted
- bash install-mobile-connect.sh --no-prompt    # fail instead of asking
- bash install-mobile-connect.sh --verify       # post-update regression check: exits
                                               # non-zero if bundle/shim/dirlist markers
                                               # are missing (e.g. right after an app update)

### Setup wizard (interactive)
freebuff-gate-setup.js is the interactive companion to the bootstrap. It
detects the Freebuff Desktop install, reports the state of the whole stack,
and offers to fix whatever is missing — no flags needed:
- node freebuff-gate-setup.js                  # interactive: asks before each fix
- node freebuff-gate-setup.js --dry-run        # report + plan, change nothing
- node freebuff-gate-setup.js --yes            # apply every needed fix unprompted
- node freebuff-gate-setup.js --release v0.1.13 --yes
                                              # standalone: fetch release assets
                                              # into ~/.cache and fix from them

It checks four things and repairs them in order: the on-disk bundle/shim/
orchestrator patches (re-runs the installer stack when an app update wiped
any marker), the tailnet proxy (deploys/restarts it), the served UI markers
(shim, mobile layer, bundle patch, upload route), and the tailscale serve
forward (re-applies tcp:<orchestrator-port> -> 127.0.0.1:<proxy-port>,
derived from the live units — never hardcoded). It works from the repo
(src/), from a raw release asset directory (version-prefixed siblings are
staged automatically), or standalone with --release.

### 1. Verify the orchestrator
The orchestrator serves Gate Desktop on 127.0.0.1:58060 (and tailnet IP).
- Confirm it answers: curl http://127.0.0.1:58060/api/projects
- If it is not running, start it from
  ~/.local/share/freebuff-desktop/squashfs-root/resources/orchestrator with
  the bundled Bun, e.g.:
  nohup <bun> orchestrator.js --port 58060 >> /tmp/freebuff-orchestrator.log 2>&1 &

### 2. Install the tailnet proxy + on-disk UI patches (automated)
The Node installer (run by the bootstrap) now deploys the tailnet proxy and
applies every on-disk UI patch below automatically and idempotently:
- Deploys freebuff_tailnet_proxy.js, mobile-ui.css, mobile-ui.js, and
  perf-probe.js to ~/.local/share/freebuff/tailnet-proxy and writes the
  systemd USER unit freebuff-tailnet-proxy.service (enables + starts it).
- Applies the boot-home/scroll/close bundle patch to
  <install>/squashfs-root/resources/orchestrator/ui/assets/index-*.js
  (same markers as src/freebuff_tailnet_proxy.js patchBundle): boot home
  must not hijack the active thread, thread switches land at the last
  message, and closing a phantom "New thread" tab works.
- Injects the window.freebuffDesktop shim (server-side file browser) into
  ui/index.html as a fb-desktop-shim tag right before </head>.
- Patches orchestrator.js with the GET /api/fb/dirlist route, the
  /api/fb/perf-report route, the perf probe injection helper, and
  best-effort no-store/immutable cache headers for serveSpa.
Every patch is marker-gated: already-patched files are left alone, and a
patch whose anchors no longer match after an app update FAILS loudly with
the exact file instead of silently shipping a stock UI. Control flags:
--no-ui-patches to skip the whole stack, --desktop-dir <path> to point at
an install (the bootstrap sets DESKTOP_DIR automatically when it finds the
app).
- After every Freebuff Desktop update, run bash install-mobile-connect.sh --verify
  (or `node src/install-mobile-connect.js verify`): it scans the on-disk
  bundle/shim/orchestrator for the patch markers and exits non-zero with the
  exact file when any are missing, so a regression is caught loudly. Re-run
  the install command to re-apply.
- The proxy also self-checks automatically, so you do not need to remember
  to run verify by hand. It re-probes on every bundle identity change (an
  app update swaps index-*.js) and on a check interval, fetches the raw
  upstream page + bundle itself (bypassing its own injection), verifies the
  shim tag, the bundle patch markers, and the dirlist/perf-report routes,
  then writes ~/.local/share/freebuff/ui-patch-status.json and logs loud
  [freebuff ui-patch] lines to the journal. Read the latest result anytime:
  curl -s http://127.0.0.1:58061/api/fb/ui-patch-status
  Tune it with FB_UI_PATCH_CHECK_INTERVAL_MS (min 30 s, default 10 min) and
  FB_UI_PATCH_STATUS_FILE (default ~/.local/share/freebuff/ui-patch-status.json).
- **Desktop 0.0.151+ (launch guard).** The orchestrator binds a random port
  and rejects API calls without its per-launch secret (`FREEBUFF_LAUNCH_ID`).
  The proxy finds both itself (Linux: /proc; macOS: ps/lsof; Windows: set
  `FB_LAUNCH_ID` by hand) and re-discovers every 30 s, so a Desktop restart
  is picked up. Supported Desktop versions are 0.0.151 and NEWER — a
  0.0.154 install is fine. The bundle patches are obsolete on 0.0.126+
  (native fixes); the installer reports "N patch(es) obsolete for this app
  version (skipped)" as an expected warning, not a failure. Treat that line
  as informational; only MISSING markers are a problem.
- **Gate token.** Because the proxy injects that secret, it now requires its
  own token: open `http://127.0.0.1:58061/?fb_gate=<token>` once per browser
  (sets an HttpOnly cookie). The token lives in
  `~/.config/freebuff/gate-proxy.token` (override: `FB_GATE_TOKEN_FILE`), is
  printed at proxy start, and the mobile agent sends it automatically.
  `FB_GATE_AUTH=off` disables the check (only if nothing else runs locally).
  NOTE: `?fb_gate=` links are for BROWSERS only. The Gate phone app needs the
  pairing URL from the pair command in step 3b.
- Verify: curl -H "x-fb-gate: $(cat ~/.config/freebuff/gate-proxy.token)" http://127.0.0.1:58061/ | grep fb-mobile-ui  (should match)
- Verify the shim on the direct UI: curl -s http://127.0.0.1:58060/ | grep -c fb-desktop-shim  (should be 1)
- Verify the dirlist route: curl -s 'http://127.0.0.1:58060/api/fb/dirlist?path=/home' returns JSON entries.
- Verify the browser works: open the UI, click "New session", click the
  project picker, choose "Open project". A file browser listing the server's
  folders must appear (starting at the most recent project directory); click
  into folders and select one. The chosen path is a real server path.

### 3. Mobile relay + connector (optional, for the Freebuff Gate Android app)
If the phone app is used:
- The installer in step 2 already deploys the agent (mobile-connect-agent.js)
  and its launcher/unit automatically; it does NOT deploy the relay. For
  Docker deployment, use `docker/relay/` — Caddy + Let's Encrypt is the
  default and does not require Tailscale. The agent's upstream must point at
  http://127.0.0.1:58061 (the proxy, so the mobile UI layer is injected).
  Run `docker compose up -d` from `docker/relay/` (pulls the published
  `ghcr.io/venthezone/freebuff-gate-relay` image; falls back to building from
  source when the tag is not published) and use its public `https://<domain>`
  URL for the agent and phone.
- Android app: the APK is the app — install it from the `mobile-debug-latest`
  GitHub release (or `mobile-release-latest` for the signed release track;
  `install-release-apk.sh` downloads, verifies the SHA-256 checksum, and
  installs it via `adb` — requires `gh`, `adb`, `sha256sum`).
- A systemd USER relay remains valid for non-Docker deployments; install a
  unit like the existing `freebuff-mobile-relay.service` on the reference
  machine (see `~/.config/systemd/user/`), with the agent unit already managed
  by the installer (`freebuff-mobile-connect.service`).
- Tailscale remains an optional private-network deployment:
  `docker compose -f docker-compose.tailscale.yml up -d --build`. Phones
  using that variant must be connected to the same tailnet.
- Set a strong connector token (relay --connector-token) and store it in a
  root-only file (chmod 600). Never commit it.
- **APNs push (iOS turn notifications, optional).** The relay reads the
  provider config from its environment file (the `EnvironmentFile=` path in
  the unit). The shipped file already carries documented placeholders; to
  activate, uncomment and fill:
  ```
  #FB_APNS_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
  #FB_APNS_KEY_ID=XXXXXXXXXX
  #FB_APNS_TEAM_ID=XXXXXXXXXX
  #FB_APNS_TOPIC=com.freebuff.gate
  #FB_APNS_SANDBOX=1
  ```
  - `FB_APNS_KEY` — path to an Apple APNs auth key (`.p8`) downloaded from
    Apple Developer → Certificates, Identifiers & Profiles → Keys; the file
    itself stays on the server (mode 600).
  - `FB_APNS_KEY_ID` — the 10-char Key ID shown next to that key.
  - `FB_APNS_TEAM_ID` — Team ID from Apple Developer → Membership.
  - `FB_APNS_TOPIC` — default `com.freebuff.gate` (the iOS bundle id); only
    set to override.
  - `FB_APNS_SANDBOX` — `1` for development builds
    (`api.sandbox.push.apple.com`), unset for production.
  After editing: `systemctl --user daemon-reload && systemctl --user restart
  freebuff-mobile-relay`. Empty/unset values keep the provider a no-op — the
  relay runs unchanged and only the turn-finished push path stays off. The
  iOS `aps-environment` entitlement must match: `development` for sandbox
  builds, `production` for TestFlight/App Store (see docs/mobile.md).

### 3b. Generate the pairing QR for the Gate app
When the user wants the phone app paired, THIS is the only correct command:
- freebuff-mobile-connect pair        (or: node src/mobile-connect-agent.js pair)
- It prints an ANSI QR plus a pairing URL ending in
  #pairingId=...&token=... — that URL/QR is what the Gate APP scans
  (in-app scanner or paste field). One-use; default TTL 10 minutes.
- NEVER hand the app a ?fb_gate= browser link or a bare UI URL: those are
  for phone/desktop BROWSERS (cookie flow) and the app rejects them with
  "Pairing URL has no token fragment".
- Scan with the app's scanner, not the phone camera/Chrome. The pairing URL
  is a bearer secret; do not paste it into chats or logs.
- Re-pairing needs a new QR only for a new device or after revoke; normal
  reconnects reuse the stored device credential.

### 4. Exposure
- Caddy deployment: create a public DNS record for the relay host and allow
  inbound ports 80/443. Caddy obtains and renews Let's Encrypt certificates;
  the relay's 8795 port stays private to the Docker network.
- Tailscale deployment: use the private `docker-compose.tailscale.yml` variant
  or `tailscale serve`; phones and server must share a tailnet.
- Phone browser, no relay: `tailscale serve --bg --https=443 http://127.0.0.1:58061`,
  then open `https://<host>.<tailnet>.ts.net/?fb_gate=<token>` once on the
  phone. Tailnet-only (not Funnel); the gate token still applies. If the
  phone says "address not found", enable "Use Tailscale DNS" in its
  Tailscale app and set Android Private DNS to Off/Automatic, or use the IP:
  `tailscale serve --bg --tcp=8061 tcp://127.0.0.1:58061` and open
  `http://<tailscale-ip>:8061/?fb_gate=<token>` (the HTTP serve mode only
  answers the ts.net name, so the bare IP needs the TCP forward).
- 58061 (proxy) is loopback-only; the relay is the public face for phones. Do
  NOT open raw relay or proxy ports to the internet.

### 5. Final verification checklist
- curl http://127.0.0.1:58060/api/projects → projects list, no "New thread"
  garbage (or only real ones).
- Two consecutive fresh loads of the UI (headless or browser) must NOT create
  new threads: count rows in
  <project>/.freebuff/desktop-v2.db before/after with
  <bun> -e 'import {Database} from "bun:sqlite"; const db=new
  Database(process.argv[1],{readonly:true});
  console.log(db.query("SELECT COUNT(*) n FROM threads").get().n);'
- The tab bar restores the same tabs after reload; home tab renders.
- "Open project" opens the folder browser and a real server path opens the
  project.
- On a phone-sized viewport through the proxy/relay, the mobile layout loads
  (injected #fb-mobile-ui style + script present in served HTML).

### Persistence notes
- App UPDATES overwrite ui/index.html, ui/assets/index-*.js, and
  orchestrator.js. After an update, re-run the same install command (the
  bootstrap one-liner works): the bundle patch, index.html shim, and
  orchestrator dirlist/perf/cache patches re-apply automatically and
  idempotently. If the app changed an anchor, the installer FAILS loudly
  with the exact file so the regression is never silent. Clients through
  the proxy (58061) do not even need that: the proxy applies patchBundle,
  shim, mobile layer, and cache headers at serve time on every request.
  The one patch still manual is API-level no-store on json3 routes (anchor
  not stable across app builds; see the commit history for the strings).
- The ad sniffer (optional debug tool) patches orchestrator.js the same
  way: it wraps the Ads class `post`/`auction` methods and appends JSON
  lines to ~/.config/freebuff-desktop/ad-sniff.log. Both halves now record
  the full HTTP exchange: the orchestrator side logs the outbound request
  headers (Authorization value redacted) and all response headers, the
  proxy side (src/freebuff_tailnet_proxy.js) logs browser->orchestrator
  request/response headers, so a complete dump needs no replay. Re-apply
  after app updates with `node src/patch-ad-sniffer.js` (idempotent,
  fails loudly if anchors moved); the proxy-side half only needs a proxy
  restart.
- Perf probe (optional debug tool): src/perf-probe.js collects Navigation +
  Resource Timing and renders a waterfall when the URL carries ?fbperf=1 (or
  #fbperf). It POSTs to /api/fb/perf-report, which logs JSON lines to
  ~/.config/freebuff-desktop/perf-report.log tagged webview|firefox|browser
  (detected from the user-agent) so a phone WebView run and a Firefox run
  can be compared side by side. The proxy injects the probe only when the
  flag is present and logs its own reports; the orchestrator half
  (injectPerfProbe helper in serveSpa + the /api/fb/perf-report route) is
  an on-disk patch that must be re-applied after app updates.
- The proxy reads src/mobile-ui.css and src/mobile-ui.js from the repo on
  every request, so UI changes only need a proxy restart (or nothing).
- systemd user units keep proxy/relay/agent alive across reboots (loginctl
  enable-linger may be needed for user units to start at boot).
```

## Stack components

| Layer | File | Port | Purpose |
|-------|------|------|---------|
| Orchestrator | `orchestrator.js` (packaged) | 58060 | Gate Desktop server, projects, threads |
| Tailnet proxy | `src/freebuff_tailnet_proxy.js` | 58061 | Gate Mobile injection, Gate Desktop shim, bundle patch, ad broadcast |
| Relay | `src/mobile-connect-relay.js` | 8795 | HTTPS/WSS for the Android app |
| Agent | `src/mobile-connect-agent.js` | n/a | Bridges relay → proxy (58061) |
| Gate Mobile | `src/mobile-ui.css`, `src/mobile-ui.js` | n/a | Mobile adaptation layer |
| iOS app | `ios/` | n/a | Native iOS companion (QR pairing, restricted WKWebView) |

## iOS companion app

`ios/` is the native iOS companion. It supports QR pairing, Keychain device
identity, AES-GCM session storage, reconnect with jittered backoff, and a
WKWebView restricted to the relay origin. Build it with XcodeGen and Xcode
(see ios/README.md), or use `.github/workflows/ios.yml` on macOS CI.
CI produces an unsigned simulator `.app` by default, published on the
`ios-debug-latest` rolling release. A signed, device-installable IPA requires
an Apple Developer account and the `IOS_SIGNING_CERT_BASE64` /
`IOS_SIGNING_CERT_PASSWORD` secrets; when set, CI publishes it on the
`ios-latest` rolling release. The app uses the same managed relay and
`/v1/mobile/session` cookie exchange as Android.

## Patch notes

- **Boot-time thread pollution**: the packaged UI created 1 to 3 empty "New
  thread" rows on every page load. The bundle patch pins one dedicated home
  thread per browser (localStorage `fb.homeThread`), reuses it on reload,
  and keeps `activeId` on the last chat instead of hijacking it.
- **Folder browser**: the browser can't see the server's filesystem and has no
  Electron picker, so the shim provides `pickDirectory` as a server-side file
  browser (breadcrumbs, Up/Home, recents) over the orchestrator's
  `/api/fb/dirlist` route. No path typing needed.
- **Attachments**: the browser has no Electron file dialog, so the shim
  implements `pickAttachments` (a hidden file input uploads each file to
  `/api/fb/upload`, which stores it on the server and returns a real path) and
  `readImage` (serves the stored bytes back through `/api/fb/read-file` for
  image preview). The proxy handles both routes locally for desktop-browser and
  mobile clients; the on-disk orchestrator patch adds the same routes so
  58060-direct clients work too. Uploads land in
  `~/.local/share/freebuff/uploads`.
- **Mobile adaptation**: the desktop UI isn't mobile friendly; the proxy
  injects the scoped mobile layer at ≤1000px.
- **WebView caching**: the Android WebView used LOAD_NO_CACHE, so every load
  re-downloaded the ~1.5MB bundle through the relay chain. The WebView now
  uses LOAD_DEFAULT; HTML is no-store, hashed assets are immutable, and the
  proxy serves the patched bundle with an ETag so reloads return 304.
