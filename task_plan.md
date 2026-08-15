# Freebuff Mobile Connect Plan

Status: implementation in progress

## Goal

Let non-technical users open Freebuff on Android from any network by scanning a terminal QR code. Hide Tailscale, IPv6, port forwarding, and tunnel details. Reconnect automatically after ordinary network or process interruptions.

## Scope boundary

This checkout contains browser UI injection, proxy-facing configuration, and initial Android scaffold. It does not contain Freebuff Desktop's native runtime or managed relay service. Keep implementation behind explicit local interfaces; do not patch installed binaries or embed credentials in the app.

## Architecture decision

Default transport: authenticated outbound WSS through a managed relay. Desktop connector and Android app both initiate outbound connections. Tailscale Serve remains optional private/developer transport, not a user-facing prerequisite.

Pairing uses a short-lived one-use QR token plus terminal confirmation. Normal reconnect uses a device identity stored in Android Keystore and protected desktop storage. Revocation or cleared app data requires pairing again.

## Phases

### Phase 1 — Protocol and security contract (complete)

- Define pairing, device approval, session, revoke, heartbeat, and reconnect states.
- Define relay framing and same-origin forwarding for UI, API, SSE, and WebSocket traffic.
- Define secret storage, expiry, rate limits, redacted logs, and manual disconnect semantics.
- Decision: use managed relay for default user flow; keep relay URL and relay credentials outside source control.

Planned files:

- `src/mobile-connect-protocol.js` — shared message/state contract. **Done.**
- `.env.example` — relay URL and non-secret configuration names only. **Done.**
- `README.md` — user-facing setup and threat model. **Done.**

### Phase 2 — Desktop connector and CLI (gateway + connector prototype complete; native CLI integration pending)

- Add `freebuff phone connect`, `devices`, `revoke`, and `disconnect` command surface at the actual Freebuff CLI integration boundary.
- Generate terminal QR/manual code without logging long-lived credentials. **Done with dependency-free ANSI QR renderer; `--no-qr` is available for piped output.**
- Maintain outbound WSS with TLS, heartbeat, exponential backoff, jitter, network-restored fast retry, and explicit stop state. **Prototype done in `src/mobile-connect-agent.js`; native CLI wiring pending.**
- Resume without duplicating prompts; relay request IDs and stream completion are covered. Freebuff-specific event cursor/resume semantics remain pending.

Planned files after runtime boundary is confirmed:

- `src/mobile-connect-agent.js` — managed relay data-plane connector. **Done as standalone Node 22 agent.**
- `src/mobile-connect-cli.js` — gateway CLI is currently in `src/mobile-connect-gateway.js`; native Freebuff CLI integration remains blocked by binary boundary.
- protected local device/session state outside Git

Implemented first slice:

- `src/mobile-connect-gateway.js` — pairing control plane, refresh, device list, and revoke.
- `src/mobile-connect-qr.js` — ANSI QR renderer adapted from MIT-licensed Project Nayuki.
- `src/mobile-connect-gateway.test.js` — protocol and HTTP tests. **Done: 4 tests.**

### Phase 3 — Managed relay data plane (prototype complete; deployment pending)

- Implement relay that maps opaque pairing/session IDs to one desktop connector.
- Support WSS upgrade, SSE without buffering, WebSocket forwarding, bounded connection lifetime, and reconnect. **Prototype done.**
- Keep relay auth separate from Freebuff provider credentials. **Done: connector enrollment token and device/session tokens are separate.**
- Add integration tests for desktop offline, phone offline, relay restart, expiry, and revoke. **Core forwarding tests done; failure/production deployment tests pending.**

Planned files or deployment surface:

- `src/mobile-connect-websocket.js` — dependency-free server-side WebSocket framing.
- `src/mobile-connect-relay.js` — managed relay HTTP/WSS forwarding and cookie exchange.
- `src/mobile-connect-agent.js` — desktop outbound connector and local upstream proxy client.
- Otherwise deploy these files as a separate relay/agent service with documented `FB_RELAY_URL` contract.

### Phase 4 — Android app (scaffold + cookie exchange complete; real CI E2E added; device validation pending)

- Create native Kotlin app with QR scanner, manual code fallback, pairing approval, connection state, and restricted WebView. **Scaffold done.**
- Store device key in Android Keystore. **Done.**
- Allow only configured HTTPS origin; block arbitrary navigation and cleartext traffic. **Done in scaffold.**
- Exchange access token for relay Secure/HttpOnly WebView cookie before navigation. **Done.**
- Drive real Android claim, refresh, cookie exchange, and authenticated WebView load through an ephemeral HTTPS relay in CI. **Implemented; remote run pending.**
- Reconnect on network callback and app resume; use foreground service only if background streaming/notifications require it. **Done without background service.**
- Provide disconnect, revoke, and re-pair states. **Done in UI/controller.**

