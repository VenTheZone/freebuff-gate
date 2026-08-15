# FB-Browser-UI

Dotfile configuration for a browser port of the **Freebuff Desktop** UI —
with the **folder-selection tweak**.

Desktop Freebuff runs as a native app and can open a real folder dialog. A
browser port cannot, so folder selection must be re-implemented with web APIs.
This repo ships the configuration (`FB-Browser-UI/.fb-browser-ui.json`) plus a
small reference implementation (`src/folder-select.js`) of that tweak.

## What's inside

| Path | Purpose |
| --- | --- |
| `.fb-browser-ui.json` | The dotfile configuration for the browser port (app, auth, workspace, UI prefs, and the `folderSelection` tweak block). |
| `src/folder-select.js` | Reference implementation of the folder-selection tweak. |
| `src/check-ads.js` | Polls the Freebuff ad auction (codebuff.com) and reports when ads actually fill. |
| `src/mobile-ui.css` | Responsive adaptation for the browser UI on phones/tablets (injected by the tailnet proxy). |
| `src/mobile-ui.js` | Tiny mobile helpers: viewport meta patch + dynamic viewport height. |
| `src/mobile-ui-screenshot-fixture.html` | Deterministic native-UI fixture for mobile screenshot regression. |
| `src/mobile-ui-screenshot.test.js` | Chromium CDP screenshot/layout regression test for mobile chrome. |
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
| `src/install-mobile-connect.js` | Cross-platform installer for the Desktop mobile-connect companion. |
| `src/install-mobile-connect.test.js` | Installer safety, config, launcher, and uninstall tests. |
| `src/package-mobile-connect-release.js` | Packages versioned agent assets, manifest, checksums, and release archive. |
| `src/package-mobile-connect-release.test.js` | Release asset, checksum, bootstrap, and archive tests. |
| `install-mobile-connect.sh` | Node 22-validated one-command release bootstrap. |
| `src/mobile-connect-relay.test.js` | Relay cookie, stream, and WebSocket integration tests. |
| `src/mobile-connect-agent.test.js` | End-to-end desktop-agent forwarding test. |
| `src/mobile-connect-e2e-fixture.js` | Ephemeral HTTPS relay/desktop/upstream fixture used by Android CI pairing E2E. |
| `android/` | Native Android pairing/WebView scaffold. |
| `android/app/src/androidTest/java/com/freebuff/mobile/MobilePairingE2EInstrumentedTest.kt` | Emulator test for real claim, refresh, cookie exchange, and relay WebView load. |
| `.github/workflows/android.yml` | Builds/tests Android emulator, runs managed relay integration, and uploads artifacts. |
| `.github/workflows/mobile-connect-release.yml` | Packages tagged, versioned Desktop installer artifacts on Node 22. |
| `.github/workflows/mobile-ui-screenshot.yml` | Runs mobile screenshot/layout regression and uploads the phone capture. |

## Caveman on Freebuff Desktop and CLI

Freebuff Desktop and Freebuff CLI use the same Codebuff instruction-file
convention. They read `AGENTS.md` (unless a higher-priority `knowledge.md`
exists), so the project-level `AGENTS.md` above enables the Caveman response
profile in both products without patching installed binaries.

The profile keeps technical content, code, commands, paths, and errors exact
while removing conversational filler. It also falls back to normal prose for
security warnings, irreversible actions, ambiguity, and user confusion.

The project profile is already present. To apply the same profile to every
Freebuff project, preview then explicitly install the home-level file:

```bash
node src/install-caveman.js --global --dry-run
node src/install-caveman.js --global
```

Use `node src/install-caveman.js --global --remove` to remove only the managed
block; any other content in `~/.AGENTS.md` stays intact. Restart existing
Desktop/CLI sessions after changing instruction files. If `~/.knowledge.md`
exists, it takes precedence and must be updated or removed for the global
profile to apply.

This integrates Caveman's communication layer, not its optional proxy/input
compression. Caveman's native wrapper currently lists seven other agents, not
Freebuff, and Freebuff's published launcher delegates to a compiled native
binary. Routing Freebuff provider traffic through Caveman would require an
upstream provider-hook change; silently patching the installed binary would be
fragile and would be lost on update.

