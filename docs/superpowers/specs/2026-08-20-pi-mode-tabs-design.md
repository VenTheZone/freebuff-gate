# Pi Mode Tabs Design

## Goal

Replace Pi's separate workspace/sidebar navigation with a project-level Pi mode. Freebuff mode continues showing Freebuff threads; Pi mode shows Pi sessions for active project directory in same tab strip.

## Architecture

### Mode switch

- Add Pi mode toggle beside existing Freebuff mode control.
- Freebuff mode keeps existing Freebuff thread tabs unchanged.
- Pi mode replaces tab contents with Pi sessions for active directory.
- Switching mode preserves last selected item in each mode.

### Pi process lifecycle

- Keep one live Pi RPC process only.
- Switching Pi sessions closes current RPC child cleanly, then opens selected session JSONL.
- Session files remain source of truth.
- This removes multi-process buildup and prevents `pi_too_many_sessions`.

### Tab identity

- Pi tabs use real Pi session IDs.
- Tabs display session name or title and active state.
- New tab creates Pi session.
- Rename and delete remain Pi-native operations.
- Do not create fake Freebuff thread records or maintain ID mappings.

### Directory behavior

- Pi mode defaults to saved directory, then active Freebuff project directory.
- Pi project picker lists connected directories and recent Pi sessions grouped by directory.
- Picker can launch existing Freebuff server-side folder browser for another directory.
- Selecting directory reloads Pi sessions for new `cwd`.
- Selecting recent Pi session changes directory and resumes that Pi JSONL session.
- Existing sessions for directory appear automatically.

## UI and data flow

### Mode control

- Add `Pi mode` toggle beside current Freebuff mode control.
- Active mode receives clear label and theme accent.
- Pi mode opens against saved or active project directory; user can change directory from Pi header.

### Pi tabs

- Reuse existing tab-strip styling.
- Each Pi session becomes a tab with name/title, active state, and close/delete affordance.
- `+` creates a new Pi session.
- Clicking Pi tab loads messages and reconnects SSE.
- Settings drawer remains available inside Pi mode.

### State

Persist:

- Current mode.
- Last Freebuff tab.
- Last Pi session per directory.

Reload restores mode and selected item. Do not open Pi sessions until selection requires it.

### Failure handling

- Show exact Pi open errors in tab/status area.
- `pi_too_many_sessions` should not occur under one-process policy.
- Missing session files remove stale tabs and show recovery status.
- Freebuff mode remains usable when Pi fails.

### Navigation cleanup

- Keep Pi session JSONL APIs.
- Reuse current Pi message renderer, model/settings drawer, delete, and rename logic.
- Remove Pi sidebar navigation as primary navigation after tab flow works.
- Tabs become source of truth.

## Backend changes

- Replace multi-session live cache behavior with one active RPC session.
- Close active child before opening another Pi session.
- Keep session files and credentials unchanged.
- Preserve messages, models, SSE, rename, delete, and auth routes.
- Return tab metadata: `id`, `name`, `title`, `updatedAt`, and `state`.

## Acceptance criteria

- Pi mode shows sessions for active directory.
- New Pi tab works repeatedly without `pi_too_many_sessions`.
- Switching Pi tabs resumes correct messages.
- Switching Freebuff/Pi mode preserves selected item in each mode.
- Reload restores mode and selected tab.
- Pi rename/delete updates tabs.
- Tool cards, model settings, and API-key login continue working.
- Existing Freebuff tabs continue working unchanged.

## Tests

- One-process replacement test.
- Mode and tab state test.
- Session switch/resume test.
- Existing bridge, proxy, and UI checks remain green.