Selected project:

- `android/` in this repository for initial scaffold. Move to dedicated repository later if release ownership requires it.

### Phase 5 — Validation and rollout (Android + relay CI configured; remote E2E run pending)

- Test same-origin UI, API, SSE, active streaming, reload, rotation, network changes, relay restart, and duplicate-submit prevention.
- Run Android instrumentation and real relay pairing E2E on API 35 emulator in GitHub Actions.
- Run Node 22 managed relay/agent integration suite in same workflow.
- Test QR expiry, replay, code mismatch, device revoke, app data clear, and desktop credential rotation.
- Run syntax/type checks and targeted protocol/relay tests. **Gateway/relay/agent/QR checks done; HTTPS relay support, Android E2E fixture, configured debug origins, and emulator test added.**
- Document normal user flow first; put Tailscale under advanced/private mode only. **Done.**

### Phase 6 — Desktop companion installer (implemented; native integration pending)

- Install managed copies of Node 22 agent dependencies without patching compiled Freebuff binaries. **Done.**
- Write non-secret relay/UI configuration and stable connector id under user config/data directories. **Done.**
- Create Unix and Windows launchers with dry-run, collision protection, uninstall, and optional purge. **Done.**
- Provision short-lived connector token plus refresh token; store only in protected local credential file and rotate through relay. **Done and tested.**
- Document companion-process boundary until native Freebuff CLI exposes supported plugin integration. **Done.**

### Phase 7 — Versioned one-command release artifact (complete; publication pending)

- Add a Node 22-validated Unix bootstrap installer suitable for `curl | bash`. **Done.**
- Download immutable, versioned agent/installer files from a release base URL and verify manifest plus SHA-256 checksums before execution. **Done.**
- Add a package command that emits release assets, manifest, checksums, optional archive, and version-pinned bootstrap script. **Done.**
- Add Node 22 CI packaging checks and document release publication plus one-command install. **Done.**
- Publish a real GitHub release/tag and configure managed relay production URLs. **Pending operator action.**

### Phase 8 — Optional Desktop auto-start (complete; host execution pending)

- Add opt-in `--auto-start` and explicit `--no-auto-start` installer controls; keep default install behavior unchanged. **Done.**
- Generate and manage a systemd user service on Linux, LaunchAgent plist on macOS, and Task Scheduler task on Windows. **Done.**
- Enable/start on request, disable/remove on request and uninstall, without administrator elevation. **Done.**
- Add platform-focused pure tests and document service lifecycle, paths, and limitations. **Done.**
- Execute registrations on real Linux/macOS/Windows hosts. **Pending host-specific validation.**

### Phase 9 — Android APK build (debug build complete; emulator test pending)

- Install project-local Gradle 8.9 and Android command-line SDK/API 35 toolchain. **Done; `.tools/` ignored.**
- Run debug APK, lint, and instrumentation APK compilation locally. **Done.**
- Run configured GitHub Actions Android emulator workflow after source publication. **Pending publication/dispatch.**
- Run local emulator instrumentation. **Blocked by missing KVM; software emulator timed out during boot/test run.**
- Verify APK artifact path and signature. **Done for debug APK.**

### Phase 10 — Mobile todo dock relocation (complete)

- Keep desktop `.todo-dock` behavior unchanged. **Done.**
- On narrow viewports, move native `.thread-bottom .todo-dock` into a fixed floating card below the safe-area header. **Done.**
- Keep task rows scrollable and touch-friendly so model/reasoning/time pills above the composer cannot cover them. **Done.**
- Validate injected CSS/JS and document remaining overlap behavior when other header overlays are intentionally open. **Done.**

### Phase 11 — Mobile floating-card collision layout (complete)

- Keep native and injected card actions unchanged. **Done.**
- Add one shared recalculation pass for task card, header menus, context card, model sheet, and composer pills. **Done.**
- Stack top cards below the safe-area header when simultaneous visibility would overlap; cap task-card height before composer/pills. **Done.**
- Recalculate after resize, rotation, React DOM changes, and card resize without watching transcript token mutations. **Done.**
- Validate desktop scoping, proxy injection, syntax, and existing test suite. **Done.**

### Phase 12 — Mobile screenshot regression coverage (complete)