## Mobile pairing gateway

First gateway slice adds secure pairing control plane for managed Freebuff
relay. It keeps Tailscale, IPv6, port forwarding, and firewall details
out of normal user flow.

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

Gateway properties:

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

Production relay must terminate HTTPS/WSS at a trusted public origin. Relay
operator can read proxied payloads; WSS protects network transit, not relay
end-to-end confidentiality. Desktop agent currently uses Node 22's built-in
WebSocket client; native Freebuff CLI integration remains separate. `GET
/v1/mobile/session` exchanges app access token for Secure/HttpOnly cookie before
WebView navigation.

## Freebuff Desktop mobile-connect installer

Install companion connector without modifying compiled Freebuff Desktop files:

### One-command release install

After publishing a tagged release, a non-technical Desktop user can install the
verified companion with one command:

```bash
curl -fsSL https://github.com/VenTheZone/FB-Browser-UI/releases/download/v0.1.0/install-mobile-connect.sh \\
  | bash -s -- \\
      --relay-http-url https://relay.example.com \\
      --enrollment-token '<relay-bootstrap-token>'
```

Pin the release tag instead of using a moving `main` URL. Bootstrap validates
Node 22 or newer before downloading code, fetches versioned agent files from the
same release, validates the release manifest, verifies SHA-256 checksums, and
only then runs the existing Node installer. It requires `bash`, `curl`, and
`sha256sum` or `shasum`; it does not install Node or elevate privileges.

The bootstrap also accepts `--version v1.2.3` and
`--release-base-url https://mirror.example.com/freebuff/v1.2.3` for private
release mirrors. Keep enrollment tokens out of shell history when possible.

Build release assets locally:

```bash
node src/package-mobile-connect-release.js --version v0.1.0 --archive
```

This writes `dist/freebuff-mobile-connect-v0.1.0/` with the bootstrap,
versioned JavaScript files, JSON manifest, SHA-256 sidecar, and a `.tar.gz`
archive. Publish those assets with GitHub CLI after reviewing them:

```bash
gh release create v0.1.0 \\
  dist/freebuff-mobile-connect-v0.1.0/* \\
  --title "Freebuff mobile-connect v0.1.0" \\
  --generate-notes
```

Tag pushes also run `.github/workflows/mobile-connect-release.yml`, which
packages and uploads the same artifact to GitHub Actions for review. The
workflow does not publish a release automatically.

```bash
node src/install-mobile-connect.js install \
  --relay-http-url https://relay.example.com \
  --relay-ws-url wss://relay.example.com
```

Installer copies only required Node agent files, creates a launcher named
`freebuff-mobile-connect`, and writes relay/UI configuration under user
config/data directories. Preferred one-time provisioning:

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
`uninstall --purge` only when config/state should also be removed. Installer
refuses insecure non-loopback relay URLs, refuses unmanaged destination
collisions, rotates short-lived connector tokens through the relay, and never
stores provider credentials. Node 22 is required because agent uses built-in
WebSocket. Keep bootstrap token out of shell history where possible; rotate it after
provisioning.

This is a companion process, not a patch to Freebuff's compiled native CLI.
Run it beside Desktop until Freebuff exposes a supported connector/plugin
boundary.

Run gateway, installer, release-packaging, and relay tests with:

```bash
node --test src/package-mobile-connect-release.test.js src/install-mobile-connect.test.js src/mobile-connect-gateway.test.js src/mobile-connect-qr.test.js src/mobile-connect-relay.test.js src/mobile-connect-agent.test.js
```

## Android mobile app scaffold

`android/` contains a Kotlin Android shell around the gateway contract:

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
AGP-generated debug signature, and uploads APK/test reports for 14 days. Before
building, CI creates a one-day self-signed certificate trusted only by the debug
variant, starts an ephemeral HTTPS relay plus desktop connector and test page,
then `MobilePairingE2EInstrumentedTest` performs claim, access refresh, cookie
exchange, and authenticated WebView load through the emulator's `10.0.2.2`
host mapping. Managed relay deployment still needs a real HTTPS/WSS public origin
and connector enrollment token. The same workflow also runs Node 22 relay/agent
integration tests and uploads TAP output.

