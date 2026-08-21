# Pi Mode Tabs Implementation Plan

## Goal
Replace separate Pi workspace navigation with Pi mode using same tab strip, one active Pi RPC process, and seamless Freebuff/Pi mode switching.

## Phases

- [x] Phase 1: Trace existing tab/mode and Pi flows; record exact integration points.
- [x] Phase 2: Enforce one active Pi RPC process; add lifecycle regression tests.
- [x] Phase 3: Add Pi mode state and render Pi session tabs for active directory.
- [x] Phase 4: Move session switching/new/rename/delete into tab flow; remove sidebar primary navigation.
- [ ] Phase 5: Verify model/settings/auth/tool/history behavior and run full checks.

## Decisions

- Mode A approved: Freebuff mode shows Freebuff threads; Pi mode shows Pi sessions.
- One active Pi RPC process only; switch closes current child and resumes selected JSONL session.
- No fake Freebuff threads or Pi-to-Freebuff ID mapping.
- Preserve last selected Freebuff tab and Pi session per directory.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| `pi_too_many_sessions` | Verification probes left six Pi RPC children alive | Cleaned test processes; one-process policy prevents recurrence |

## Status

Current phase: Phase 5
