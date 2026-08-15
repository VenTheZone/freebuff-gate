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
| `.env.example` | Non-secret env template. Real values go in a git-ignored `.env`. |
| `.gitignore` | Excludes every secret and piece of runtime state from the repo. |

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

- **900px** — full mobile layout: the chat goes full-bleed (all desktop
  side-reserves zeroed), the explorer becomes a full-screen drawer and a slim
  44px icon rail when collapsed, the composer stays docked with 16px input
  text (no iOS zoom-on-focus) and safe-area padding, and touch targets grow.
  The tab strip collapses into a **slim header**: the home tab becomes a back
  button and the active thread tab becomes a full-width title. Tapping that
  title opens a small **thread menu** (rename / move to new window / close)
  that reuses the app's own tab actions (dblclick for rename, the tab's
  pop-out and close buttons), plus an on-demand **Larger chat text**
  accessibility toggle (persisted in localStorage). The menu opens with the
  app's popover fade/scale animation and supports **swipe-down-to-close** on
  touch.
  Since the tab strip is hidden, a **session switcher** button sits in the
  header next to the title: it opens a dropdown of the open sessions
  (active one checked), switches by clicking the app's own `.tab-select`
  (native tab activation → thread load), and offers **New session** (the
  app's `.tab-new`) and **All sessions** (the home tab) shortcuts.  Each
  session row has a **close button** that closes it via the app's own
  `.tab-close` (which stopPropagates, so it won't also switch to it); the
  list refreshes live as sessions open/close, and closing the active one
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
  revision unacknowledged), kept in sync by the tabbar observer. The button
  appears only while a session is open, the menu animates like the thread
  menu and supports swipe-down-to-close, and it hides on the home screen
  (which has its own catalog).
  The thread-window (popout) header gets a
  JS-injected back button too (the browser port has no tabs or window controls
  there), which closes the popout and returns focus to the opener.
  `src/mobile-ui.js`
  **auto-collapses the explorer on load** (the app starts with it open, which
  would hide the whole chat on a phone) and lets the app persist that choice,
  so the chat is always visible.
- **700px (phones)** — the **model picker becomes a full-screen scrollable
  sheet** (`inset: 0`, `max-height: 100dvh !important` to beat the app's
  inline trigger-position max-height), with a JS-injected close button
  (`src/mobile-ui.js` observes the menu, adds a fixed X, and closes it via
  Escape keydown — the app natively closes the menu on outside mousedown, so
  the button lives in `<body>` and works without touching the menu's own
  logic). Other dropdown menus (workspace/settings, effort selector) stay
  anchored to their triggers but widen and scroll (they must NOT become fixed
  bottom sheets: those anchor upward with `bottom: calc(100% + …)`, which
  goes off-screen under fixed positioning). Modals become bottom sheets.
  Text keeps the app's native sizes (no font bump, so the chat doesn't look
  zoomed in), and the viewport stays user-zoomable (no user-scalable=no
  lock).
- **480px** — further tightening for small phones.

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
├── README.md
└── src/
    ├── folder-select.js     # the folder-selection tweak implementation
    ├── check-ads.js         # ad-auction poller (watch for real fill)
    ├── mobile-ui.css        # mobile/tablet responsive layer (proxy-injected)
    └── mobile-ui.js         # viewport/touch helpers for phones
```