- Add deterministic native-UI fixture that loads the actual injected mobile CSS/JS. **Done.**
- Capture a 390×844 Chromium screenshot and assert header, composer-pill, and task-card geometry. **Done.**
- Verify injected controls hide and native task positioning returns after widening to desktop. **Done.**
- Run locally without Playwright by using Node 22's WebSocket client and Chrome DevTools Protocol; upload CI PNG artifact. **Done.**

### Phase 13 — Mobile session-close confirmation (complete)

- Add confirmation popup before mobile session close actions. **Done.**
- Use red Yes and green No controls with safe-area, focus, Escape, Back, and backdrop cancellation. **Done.**
- Preserve parent session/thread menu on No and route Yes through native `.tab-close`. **Done.**
- Add browser interaction coverage for colors, visible live-region semantics, selected-session title, close outcomes, Escape, browser Back, backdrop cancellation, focus restoration, acceptance, and title-menu close. **Done.**

### Phase 14 — Screen-reader validation (fallback complete; device pass blocked)

- Check Android/iOS host access and available screen-reader runtimes. **Done: no Android device/AVD/KVM; no macOS VoiceOver tooling.**
- Avoid repeating known software-emulator failure. **Done.**
- Query Chrome DevTools accessibility tree for selection and close outcome status announcements. **Done.**
- Run spoken TalkBack and VoiceOver pass on real device or hardware-accelerated CI/macOS host. **Blocked by host/device availability.**

### Phase 15 — Mobile model session availability (complete)

- Read concurrent slot usage from native model-option badges instead of private state or guessed quotas. **Done.**
- Show per-model available session counts and a sticky grouped summary in the phone model sheet. **Done.**
- Preserve desktop picker behavior and provide an explicit unavailable state when native data is absent. **Done.**
- Cover counts, exhausted models, status semantics, and model-sheet screenshot in Chromium regression. **Done.**

### Phase 16 — GitHub screenshot validation (blocked pending publication)

- Inspect latest remote screenshot run and artifact state. **Done: run `31881849921` failed before capture; no artifact.**
- Harden Chrome setup path and startup wait for hosted runners. **Done locally.**
- Commit/push current model availability and CI fixes, dispatch workflow, and inspect uploaded model-picker PNG. **Pending user authorization to publish; remote dispatch `31883126075` used stale `7c3d251` and produced no artifact.**

### Phase 17 — Live model session-slot refresh (complete locally)

- Observe native model-slot badge changes while phone picker remains open. **Done.**
- Refresh counts without reacting to injected summary/count mutations. **Done.**
- Stop observer, fallback timer, and polling when picker closes. **Done.**
- Cover live ratio change, refreshed summary, detail tooltip, and accessibility tree in Chromium regression. **Done.**

### Phase 18 — Model quota reset labels (complete locally)

- Read reset metadata only from native option/context tooltips. **Done.**
- Show `Resets …` beside each model count and expose it to screen readers. **Done.**
- Show `Reset time unavailable` when native metadata is absent. **Done.**
- Cover per-model reset labels and live reset changes in Chromium regression. **Done.**

### Phase 19 — Model session-name clarity (complete locally)

- Keep model availability counts compact and non-alarming on phones. **Done: `N available`/`At capacity`; capacity is neutral, not red.**
- Resolve open session titles from same-origin thread catalog metadata when available. **Done; active visible composer session is also used as a safe fallback.**
- Show session names using each model beside its availability/reset details without guessing when native metadata is missing. **Done: `Used by: …` or `Session names unavailable`.**
- Refresh names while picker stays open and cover mapping, fallback, accessibility, and styling in Chromium regression. **Done: 24-test suite and 390×844 model-picker capture pass.**

### Phase 20 — Direct model-to-session switching (complete locally)

- Make each resolved `Used by: …` session name keyboard and touch activatable. **Done: focusable role-button controls.**
- Select matching open tab through native `.tab-select` without changing model accidentally. **Done: propagation blocked; disabled model rows use sibling controls.**
- Announce selected session, close model sheet safely, and cover pointer/keyboard activation in Chromium regression. **Done: active and exhausted-model holder tests pass.**

### Phase 21 — Session-switcher model legend (complete locally)

- Show compact model label beneath each open session in mobile switcher. **Done.**
- Use catalog/active-session metadata and current composer fallback; never infer model from slot tier. **Done.**
- Include model label for Recent rows when available and explicit fallback when unavailable. **Done.**
- Cover legend rendering and metadata refresh in Chromium regression without changing desktop tabs. **Done: active, exhausted, and Recent rows covered.**

### Phase 22 — Live session status legend (complete locally)

