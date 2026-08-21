# Findings

- Pi UI currently lives in `src/mobile-ui.js` `piPanel()` as separate overlay with session sidebar.
- `activeThreadId()` reads active Freebuff `.tab` and `projectPath()` resolves project through `GET /api/projects`.
- Current Pi session flow: `refreshSessions()` → `/api/fb/pi/sessions`; `loadSession()` → `/api/fb/pi/session/open`; messages/models load; SSE connects.
- Current new Pi session calls `loadSession(null)` from sidebar and does not create a Freebuff thread.
- Freebuff tab UI uses `.tab`, `.tab-select`, `.tab-new`, `.tab-close`; existing thread opening uses `window.__fbOpenThread` or home catalog fallback.
- Pi session files are JSONL under `~/.pi/agent/sessions`; exact cwd filtering uses real paths.
- `MAX_SESSIONS = 6` in `src/pi-agent-bridge.js`; live sessions stored in `sessions` Map.
- Proxy handles Pi routes locally on `127.0.0.1:58061`; credentials stay local.
- `FB-Browser-UI` symlink resolves to `/home/admin/freebuff-gate`, so project matching by realpath is expected.
- Approved design: mode switch, Pi sessions in tab strip, one active process, no mapping layer.
- `createProxyServer()` constructs its own controller from `options.pi`; tests must pass controller seams (`spawnCommand`, `authSpawn`) rather than a fake `pi` object.
- Pi mode implementation uses `.fb-pi-mode-toggle`, `.fb-pi-mode-tab-wrap`, `.fb-pi-mode-new`, and `.fb-pi-mode-view`; native `.tab`, `.tab-new`, `.fb-session-switch`, and `.fb-new-session` are hidden while active.
- Pi mode overlay is positioned below native tabbar; Pi sidebar is hidden and chat fills mode view.
