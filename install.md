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
  install.md in that repo).
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

### 2. Install the tailnet proxy (port 58061)
The proxy injects the mobile adaptation and the window.freebuffDesktop shim,
and patches the UI bundle. It lives at ~/FB-Browser-UI/src/freebuff_tailnet_proxy.js.
- Copy it to ~/.local/share/freebuff-desktop/freebuff_tailnet_proxy.js
- Install a systemd USER unit so it survives reboots:
  ~/.config/systemd/user/freebuff-tailnet-proxy.service with
  ExecStart=/usr/bin/node /home/<user>/.local/share/freebuff-desktop/freebuff_tailnet_proxy.js
  (or the pi-node path if that is what the machine uses), Restart=always.
- systemctl --user daemon-reload && systemctl --user enable --now freebuff-tailnet-proxy
- Verify: curl http://127.0.0.1:58061/ | grep fb-mobile-ui  (should match)

### 3. Patch the packaged UI bundle (stops empty-thread pollution)
The packaged UI auto-creates an empty "New thread" on every page load through
openTab(path, threadId, home=true). Patch the served JS so the boot home call
reuses an existing thread instead:
- Bundle: <install>/squashfs-root/resources/orchestrator/ui/assets/index-*.js
- Find the exact string:
  lr(t,()=>ve.createThread(n,{inheritFromThreadId:i}),"Could not open tab")
- Replace it with the CREATE_REUSE constant defined in
  ~/FB-Browser-UI/src/freebuff_tailnet_proxy.js (the proxy already applies
  this same patch to what it serves; the on-disk patch is for clients that
  hit 58060 directly).
- After replacing, run: node --check on the bundle file.
- Verify the served bundle contains the marker:
  curl -s http://127.0.0.1:58060/assets/index-*.js | grep -c fb.homeThread
  (should be 1)

### 4. Inject the desktop shim into index.html (server-side folder browser)
The "Open project" flow needs window.freebuffDesktop.pickDirectory. The shim
now opens a server-side file browser (breadcrumb path bar, directory list,
Up/Home buttons, quick-pick recent projects) backed by the orchestrator's
GET /api/fb/dirlist?path=... route. Extract the SHIM template string from
~/FB-Browser-UI/src/freebuff_tailnet_proxy.js and inject it into
<install>/squashfs-root/resources/orchestrator/ui/index.html as
<script id="fb-desktop-shim">…</script> right before </head> (replace any
existing fb-desktop-shim tag).
- Verify: curl -s http://127.0.0.1:58060/ | grep -c fb-desktop-shim  (should be 1)
- Verify the dirlist route: curl -s
  'http://127.0.0.1:58060/api/fb/dirlist?path=/home' returns JSON entries.
- Verify the browser works: open the UI, click "New session", click the
  project picker, choose "Open project". A file browser listing the server's
  folders must appear (start at the most recent project directory); click
  into folders and select one. The chosen path is a real server path.

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

### 6. Exposure
- The orchestrator already listens on the tailnet IP:58060 (verify with
  `tailscale ip -4`). If not, bind it to 0.0.0.0 or use `tailscale serve`.
- 58061 (proxy) is loopback-only; the relay (step 5) is the public face for
  phones. Do NOT open raw ports to the internet; Tailscale (or the relay's
  HTTPS) is the only exposure.

### 7. Final verification checklist
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
  orchestrator.js. After an update, re-run steps 3, 4, and the
  /api/fb/dirlist orchestrator patch (the proxy keeps applying its own
  bundle patch at serve time, but the on-disk index.html shim, the on-disk
  bundle patch, and the orchestrator route must be re-applied for direct
  58060 clients).
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

## Why these patches exist

- **Boot-time thread pollution**: the packaged UI created 1 to 3 empty "New
  thread" rows on every page load. The bundle patch makes the boot home call
  reuse an existing live thread (with a localStorage pin + hydration retry),
  so reloads never spawn garbage threads.
- **Folder browser**: the browser can't see the server's filesystem and has no
  Electron picker, so the shim provides `pickDirectory` as a server-side file
  browser (breadcrumbs, Up/Home, recents) over the orchestrator's
  `/api/fb/dirlist` route. No path typing needed.
- **Mobile adaptation**: the desktop UI isn't mobile friendly; the proxy
  injects the scoped mobile layer at ≤1000px.