- Resolve each session's running/stopped state from native catalog state and live tab/composer state without guessing model or quota data. **Done.**
- Show compact status beside model labels for open and Recent mobile session rows, with accessible labels and neutral stopped styling. **Done.**
- Refresh status while the switcher stays open and react to native tab state changes without disrupting focus or selection. **Done: one-second menu-scoped polling plus tabbar observer.**
- Cover initial status, live running-to-stopped change, Recent status, accessibility semantics, and desktop scoping in Chromium regression. **Done.**

### Phase 23 — Mobile session model filter (complete locally)

- Add accessible `All models`/model select control to mobile session switcher without changing desktop tabs. **Done.**
- Filter open and Recent rows by resolved visible model label, including explicit `Model unavailable` fallback. **Done.**
- Keep filter selection stable while catalog/model/status data refreshes and show a clear no-match state. **Done: option DOM is preserved when labels do not change.**
- Cover model selection, row visibility, Recent filtering, accessibility, reset to All models, and desktop scoping in Chromium regression. **Done.**

### Phase 24 — Android test publication (published; E2E follow-up pending)

- Make generic debug APKs usable with a QR-provided HTTPS relay while retaining pinned-origin CI/production builds. **Done.**
- Fix Android emulator workflow command folding and always upload verified debug APK after test failure. **Done.**
- Push release changes, rerun Android CI, and inspect APK/instrumentation artifacts. **Done: run `31885659309` built and signature-verified APK; relay integration passed.**
- Publish clearly labeled pre-release APK; production relay and release signing remain separate. **Done: `mobile-v0.1.0-test`; real relay WebView-load test remains follow-up.**

### Phase 25 — Android dark theme polish (published test release)

- Replace hardcoded white/black setup-screen colors with theme-aware surfaces and text. **Done.**
- Make Android shell dark by default so pairing UI is comfortable in low-light use. **Done.**
- Build and lint debug APK; publish updated APK after user approval. **Done: published `mobile-v0.1.1-dark-theme-test`; production relay/signing remain separate.**

### Phase 26 — Freebuff Gate live-test preparation (in progress)

- Rename Android app display label to `Freebuff Gate` without changing package identity. **Done locally.**
- Preserve device refresh token and immutable device expiry when gateway refresh response omits both fields; add instrumentation regression coverage. **Done locally.**
- Build/lint debug APK and instrumentation APK. **Done locally.**
- Commit/push source and publish clearly named Freebuff Gate test APK. **Done: `13aad49`, `mobile-v0.1.2-freebuff-gate-test`.**
- Rerun Android CI after refresh fix and inspect emulator result. **In progress: run `31890651787` exposed omitted `deviceExpiresAt`; client now preserves both immutable fields and CI fixture uses 600 seconds, rerun pending.**
- Deploy public staging HTTPS/WSS relay and run real phone claim/reconnect/revoke test. **Blocked: no staging host, domain, or deployment credentials are present in checkout.**

## Acceptance criteria

- New user needs only `freebuff phone connect` and QR scan.
- No Tailscale, IPv6, port-forwarding, or firewall knowledge required.
- Ordinary disconnect reconnects without another QR scan.
- Reconnect never resubmits a prompt or duplicates a thread event.
- Revoked or expired pairing cannot reconnect.
- Relay cannot receive Freebuff provider credentials.
- Desktop and Android can report clear offline/reconnecting states.

## Open decisions

1. Managed relay deployment URL and connector enrollment token still need to be provided for production; local relay prototype defines contract.
2. Is relay trust acceptable, or is end-to-end encryption required for chat payloads?
3. Does Freebuff native runtime expose a supported connector/plugin boundary?
4. Should Android background streaming require notifications/foreground service?
5. Android scaffold lives in this repository for now; release/repository split remains optional.