## The folder-selection tweak

`src/folder-select.js` reproduces desktop folder selection in the browser:

1. **User-gesture discipline** — `window.showDirectoryPicker()` must be called
   synchronously inside a click handler; `await`ing anything first kills user
   activation and the browser rejects with `SecurityError`. The tweak makes
   this a hard rule of the API.
2. **`webkitdirectory` fallback** — Firefox/Safari have no File System Access
   API, so a hidden `<input type="file" webkitdirectory>` is used instead
   (read-only, session-scoped).
3. **Handle persistence** — the `DirectoryHandle` is stored in IndexedDB and
   permission is re-requested via `handle.requestPermission({ mode })` on
   reload, since handles don't auto-grant across sessions.
4. **Last-folder restore** — passing `{ id }` to the picker makes Chromium
   remember the last-picked folder with no path stored.
5. **Virtual paths** — browsers refuse to expose absolute paths, so the UI
   shows a stable synthetic path like `workspace://name`.

Tune every knob in the `folderSelection` block of `.fb-browser-ui.json`:

```json
"folderSelection": {
  "mode": "showDirectoryPicker",
  "fallbackMode": "webkitdirectory",
  "pickerId": "fb-workspace",
  "permissionMode": "readwrite",
  "persistHandles": true,
  "reRequestPermissionOnReload": true,
  "restoreLastFolder": true,
  "virtualPaths": true,
  "allowDragDrop": false
}
```

Usage:

```js
import { pickFolder, restoreLastFolder, fromConfigFile } from "./src/folder-select.js";

const cfg = fromConfigFile(loadedConfig);   // loadedConfig = .fb-browser-ui.json

document.querySelector("#pick-folder").addEventListener("click", async () => {
  const handle = await pickFolder(cfg);      // MUST be called from the handler
  console.log(virtualPath(handle));          // "workspace://my-project"
});

// On boot, reopen the last folder without a user gesture:
const handle = await restoreLastFolder(cfg);
```

## Serving ads to the browser UI

The browser port shows the same sponsored ads as the native desktop window —
there is no forwarding toggle. The UI fetches a banner ad from the desktop
orchestrator (`POST /api/ad/slot`) and renders inline ad cards inside long
assistant responses; the orchestrator auctions both placements server-side
against `https://www.codebuff.com/api/v1/ads` using the auth token in
`~/.config/freebuff-desktop/state.json`. If the network returns an empty
`ads` array (no fill), nothing renders — which is expected and not a config
issue. `src/check-ads.js` polls that auction so you can watch for real fill:

```bash
node src/check-ads.js            # poll every 60s until an ad fills
node src/check-ads.js --once     # single auction check
```

## Mobile adaptation

The desktop UI targets a mouse and a wide window; on a phone it falls apart
(the explorer panel and side reserves eat the viewport, menus are hover-first,
and inputs zoom on focus). `src/mobile-ui.css` + `src/mobile-ui.js` fix that
for narrow viewports:

- **1000px** — full mobile layout: the chat goes full-bleed (all desktop
  side-reserves zeroed), the composer stays docked with 16px input
  text (no iOS zoom-on-focus) and safe-area padding, and touch targets grow.
  The explorer is **hidden entirely** (no drawer, no rail): a header button
  (`.fb-panel-toggle`, next to the session switcher) summons it as a
  **sliding panel** that slides in from the right over the chat with a
  dimmed scrim behind — dismiss it via the scrim, the panel's own close
  (the app's collapse toggle), or Escape. It toggles through the app's own
  control, and its open state is **remembered per thread** (localStorage,
  same model as the context card): switching sessions or reloading
  restores each thread's panel state — opening records the thread, closing
  on it clears the memory, and the home screen is left alone.
  The tab strip collapses into a **slim header**: the home tab becomes a back
  button and the active thread tab becomes a full-width title. Tapping that
  title opens a small **thread menu** (rename / move to new window / close)
  that reuses the app's own tab actions (dblclick for rename, the tab's
  pop-out and close buttons), plus an on-demand **Larger chat text**
  accessibility toggle (persisted in localStorage) and a **Report an issue**
  entry (the bottom-right report pill is hidden on mobile — this menu reopens
  the app's own feedback modal for active sessions). Home/catalog mode and
  popout mode also get a compact header report affordance, so reporting stays
  available in every mobile view. The menu opens with the app's popover
  fade/scale animation and supports **swipe-down-to-close** on touch.
  Since the tab strip is hidden, a **session switcher** button sits in the
  header next to the title: it opens a dropdown of the open sessions
  (active one checked), switches by clicking the app's own `.tab-select`
  (native tab activation → thread load), and offers **New session** (the
  app's `.tab-new`) and **All sessions** (the home tab) shortcuts.  Each
  session row has a **close button** that closes it via the app's own
  `.tab-close` (which stopPropagates, so it won't also switch to it). Each
  open and Recent row also shows a compact model label beneath its session
  title; missing catalog metadata reads `Model unavailable` rather than
  guessing. A live `Running` or `Stopped` status appears beside each model
  label, sourced from native `turnState`/`lastTurnOutcome` metadata with the
  active tab/composer state as a live fallback; status polling stops when the
  switcher closes. A touch-friendly **Filter sessions by model** select can
  show only rows using Fable, Opus, Sonnet, or another resolved model; `All
  models` restores the full list and unknown metadata remains filterable as
  `Model unavailable`. Before native close runs, a confirmation popup asks **Close session?** with red
  **Yes** and green **No** actions. A visible live status message says
  **Confirmation required** and gives same choices to screen readers through
  `role="status"`, `aria-live="assertive"`, and `aria-atomic="true"`. A shared
  live region also announces selected session title, kept-open cancellation,
  successful close, or failed close outcome. No keeps menu open, while Yes
  performs the native close. The same confirmation protects the title-menu
  Close action.
  The list refreshes live as sessions open/close, and closing the active one
  dismisses the menu. Below the open sessions, a **Recent** section lists
  recently-active **closed** sessions from the app's own catalog API
  (  `/api/projects`, same-origin — titled, non-archived, newest first, with a
  relative time, and the **project name** under each title so sessions from
  different projects are easy to tell apart), and its header has a
  **refresh** button that re-fetches the catalog in place (with a spinner)
  so the list updates without reopening the menu. Picking one reopens it as a
  tab through the app's native
  path: go home, select its project, and click the matching catalog row  (a
  time-based tiebreak disambiguates duplicate titles). The session button
  shows a small pulsing **attention dot** (same `--brand` color as the app's
  own tab unseen-dot) whenever any open session needs attention — it mirrors
  the app's native `unseen` tab class (not active, not running, attention
  revision unacknowledged), kept in sync by the tabbar observer's live class
  updates. The button appears only while a session is open, the menu animates
  like the thread menu and supports swipe-down-to-close without closing when
  its Recent list is scrolled, and it hides on the home screen (which has its
  own catalog).
  The thread-window (popout) header gets a
  JS-injected back button too (the browser port has no tabs or window controls
  there), which closes the popout and returns focus to the opener.
  `src/mobile-ui.js` **auto-collapses the explorer on load** (the app starts
  with it open, which would hide the whole chat on a phone) and lets the app
  persist that choice, so the chat is always visible. The mobile hooks also
  re-enter cleanly after rotation/resizing, preserve panel/context state in
  per-thread maps, and apply the safe-area inset to the header and overlays.
  Startup is fail-open: the native workspace bootstrap gets a short head start,
  the shared observer ignores transcript mutations while an agent is streaming
  and class-sensitive observers are scoped to the tabbar, explorer, and
  composer. It also excludes always-visible `.composer-menu` wrappers from
  native-popup detection, so token updates cannot repeatedly close a menu the
  user is trying to open.
  The browser port restores tabs but not the home-tab flag, so a refresh would
  otherwise turn the previous home tab into a duplicate "New thread" session.
  `src/mobile-ui.js` remembers the home tab id in `sessionStorage` and closes
  the restored phantom once the replacement home tab mounts, so reloading
  never leaks an extra session (real untitled draft tabs are left alone).
  Mobile menus, sheets, and the tools panel share one overlay stack: opening
  one closes conflicting layers, while Android/browser Back dismisses the
  topmost layer before navigating away.
- **700px (phones)** — the **model picker becomes a full-screen scrollable
  sheet** (`inset: 0`, `max-height: 100dvh !important` to beat the app's
  inline trigger-position max-height), with a JS-injected close button
  (`src/mobile-ui.js` observes the menu, adds a fixed X, and closes it via
  Escape keydown — the app natively closes the menu on outside mousedown, so
  the button lives in `<body>` and works without touching the menu's own
  logic). The composer's **context chips row** (agent / model / effort /
  workspace selectors) is hidden and replaced by a **floating button** just
  above the composer; tapping it pops the chips up as a floating card so the
  composer never over-extends on narrow screens. The button is a **chevron**
  that rotates smoothly (up when closed, down when open) while the card
  **slides up** into place and **slides down** out of it — dismiss it with
  the same button, an outside tap, or Escape.
  Small **floating model**, **reasoning**, and **time-limit** pills stay just
  above the message box, so a new session still exposes its selected model,
  reasoning level, and current Freebuff session quota/time. Model and
  reasoning pills open the app's own native pickers through their triggers;
  the time pill opens the context card for full quota details. During an
  active turn, a compact pulsing **Streaming** indicator appears in the slim
  header while model, tools, session, and context controls remain visible.
  The native agent **To-dos** card is moved out of the bottom composer flow and
  floats below the safe-area header with its own bounded scroll area, so task
  rows stay visible instead of competing with the model/reasoning/time pills.
  Shared collision-aware layout measures visible menus, context cards, sheets,
  composer, and pills; it stacks task card below top blockers, caps its height
  above bottom controls, and hides it only while a full-screen sheet owns the
  viewport.

  The active thread's native elapsed-time status is also retained in the slim
  header, so its time indicator is not lost when desktop tab metadata is
  collapsed. The pills are grouped into one compact row to avoid overlap on
  narrow phones, and their labels refresh when React mounts a new composer or
  updates a running session countdown.
  The composer's **action row** (attach / stop / stash / send) collapses
  into that same card too, so the input area on phones is just the
  textarea (Enter still sends). The card's action bar shows attach always,
  stop only while a turn is running, stash when there's something to
  restore, and a send button that lights up when the message is ready —
  each one clicks the app's own (hidden) button, so behaviors stay native.
  The **stop button also stays visible next to the textarea** while a turn
  is running (the app only renders it then, so it adds no idle clutter) —
  stopping a run stays one tap away even though the card lives in the
  header.
  The card's open state is **persisted per thread** (localStorage), so
  switching away and back, or reloading the page, restores the chip layout
  you left it in; scrolling the chat no longer dismisses it (only an
  outside tap, Escape, or the chevron does).
  **Model sheet note:** the full-screen sheet replaces the anchored popup
  only on phones; each model row now shows compact concurrent capacity when
  app reports it (for example, `2 available` or `At capacity`) without using
  alarming red for normal slot exhaustion. A `Used by: Session name` line
  identifies open sessions consuming that model when same-origin catalog data
  exposes the mapping; tap a listed session name to jump directly to its open
  tab. Keyboard Enter/Space works too. Disabled model rows keep holder names
  tappable; otherwise UI says `Session names unavailable` instead of guessing
  by Premium/Unlimited bucket. Sticky `Session availability`
  summary keeps grouped counts visible while scrolling. Each model also shows
  its native quota reset time beside capacity; if app exposes no reset metadata,
  UI says `Reset time unavailable` instead of guessing. While sheet stays open,
  native slot-badge and session metadata changes refresh automatically through
  scoped observers with low-frequency fallback polls; updated values remain
  announced through the live status.
  The effort selector beside it keeps its native
  anchored menu. Other dropdown menus (workspace/settings, effort selector) stay
  anchored to their triggers but widen and scroll (they must NOT become
  fixed bottom sheets: those anchor upward with `bottom: calc(100% + …)`,
  which goes off-screen under fixed positioning). Modals become bottom
  sheets.
  Text keeps the app's native sizes (no font bump, so the chat doesn't look
  zoomed in), and the viewport stays user-zoomable (no user-scalable=no
  lock).
