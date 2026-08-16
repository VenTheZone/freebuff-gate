# Freebuff Gate: Install Guide (agent prompt)

This file is an install guide written as a copy-paste prompt. Give the whole
raw text below to an AI coding agent (e.g. Buffy / Codebuff) and it will set up
the Freebuff Gate stack on a machine: the desktop orchestrator, the tailnet
proxy with the mobile UI layer, the boot-time patches that stop empty-thread
pollution, the server-side folder browser shim, and (optionally) the mobile
relay + connector so the Freebuff Gate Android app can pair.

---

## Copy from here

```text
You are setting up the Freebuff Gate stack on this machine. Follow these
steps in order and verify each one. The app is Freebuff Desktop, a packaged
Electron-style app whose orchestrator (a Bun server) serves the browser UI.

### Prerequisites
- Node.js 22+ and Bun (Bun ships inside the app at
  ~/.local/share/freebuff-desktop/squashfs-root/resources/bun/bun; use that
  binary for sqlite access).
- Tailscale installed, logged in, and the machine on the user's tailnet.
- The Freebuff Desktop app installed at ~/.local/share/freebuff-desktop/ and
  the FB-Browser-UI repo cloned at ~/FB-Browser-UI (this guide lives at
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

### 1. Verify the orchestrator
The orchestrator serves the browser UI on 127.0.0.1:58060 (and tailnet IP).
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
- Verify: curl http://127.0.0.1:58061/ | grep fb-mobile-ui  (should match)
- Verify the shim on the direct UI: curl -s http://127.0.0.1:58060/ | grep -c fb-desktop-shim  (should be 1)
- Verify the dirlist route: curl -s 'http://127.0.0.1:58060/api/fb/dirlist?path=/home' returns JSON entries.
- Verify the browser works: open the UI, click "New session", click the
  project picker, choose "Open project". A file browser listing the server's
  folders must appear (starting at the most recent project directory); click
  into folders and select one. The chosen path is a real server path.

### 3. Mobile relay + connector (optional, for the Freebuff Gate Android app)
### 5. Mobile relay + connector (optional, for the Freebuff Gate Android app)
If the phone app is used:
- Copy ~/FB-Browser-UI/src/mobile-connect-relay.js and
  ~/FB-Browser-UI/src/mobile-connect-agent.js to
  ~/.local/share/freebuff-desktop/.
- Install systemd USER units like the existing
  freebuff-mobile-relay.service / freebuff-mobile-agent.service in this repo's
  docs or ~/.config/systemd/user/ on the reference machine, with the agent's
  upstream pointing at http://127.0.0.1:58061 (the proxy, so the mobile UI
  layer is injected) and the relay exposed on a tailnet HTTPS URL.
- Set a strong connector token (relay --connector-token) and store it in a
  root-only file (chmod 600). Never commit it.

### 4. Exposure
- The orchestrator already listens on the tailnet IP:58060 (verify with
  `tailscale ip -4`). If not, bind it to 0.0.0.0 or use `tailscale serve`.
- 58061 (proxy) is loopback-only; the relay (step 5) is the public face for
  phones. Do NOT open raw ports to the internet; Tailscale (or the relay's
  HTTPS) is the only exposure.

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
  lines to ~/.config/freebuff-desktop/ad-sniff.log. Re-apply after app
  updates; the proxy-side half lives in the repo (src/freebuff_tailnet_proxy.js)
  and only needs a proxy restart.
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

## What this guide covers

| Layer | File | Port | Purpose |
|-------|------|------|---------|
| Orchestrator | `orchestrator.js` (packaged) | 58060 | Browser UI server, projects, threads |
| Tailnet proxy | `src/freebuff_tailnet_proxy.js` | 58061 | Mobile UI injection, desktop shim, bundle patch |
| Relay | `src/mobile-connect-relay.js` | 8795 | HTTPS/WSS for the Android app |
| Agent | `src/mobile-connect-agent.js` | n/a | Bridges relay → proxy (58061) |
| Mobile UI | `src/mobile-ui.css`, `src/mobile-ui.js` | n/a | Mobile adaptation layer |
| iOS app | `ios/` | n/a | Native iOS companion (QR pairing, restricted WKWebView) |

## iOS companion app

`ios/` is the native iOS port of the Android companion: QR pairing, Keychain
device identity, AES-GCM session storage, reconnect with jittered backoff,
and a WKWebView restricted to the relay origin. Build with XcodeGen + Xcode
(see ios/README.md), or let .github/workflows/ios.yml build it on macOS CI.
CI produces an unsigned simulator .app by default; a signed IPA requires an
Apple Developer account (ad-hoc signing secrets), which the signed-ipa job
uses when present. The app pairs against the same managed relay and consumes
the same /v1/mobile/session cookie exchange as Android.

## Why these patches exist

- **Boot-time thread pollution**: the packaged UI created 1 to 3 empty "New
  thread" rows on every page load. The bundle patch pins one dedicated home
  thread per browser (localStorage `fb.homeThread`), reuses it on reload,
  and keeps `activeId` on the last chat instead of hijacking it.
- **Folder browser**: the browser can't see the server's filesystem and has no
  Electron picker, so the shim provides `pickDirectory` as a server-side file
  browser (breadcrumbs, Up/Home, recents) over the orchestrator's
  `/api/fb/dirlist` route. No path typing needed.
- **Mobile adaptation**: the desktop UI isn't mobile friendly; the proxy
  injects the scoped mobile layer at ≤1000px.
- **WebView caching**: the Android WebView used LOAD_NO_CACHE, so every load
  re-downloaded the ~1.5MB bundle through the relay chain. The WebView now
  uses LOAD_DEFAULT; HTML is no-store, hashed assets are immutable, and the
  proxy serves the patched bundle with an ETag so reloads return 304.