## Errors Encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| `Error: Unknown command: --help` | First CLI smoke check | Normalize top-level `--help`/`-h` to help command before parsing options. |
| `SyntaxError: Invalid or unexpected token` | Passed shell bootstrap to `node` instead of `bash` during validation | Validate JavaScript with `node --check` and shell with `bash -n`; bootstrap help and tests then passed. |
| Workflow content check assertion | First local YAML check looked for literal `apksigner verify` | Check actual quoted command for `verify --verbose --print-certs`; workflow passed. |
| Relay test timeout before first SSE chunk | Headers stayed buffered while test awaited response | Flush relay response headers immediately after `writeHead`. |
| `Error: FB_MOBILE_RELAY_CONNECTOR_TOKEN is required` on agent `--help` | Top-level help parsed as command | Normalize agent top-level `--help`/`-h` before option parsing. |
| `HTTP 404: Not Found ... /actions/workflows/android.yml` | Attempted GitHub Actions dispatch before workflow reached origin; workflow file is untracked locally | Do not commit or push implicitly; workflow dispatch remains blocked until user authorizes publishing current changes. |
| `bash: .../android/.tools/gradle-8.9/bin/gradle: No such file or directory` | First build used project-root tool path while cwd was `android/` | Resolve root with `ROOT=\"$(cd .. && pwd)\"`; corrected build passed. |
| `UnsafeOptInUsageError` from `ImageProxy.image` | New Android lint treated CameraX image access as error | Suppress opt-in at actual `analyze()` call site; lint then exposed manifest feature issue. |
| `PermissionImpliesUnsupportedChromeOsHardware` for camera | Manifest declared camera permission without optional camera feature | Added `android.hardware.camera` with `required=\"false\"`; lint passed. |
| Emulator boot/test command timed out after 600 seconds | Host has no `/dev/kvm`; x86_64 software emulation did not complete boot/test run | Keep emulator validation in hardware-accelerated CI; APK and instrumentation APK compilation succeeded locally. |
| `ReferenceError: Cannot determine intended module format because both require() and top-level await are present.` | First local HTTPS fixture smoke check used CommonJS `require()` with top-level `await` | Wrapped validation in an async IIFE and reran successfully. |
| Installer summary printed `Add undefined to PATH` | Summary path object omitted `binDir` | Include `binDir` in installer result paths; installer tests pass. |
| Auto-start unit path removed `r`/`n` characters | Over-escaped CR/LF regex in systemd path sanitizer | Use actual `\\r`/`\\n` regex escapes; platform definitions and lifecycle tests pass. |
| Secret scan matched `sk-scheduler` | Broad `sk-` pattern treated auto-start type name as credential | Re-run with token-length pattern; refined secret scan passed. |
| Collision static assertion failed | CSS formatter split `var(--fb-mobile-todo-top, ...)` across lines | Assert variable declaration markers instead of single-line formatting; code and tests remained valid. |
| `str_replace` old string not found | First screenshot findings append used stale exact tail text | Re-read current findings tail and append against the exact line; no code impact. |
| Session-menu screenshot test timed out | Fixture retained hidden `.agent-menu`, so model-sheet observer repeatedly displaced session menu | Removed hidden native menu from deterministic fixture; real picker remains covered by app-created visible menu. |
| Screenshot color assertion failed | Test regex was over-escaped and parsed no RGB channels | Corrected digit regex; red/green assertions pass. |
| Screenshot test edit matched duplicate close sequence | First confirmation-flow replacement used a short repeated block | Replaced longer context-specific block; syntax and interaction test pass. |
| `find /tmp` reported `Permission denied` | Artifact discovery traversed system-private temporary directories | Verified exact test output directory directly; both 390×844 PNGs exist. |
| Real screen-reader runtime unavailable | Linux host has no ADB device/AVD/KVM and no macOS VoiceOver tooling | Ran Chrome CDP accessibility-tree fallback; documented spoken TalkBack/VoiceOver as device-host validation. |
| `Chrome DevTools page target unavailable` in GitHub run `31881849921` | `browser-actions/setup-chrome` binary path was not passed explicitly and original launch wait was 5 seconds | Pass `steps.setup-chrome.outputs.chrome-path` as `FB_CHROME_BIN` and wait up to 15 seconds; rerun after current changes are published. |
| `Chrome DevTools page target unavailable` in GitHub run `31883126075` | Manual dispatch ran remote `main` at stale `7c3d251`; remote workflow lacked local Chrome-path hardening and failed before capture | Publish current workflow/source changes, then dispatch again; no remote artifact exists. |
| `HTTP 422: No ref found for: 5dd5e80` | GitHub Actions dispatch received short commit SHA as ref | Dispatch against `main`, which currently points to pushed commit `5dd5e80`. |
| `Release.target_commitish is invalid` | First GitHub release attempt used short commit target `b461b24` | Recreated release against full commit SHA; asset upload succeeded. |
| `java.lang.AssertionError: Android app did not load relay UI` | GitHub run `31885659309` reached all six instrumentation tests but Android refresh failed because response omitted raw device token | Preserve stored device token in `PairingApi.refresh`; add instrumentation regression and rerun CI. |
| `android:windowLightNavigationBar requires API level 27` | First dark-theme lint run added API 27 navigation attribute to `values/` with minSdk 26 | Remove optional navigation attribute; dark theme lint/build then passed. |
| `Task '\\' not found in root project 'FreebuffMobile' and its subprojects.` | Android emulator action received multiline Gradle continuation characters as a literal task | Fold emulator script into one shell command; make APK verification/upload run with `if: always()`. |