- **480px** — further tightening for small phones.

Automated mobile regression coverage runs the injected CSS and JavaScript in a
native-UI fixture at a 390×844 phone viewport. It captures
`mobile-ui-header-composer-task.png`,
`mobile-ui-model-picker-availability.png`, `mobile-ui-session-status.png`, plus
`mobile-ui-session-close-confirm.png` and asserts slim-header bounds, visible
model/reasoning/time pills, task-card separation from both header and composer
pills, live Running/Stopped session status labels, model-filter option and
row visibility, close-confirmation button colors, visible live-region semantics,
selected-session announcements, close outcomes, Escape, browser Back, backdrop
cancel, focus restoration, and desktop cleanup
after widening the viewport. The test uses Chrome's
built-in DevTools Protocol client; no Playwright or npm dependency is needed.
Run locally with Chrome installed:

```bash
node --test --test-timeout=20000 src/mobile-ui-screenshot.test.js
```

Set `FB_CHROME_BIN` to select a non-default Chrome executable. CI runs the same
test through `.github/workflows/mobile-ui-screenshot.yml` and uploads the PNG
for visual review. Test also queries Chrome's accessibility tree for selected
session and close-outcome status text. This is not spoken TalkBack/VoiceOver
validation: real TalkBack needs a connected Android device or hardware-
accelerated emulator, and VoiceOver needs macOS/iOS tooling.

