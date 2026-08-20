# Gate Mobile

Gate Mobile is the phone/tablet adaptation of Gate Desktop. The desktop
layout targets a mouse and a wide window; on a phone it falls apart (the
explorer panel and side reserves eat the viewport, menus are hover-first,
and inputs zoom on focus). `src/mobile-ui.css` + `src/mobile-ui.js` fix that
for narrow viewports:

- **1000px**: full mobile layout. The chat goes full-bleed (all desktop
  side-reserves zeroed), the composer stays docked with 16px input text (no
  iOS zoom-on-focus) and safe-area padding, and touch targets grow.
  - The explorer is **hidden entirely** (no drawer, no rail). A header
    button (`.fb-panel-toggle`, next to the session switcher) summons it as
    a **sliding panel** that slides in from the right over the chat with a
    dimmed scrim behind. Dismiss it via the scrim, the panel's own close
    (the app's collapse toggle), or Escape. It toggles through the app's own
    control, and its open state is **remembered per thread** (localStorage,
    same model as the context card): switching sessions or reloading
    restores each thread's panel state. Opening records the thread, closing
    on it clears the memory, and the home screen is left alone.
  - The tab strip collapses into a **slim header**: the home tab becomes a
    back button and the active thread tab becomes a full-width title.
    Tapping that title opens a small **thread menu** (rename / move to new
    window / close) that reuses the app's own tab actions (dblclick for
    rename, the tab's pop-out and close buttons), plus an on-demand
    **Larger chat text** accessibility toggle (persisted in localStorage)
    and a **Report an issue** entry (the bottom-right report pill is hidden
    on mobile; this menu reopens the app's own feedback modal for active
    sessions). Home/catalog mode and popout mode also get a compact header
    report affordance, so reporting stays available in every mobile view.
    The menu opens with the app's popover fade/scale animation and supports
    **swipe-down-to-close** on touch.
  - Since the tab strip is hidden, a **session switcher** button sits in the
    header next to the title. It opens a dropdown of the open sessions
    (active one checked), switches by clicking the app's own `.tab-select`
    (native tab activation → thread load), and offers **New session** (the
    app's `.tab-new`) and **All sessions** (the home tab) shortcuts. A
    separate **`+` new-session button** sits beside the switcher (hidden on
    desktop, where the tab strip already shows the app's own `.tab-new`) so
    a new thread is always one tap away on a phone even when the home thread
    already holds a conversation.
  - Each session row has a **close button** that closes it via the app's own
    `.tab-close` (which stopPropagates, so it won't also switch to it).
    Before native close runs, a confirmation popup asks **Close session?**
    with red **Yes** and green **No** actions. A visible live status message
    says **Confirmation required** and gives the same choices to screen
    readers through `role="status"`, `aria-live="assertive"`, and
    `aria-atomic="true"`. A shared live region also announces the selected
    session title, kept-open cancellation, successful close, or failed close
    outcome. No keeps the menu open; Yes performs the native close. The same
    confirmation protects the title-menu Close action.
  - Each open and Recent row shows a compact model label beneath its session
    title; missing catalog metadata reads `Model unavailable` rather than
    guessing. A live `Running` or `Stopped` status appears beside each model
    label, sourced from native `turnState`/`lastTurnOutcome` metadata with
    the active tab/composer state as a live fallback; status polling stops
    when the switcher closes. A touch-friendly **Filter sessions by model**
    select can show only rows using Fable, Opus, Sonnet, or another resolved
    model; `All models` restores the full list and unknown metadata remains
    filterable as `Model unavailable`.
  - The list refreshes live as sessions open/close, and closing the active
    one dismisses the menu. Below the open sessions, a **Recent** section
    lists recently-active **closed** sessions from the app's own catalog API
    (`/api/projects`, same-origin: titled, non-archived, newest first, with
    a relative time, and the **full project path** under each title so
    sessions from different projects are easy to tell apart). Its header has
    a **refresh** button that re-fetches the catalog in place (with a
    spinner) so the list updates without reopening the menu. Picking one
    reopens it as a tab through the app's own open-thread action, which the
    tailnet proxy exposes on `window.__fbOpenThread` (a bundle patch); the
    older catalog-click fallback (go home, select the project, click the
    matching row) still runs when the patch is absent, with a time-based
    tiebreak for duplicate titles.
  - The session button shows a small pulsing **attention dot** (same
    `--brand` color as the app's own tab unseen-dot) whenever any open
    session needs attention. It mirrors the app's native `unseen` tab class
    (not active, not running, attention revision unacknowledged), kept in
    sync by the tabbar observer's live class updates. The button stays
    visible whenever any tab exists, including the boot-home thread, so the
    dropdown (Recent sessions + New session) is never the dead end it was
    when the home thread was the only open tab. The menu animates like the
    thread menu and supports swipe-down-to-close without closing when its
    Recent list is scrolled.
  - The thread-window (popout) header gets a JS-injected back button too
    (the browser port has no tabs or window controls there), which closes
    the popout and returns focus to the opener.
  - `src/mobile-ui.js` **auto-collapses the explorer on load** (the app
    starts with it open, which would hide the whole chat on a phone) and
    lets the app persist that choice, so the chat is always visible. The
    mobile hooks also re-enter cleanly after rotation/resizing, preserve
    panel/context state in per-thread maps, and apply the safe-area inset to
    the header and overlays. Startup is fail-open: the native workspace
    bootstrap gets a short head start, the shared observer ignores
    transcript mutations while an agent is streaming, and class-sensitive
    observers are scoped to the tabbar, explorer, and composer. It also
    excludes always-visible `.composer-menu` wrappers from native-popup
    detection, so token updates cannot repeatedly close a menu the user is
    trying to open.
  - The browser port restores tabs but not the home-tab flag, so a refresh
    would otherwise turn the previous home tab into a duplicate "New thread"
    session. `src/mobile-ui.js` remembers the home tab id in
    `sessionStorage` and closes the restored phantom once the replacement
    home tab mounts, so reloading never leaks an extra session (real
    untitled draft tabs are left alone).
  - Mobile menus, sheets, and the tools panel share one overlay stack:
    opening one closes conflicting layers, while Android/browser Back
    dismisses the topmost layer before navigating away.
- **700px (phones)**: the **model picker becomes a full-screen scrollable
  sheet** (`inset: 0`, `max-height: 100dvh !important` to beat the app's
  inline trigger-position max-height), with a JS-injected close button
  (`src/mobile-ui.js` observes the menu, adds a fixed X, and closes it via
  Escape keydown; the app natively closes the menu on outside mousedown, so
  the button lives in `<body>` and works without touching the menu's own
  logic).
  - The composer's **context chips row** (agent / model / effort / workspace
    selectors) is hidden and replaced by a **floating button** just above
    the composer. Tapping it pops the chips up as a floating card so the
    composer never over-extends on narrow screens. The button is a
    **chevron** that rotates smoothly (up when closed, down when open) while
    the card **slides up** into place and **slides down** out of it. Dismiss
    it with the same button, an outside tap, or Escape.
  - Small **floating model**, **reasoning**, and **time-limit** pills stay
    just above the message box, so a new session still exposes its selected
    model, reasoning level, and current Freebuff session quota/time. Model
    and reasoning pills open the app's own native pickers through their
    triggers; the time pill opens the context card for full quota details.
    During an active turn, a compact pulsing **Streaming** indicator appears
    in the slim header while model, tools, session, and context controls
    remain visible.
  - The native agent **To-dos** card is moved out of the bottom composer
    flow and floats below the safe-area header with its own bounded scroll
    area, so task rows stay visible instead of competing with the
    model/reasoning/time pills. Shared collision-aware layout measures
    visible menus, context cards, sheets, composer, and pills; it stacks the
    task card below top blockers, caps its height above bottom controls, and
    hides it only while a full-screen sheet owns the viewport.
  - The active thread's native elapsed-time status is retained in the slim
    header, so its time indicator is not lost when desktop tab metadata is
    collapsed. The pills are grouped into one compact row to avoid overlap
    on narrow phones, and their labels refresh when React mounts a new
    composer or updates a running session countdown.
  - The composer's **action row** (attach / stop / stash / send) collapses
    into that same card too, so the input area on phones is just the
    textarea (Enter still sends). The card's action bar shows attach always,
    stop only while a turn is running, stash when there's something to
    restore, and a send button that lights up when the message is ready.
    Each one clicks the app's own (hidden) button, so behaviors stay native.
    The **stop button also stays visible next to the textarea** while a turn
    is running (the app only renders it then, so it adds no idle clutter).
    Stopping a run stays one tap away even though the card lives in the
    header.
  - The card's open state is **persisted per thread** (localStorage), so
    switching away and back, or reloading the page, restores the chip layout
    you left it in; scrolling the chat no longer dismisses it (only an
    outside tap, Escape, or the chevron does).
  - **Model sheet note:** the full-screen sheet replaces the anchored popup
    only on phones; each model row now shows compact concurrent capacity
    when the app reports it (for example, `2 available` or `At capacity`)
    without using alarming red for normal slot exhaustion. A `Used by:
    Session name` line identifies open sessions consuming that model when
    same-origin catalog data exposes the mapping; tap a listed session name
    to jump directly to its open tab. Keyboard Enter/Space works too.
    Disabled model rows keep holder names tappable; otherwise UI says
    `Session names unavailable` instead of guessing by Premium/Unlimited
    bucket. A sticky `Session availability` summary keeps grouped counts
    visible while scrolling. Each model also shows its native quota reset
    time beside capacity; if the app exposes no reset metadata, UI says
    `Reset time unavailable` instead of guessing. While the sheet stays
    open, native slot-badge and session metadata changes refresh
    automatically through scoped observers with low-frequency fallback
    polls; updated values remain announced through the live status.
  - The effort selector beside it keeps its native anchored menu. Other
    dropdown menus (workspace/settings, effort selector) stay anchored to
    their triggers but widen and scroll (they must NOT become fixed bottom
    sheets: those anchor upward with `bottom: calc(100% + …)`, which goes
    off-screen under fixed positioning). Modals become bottom sheets.
  - Text keeps the app's native sizes (no font bump, so the chat doesn't
    look zoomed in), and the viewport stays user-zoomable (no
    user-scalable=no lock).
- **480px**: further tightening for small phones.

## Built-in theme picker

The header (mobile and desktop) carries a palette button that switches
between the built-in themes:

1. **Default dark**, the app's own dark theme, untouched.
2. **Cyberpunk 2077**, a dark-side Cyberpunk skin: near-black violet
   surfaces, Cyberpunk's signature yellow for brand accents (spinners,
   unseen dots, pills), cyan for focus rings and neon hairlines, plus a
   faint ambient background (soft cyan/violet neon wash and CRT scanlines)
   that shows only through the app's transparent regions. Nothing bright;
   it stays on the dark side.

The choice persists per browser in `localStorage` (`fb-ui:theme`) and
applies before the app paints, so reloads never flash the wrong theme. The
Cyberpunk theme is independent of the app's native dark/light switch: when
active it overrides that switch (the injected stylesheet is served after
the app's CSS). The implementation lives in `src/mobile-ui.js` (picker
state) and `src/mobile-ui.css` (scoped under
`:root[data-fb-theme='cyberpunk']`).

The gate options also appear inside the app's own Appearance UI, where the
native Light/Dark/System choices live: the account menu's Appearance group
gets a "Gate themes" section (Default dark / Cyberpunk 2077, with check
marks), and the new-thread screen's theme switch row gets the same two
options as icon buttons. Picking a native Light/Dark/System option clears
the gate override, so the app's own switch stays authoritative once
touched.

### Source-file fallback (repo edits apply without re-installing)

The proxy normally serves `mobile-ui.css` / `mobile-ui.js` from its own
deploy directory. When the installer or setup wizard deploys the proxy, it
writes a `ui-source.json` sidecar next to the proxy recording the directory
the files were deployed from (the repo `src/`, or the setup-binary's asset
cache). At serve time the proxy stats both copies per request and serves the
one with the newer mtime, so an edit made in the repo after install shows
up on reload, with no re-run of the installer. Override the recorded path
with `FB_UI_SOURCE_DIR`. If the source copy is missing or older, the
deployed copy is served as before. `install-mobile-connect.js verify`
reflects this: stale deployed UI is a warning when the sidecar is present
(the proxy self-heals) and an error on older installs without it.

## Theming SDK

The mobile layer is themed through CSS custom properties (tokens). All
interactive mobile chrome reads `--fb-m-*` variables (brand color, ink,
soft background, focus ring, glow) defined in `src/mobile-ui.css` for both
dark and light themes, so a redesign is a token reassignment, not a fork of
the stylesheet.

To apply your own theme, drop a `theme.css` in the proxy's deploy directory
or point `FB_MOBILE_THEME_FILE` at your file:

```bash
# default location
~/.local/share/freebuff/tailnet-proxy/theme.css

# or any path
FB_MOBILE_THEME_FILE=/path/to/theme.css <start the proxy>
```

The proxy injects the theme **after** `mobile-ui.css` on every page load, so
plain CSS wins and tokens can be re-assigned wholesale. Missing file = no-op.
Edit the file, reload the page; no proxy restart needed.

Example theme (dark, amber accent):

```css
/* theme.css — reassign the mobile brand tokens */
:root {
  --fb-m-brand: #ffb020;
  --fb-m-brand-ink: #1a1206;
  --fb-m-brand-soft: color-mix(in srgb, #ffb020 13%, transparent);
  --fb-m-brand-ring: color-mix(in srgb, #ffb020 24%, transparent);
  --fb-m-brand-glow: 0 4px 16px -6px color-mix(in srgb, #ffb020 45%, transparent);
}
:root[data-theme='light'] {
  --fb-m-brand: #b26a00;
  --fb-m-brand-ink: #fff8ec;
}
```

Beyond tokens, the theme file is plain CSS: hide, restyle, or reposition any
mobile element (`display:none`, custom paddings, per-element colors). The
scope is the injected layer only; desktop viewports are untouched because
mobile-ui.css applies at narrow widths.

Full token inventory lives in `src/mobile-ui.css` (search for `--fb-m-`).

## Turn notifications (stay-alive)

Gate Mobile keeps a background connection so it can notify when Buffy
finishes a turn:

- **Android**: a foreground `TurnNotificationService` (dataSync type) holds
  a long-lived HTTPS SSE stream to `GET /v1/mobile/events` on the relay,
  which proxies the desktop orchestrator's `/api/events` stream through the
  device's connector. When an `agent` event with `event.type == "finish"`
  arrives and the app is not in the foreground, a local notification
  ("Buffy finished working") is raised; tapping it opens the app. The
  service refreshes the short-lived access token before each reconnect and
  backs off on errors. It starts when the app reaches CONNECTED and stops
  when unpaired/revoked/disconnected.
- **iOS**: `AppDelegate` registers for remote notifications; the APNs device
  token is uploaded to the relay via `POST /v1/mobile/push-token` (Bearer
  access token). The relay's turn-finished watcher sends the APNs push
  (ES256 JWT auth, HTTP/2) when a `finish` event arrives for a device that
  is not currently connected, so the notification arrives even while the
  app is backgrounded or killed. Requires the `aps-environment` entitlement
  (development in the repo; switch to `production` for TestFlight/App
  Store) and a real APNs key: set `FB_APNS_KEY` (path to the .p8 key),
  `FB_APNS_KEY_ID`, `FB_APNS_TEAM_ID` (and optionally `FB_APNS_TOPIC`,
  default `com.freebuff.gate`) on the relay's systemd unit. Without these
  env vars the watcher skips push (no crash); foreground notification still
  works via `UNUserNotificationCenter`. `UIBackgroundModes`
  `remote-notification` is set for silent pushes.

The relay route requires a valid access token (`Bearer`), returns 401
otherwise, and streams with no fixed timeout (the app's service reconnects
on drop; the connector-disconnect path destroys the stream).

**Desktop-idle push rule.** The watcher tracks the user's last prompt per
connector from the thread events on the same `/api/events` stream
(`thread.lastPromptAt`). When a turn finishes and the desktop has been idle
for more than `FB_PUSH_DESKTOP_IDLE_MS` (default 120000 ms = 2 min),
meaning the user left the desktop UI open and walked away, the push fires
to every
paired device even if that device's app was used moments ago. When the
desktop is active, the per-device 2-minute recency skip still applies so a
live phone screen is not double-notified.

## Regression coverage

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
the page; no proxy restart needed).
