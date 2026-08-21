# Progress Log

## 2026-08-20

- Design approved and committed as `53a7989`.
- Implementation plan initialized.
- Backend/provider catalog and proxy deployment verified before this feature.
- Phase 1 complete: mapped `.tabbar`, `.tab`, `.tab-select`, `.tab-new`, `.tab-close`, `activeThreadId()`, `projectPath()`, existing Pi overlay flow, and proxy routes.
- Phase 2 complete: opening a different Pi session closes prior live RPC child; added regression test.
- Phase 3 complete: added persisted Pi mode toggle, Pi tab rendering, project-based session loading, and overlay-under-tabbar layout.
- Phase 4 complete: Pi tabs handle new/select/delete; native Freebuff tabs are hidden only in Pi mode; sidebar is hidden in Pi mode.
- Phase 5: added Pi directory picker with connected projects, recent Pi sessions grouped by directory, and existing server-side folder browser fallback.
- Picker selection persists `fb-pi-project`, reloads cwd-scoped Pi sessions, and resumes selected recent Pi session.
- Bridge cleanup now uses SIGKILL on replacement/failure paths so one-process policy cannot leave hung RPC children.
- Exposed Pi `History`, `New`, `Commands`, and `Settings` controls inside Pi mode; slash palette maps settings/model/login/session/new/compact/copy and lists native Pi commands.
- Pi mode history drawer now opens over chat; Pi deletion uses existing accessible Yes/No destructive confirmation instead of inline Confirm text.
- Slash commands now autocomplete from composer `/`, support arrow/Enter selection, and route `/login`, `/settings`, `/model(s)`, `/scoped-models`, `/session`, `/resume`, `/new`, `/compact`, and `/copy` to web actions.
- Pi mode no longer auto-opens newest/default session on directory entry; user must choose History session or New, preventing wrong-session loads.
- Simplified Pi mobile header to `Sessions` + `Settings` + close; New/delete remain inside Sessions drawer; slash commands moved inside Settings.
- Replaced Pi settings native selects with compact custom menus and bounded desktop session drawer; forced Pi chat flex visibility so session drawer cannot consume chat.
- Hidden Freebuff `Report an issue` control while Pi mode is active.
- Pi session API now returns canonical real directory; UI persists and displays canonical `cwd`, preventing symlink/stale-directory session mixups. Project picker now selects directories only; Sessions handles session resume/delete/new.
- Pi mode now follows active Freebuff project by default; only an explicit Pi picker choice pins `fb-pi-project`. Old stale saved directories no longer override active Freebuff selection.
- Reworked Pi navigation into separate Pi home + Home/session tabs; Pi home now uses compact Freebuff-like one-row session list with ellipsis-safe titles and explicit directory/new-session actions.
- Renamed mode control to `Pi` and home tab to `Home` to remove duplicate `Pi mode`/`Pi home` clutter.