The tailnet proxy injects these after the app's own stylesheet, so the
overrides win and desktop viewports are untouched:

```js
// in the proxy's HTML injection branch (where SHIM is injected):
body = body.replace(marker, MOBILE_TAG('css') + MOBILE_TAG('js') + SHIM + marker);
```

where `MOBILE_TAG` inlines `src/mobile-ui.css` / `src/mobile-ui.js` into
`<style>` / `<script>` tags read fresh per request (edit the files, reload
the page — no proxy restart needed).

## Secrets

This repo must stay free of secrets. The `.gitignore` excludes `.env*`,
`state.json`, keypair/key/token files, databases, logs, and runtime state.

- Real values always live in a local, git-ignored `.env` — never in
  `.fb-browser-ui.json`.
- The Freebuff Desktop `state.json` (which holds auth tokens) is mirrored in
  shape only; the real file stays outside the repo.
- The `auth.tokenEnv` setting names the env var the browser port reads at
  runtime; no token is ever inline.

## Layout

```
FB-Browser-UI/
├── .fb-browser-ui.json      # the dotfile configuration (edit this)
├── .env.example             # template for local .env (never committed)
├── .gitignore               # secrets and runtime state stay out
├── AGENTS.md                # shared Caveman profile for Freebuff
├── README.md
├── android/                 # Kotlin Android pairing/WebView scaffold
└── src/
    ├── folder-select.js     # the folder-selection tweak implementation
    ├── check-ads.js         # ad-auction poller (watch for real fill)
    ├── install-caveman.js   # project/global Caveman profile installer
    ├── mobile-connect-protocol.js  # pairing/token protocol helpers
    ├── mobile-connect-gateway.js   # pairing control plane
    ├── mobile-connect-websocket.js # relay WebSocket framing
    ├── mobile-connect-relay.js     # managed relay data plane
    ├── mobile-connect-agent.js     # desktop outbound connector
    ├── install-mobile-connect.js    # Desktop companion installer
    ├── package-mobile-connect-release.js # versioned release artifact packager
    ├── mobile-connect-e2e-fixture.js # ephemeral HTTPS Android CI fixture
    ├── mobile-ui.css        # mobile/tablet responsive layer (proxy-injected)
    ├── mobile-ui.js         # viewport/touch helpers for phones
    ├── mobile-ui-screenshot-fixture.html # deterministic mobile test fixture
    └── mobile-ui-screenshot.test.js # Chromium screenshot/layout regression
```
