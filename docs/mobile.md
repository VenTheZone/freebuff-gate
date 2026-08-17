# Gate Mobile

Gate Mobile is the phone/tablet adaptation of Gate Desktop. The desktop
layout targets a mouse and a wide window; on a phone it falls apart
(the explorer panel and side reserves eat the viewport, menus are hover-first,
and inputs zoom on focus). `src/mobile-ui.css` + `src/mobile-ui.js` fix that
for narrow viewports:

- **1000px**: full mobile layout. The chat goes full-bleed (all desktop
  side-reserves zeroed), the composer stays docked with 16px input
  text (no iOS zoom-on-focus) and safe-area padding, and touch targets grow.
  The explorer is **hidden entirely** (no drawer, no rail): a header button
  (`.fb-panel-toggle`, next to the session switcher) summons it as a
  **sliding panel** that slides in from the right over the chat with a
  dimmed scrim behind. Dismiss it via the scrim, the panel's own close
  (the app's collapse toggle), or Escape. It toggles through the app's own
  control, and its open state is **remembered per thread** (localStorage,
  same model as the context card): switching sessions or reloading
  restores each thread's panel state. Opening records the thread, closing
  on it clears the memory, and the home screen is left alone.
  The tab strip collapses into a **slim header**: the home tab becomes a back
  button and the active thread tab becomes a full-width title. Tapping that
  title opens a small **thread menu** (rename / move to new window / close)
  that reuses the app's own tab actions (dblclick for rename, the tab's
  pop-out and close buttons), plus an on-demand **Larger chat text**
  accessibility toggle (persisted in localStorage) and a **Report an issue**
  entry (the bottom-right report pill is hidden on mobile; this menu reopens
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
  (`/api/projects`, same-origin: titled, non-archived, newest first, with a
  relative time, and the **project name** under each title so sessions from
  different projects are easy to tell apart), and its header has a
  **refresh** button that re-fetches the catalog in place (with a spinner)
  so the list updates without reopening the menu. Picking one reopens it as a
  tab through the app's native
  path: go home, select its project, and click the matching catalog row (a
  time-based tiebreak disambiguates duplicate titles). The session button
  shows a small pulsing **attention dot** (same `--brand` color as the app's
  own tab unseen-dot) whenever any open session needs attention. It mirrors
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
- **700px (phones)**: the **model picker becomes a full-screen scrollable
  sheet** (`inset: 0`, `max-height: 100dvh !important` to beat the app's
  inline trigger-position max-height), with a JS-injected close button
  (`src/mobile-ui.js` observes the menu, adds a fixed X, and closes it via
  Escape keydown; the app natively closes the menu on outside mousedown, so
  the button lives in `<body>` and works without touching the menu's own
  logic). The composer's **context chips row** (agent / model / effort /
  workspace selectors) is hidden and replaced by a **floating button** just
  above the composer; tapping it pops the chips up as a floating card so the
  composer never over-extends on narrow screens. The button is a **chevron**
  that rotates smoothly (up when closed, down when open) while the card
  **slides up** into place and **slides down** out of it. Dismiss it with
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
  restore, and a send button that lights up when the message is ready.
  Each one clicks the app's own (hidden) button, so behaviors stay native.
  The **stop button also stays visible next to the textarea** while a turn
  is running (the app only renders it then, so it adds no idle clutter).
  Stopping a run stays one tap away even though the card lives in the
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
- **480px**: further tightening for small phones.

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
