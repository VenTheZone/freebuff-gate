# Findings: Freebuff Mobile Connect

## Repository inspection

- Repository is `FB-Browser-UI`, a browser-port configuration and injected mobile layer.
- Root contains `.fb-browser-ui.json`, `.env.example`, `README.md`, `AGENTS.md`, and `src/` helpers.
- No Android project, package manifest, relay service, or test runner was present before this scaffold.
- Environment has Java 21 but no `gradle` or `adb`; Android build verification requires Android Studio/SDK or CI.
- CI workflow uses Java 17, Gradle 8.9, Android API 35, build-tools 35.0.0, and AGP's generated debug keystore; no signing secret is stored in GitHub.
- Instrumentation plan uses AndroidX Test/JUnit4 and `reactivecircus/android-emulator-runner@v2` with API 35 Google APIs x86_64 emulator. Local environment cannot run it because no SDK/adb is installed.
- Emulator runner supports `working-directory`, `api-level`, `target`, `arch`, `profile`, `emulator-options`, and `script`; it installs the emulator/system image and waits for boot. Source: https://github.com/ReactiveCircus/android-emulator-runner.
- Existing mobile layer is injected by the tailnet proxy and already handles responsive UI, mobile menus, streaming status, and reload behavior.
- `.fb-browser-ui.json` names runtime auth through an environment variable; secrets and runtime state are intentionally excluded from Git.
- Current branch was clean at plan start and tracks `origin/main`.
- Installed Freebuff package (`0.0.124`) is a launcher around a downloaded native binary; this checkout cannot safely add native CLI subcommands without an upstream/plugin boundary.
- Node 22 provides `fetch` and client `WebSocket`, but this repository has no WebSocket server dependency. Relay implementation will use Node core HTTP upgrade/framing to avoid adding an unverified dependency; Node 22 is required for the desktop agent's built-in WebSocket client until a supported runtime dependency is selected.

## Product requirement

- Non-technical users should not need to know Tailscale, tailnets, IPv6, port forwarding, or firewall configuration.
- Pairing should begin in the terminal and finish by scanning a QR code or entering a short code.
- Ordinary disconnects should reconnect automatically; revoke, explicit disconnect, expired pairing, or cleared app data should require pairing again.

## Transport research

- Tailscale Serve provides private HTTPS access inside a tailnet. Useful as an advanced/private mode, but it imposes VPN/account setup that should be hidden from normal users.
- Tailscale Funnel provides public exposure, but public reachability still needs application authentication and careful exposure controls.
- Cloudflare Tunnel uses outbound connections and avoids inbound port forwarding. It is a possible relay transport, but selected product architecture is a managed Freebuff relay with a custom pairing gateway for seamless device authentication.
- WSS means WebSocket over TLS. It encrypts traffic until the TLS termination point and authenticates the relay certificate. If relay terminates WSS, relay operators can read payloads.
- End-to-end relay confidentiality requires an inner authenticated encrypted channel or transparent byte-forwarding relay. Do not invent cryptography; use TLS 1.3 or an audited protocol/library.
- WebRTC still needs signaling, STUN, and TURN fallback. Raw IPv6 is not a reliable security or connectivity strategy for the first version.

## Android security research

- Android WebView should use HTTPS, restrict navigation to an allowlisted origin, avoid unsafe native JavaScript bridges, and disallow cleartext traffic.
- Android Keystore is appropriate for device identity/private-key storage. Scaffold uses an EC signing key plus AES-GCM Keystore key for encrypted session storage.
- ML Kit barcode scanning is selected for QR capture; CameraX supplies the preview/analyzer surface.
- ML Kit barcode scanning can support QR pairing.

## Sources

- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/features/tailscale-funnel
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges
- https://developer.android.com/develop/ui/views/layout/webapps/webview
- https://developer.android.com/privacy-and-security/keystore
- https://developers.google.com/ml-kit/vision/barcode-scanning/android
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols

## Security conclusions

- QR data must contain only a short-lived, one-use bootstrap token. Never put provider credentials, permanent access tokens, or Tailscale auth keys in QR data or APK files.
- Pairing token should be stored server-side as a hash, expire quickly, be rate-limited, and be invalidated after use.
- Device identity should be bound to an Android Keystore public key and a protected desktop credential.
- Relay logs must redact tokens and avoid query-string secrets. Use a fragment or POST exchange for bootstrap data.
- First gateway slice issues and consumes one-time pairing credentials, mints refresh/access credentials, lists/revokes devices, and exposes a relay/UI contract.
- Managed relay slice will terminate public WSS, authenticate desktop connector with enrollment token, authenticate mobile through short-lived access token, set an HttpOnly session cookie, and forward HTTP/SSE/WebSocket frames to local desktop UI.
- Relay termination means relay operator can see proxied payloads; this is transport security, not end-to-end chat encryption.
- Terminal now renders pairing URL payload as ANSI QR plus manual code; `--no-qr` preserves URL-only output.
- `qrencode` and qrcode packages are unavailable in this checkout. Renderer vendors a small dependency-free JavaScript port of Project Nayuki's MIT-licensed QR algorithm, retaining attribution/license and limiting versions to the URL-sized payload range.
- Source reference: https://github.com/nayuki/QR-Code-generator and https://github.com/nayuki/QR-Code-generator/blob/master/typescript-javascript/qrcodegen.ts.
- Relay prototype now exposes `/v1/mobile/session`: access bearer is consumed natively, relay mints an opaque short-lived `__Host-freebuff_session` cookie, and WebView sends that cookie on proxied HTTP/SSE/WebSocket requests.
- Desktop agent uses Node's built-in WebSocket client, reconnects with jittered backoff, forwards streamed HTTP bodies, and bridges WebSocket frames to local upstream UI.
- Transport/session state should distinguish Connected, Reconnecting, Desktop offline, Relay unavailable, Pairing expired, and Explicitly disconnected.

## Android relay E2E design

- CI runs relay and desktop agent on GitHub-hosted runner ports `18495`/`18496`; emulator reaches runner loopback through Android's `10.0.2.2` mapping.
- Relay now accepts optional Node TLS server options while retaining HTTP mode for local development and existing tests.
- CI generates one-day self-signed certificate with SANs for `10.0.2.2`, `127.0.0.1`, and `localhost`; only debug Android resource overlay trusts that certificate. Release/main network policy remains system trust plus no cleartext.
- Desktop agent connects to local `https://127.0.0.1`/`wss://127.0.0.1`; pairing metadata advertises emulator-facing `https://10.0.2.2`/`wss://10.0.2.2` URLs.
- `src/mobile-connect-e2e-fixture.js` starts upstream HTML, HTTPS relay, outbound agent, and one-use pairing. It writes pairing URL/code only to `RUNNER_TEMP`, never logs them, and removes fixture state/pairing on shutdown.
- Android `MobilePairingE2EInstrumentedTest` drives activity fields instead of camera hardware, claims pairing, waits for `Freebuff E2E Ready` WebView title, and therefore covers real HTTPS claim, Keystore public-key submission, access refresh, relay cookie exchange, and proxied UI load.
- Gradle properties `freebuffPairingOrigin` and `freebuffWebOrigin` configure debug/release constants; `MainActivity` now enforces both origins instead of bypassing checks in debug builds.
- CI deletes generated pairing assets and certificate resources after emulator execution; test APK is built for instrumentation but not uploaded.

## Desktop installer design

- Installed Freebuff package is a launcher around a downloaded compiled native binary; repository cannot safely patch native CLI commands or assume an upstream plugin boundary.
- Release packaging must stay separate from the companion installer: a small Unix bootstrap validates Node before downloading a version-pinned set of JavaScript files, then invokes the same cross-platform Node installer with a temporary source directory.
- Release assets use a tag-safe version such as `v0.1.0` in both the release URL and filenames. A JSON manifest declares version, required Node major, and logical files; a SHA-256 sidecar covers the manifest and downloaded files before any installer code runs.
- Bootstrap defaults to the repository's GitHub release path but accepts an explicit version and release base URL for mirrors/private deployments. It forwards only installer options and never prints enrollment tokens.
- Package command produces a directory plus optional tarball containing the bootstrap script, versioned files, manifest, and checksum sidecar. It copies only a fixed allowlist, so relay state, credentials, `.env` files, and Android outputs are excluded.
- Node validation accepts Node 22 or newer because the agent uses the built-in WebSocket client introduced for this runtime family; older Node exits before network downloads.
- Installer therefore provisions companion `freebuff-mobile-connect` process rather than modifying Desktop binary. Agent copies only `mobile-connect-agent.js`, `mobile-connect-protocol.js`, and `mobile-connect-qr.js` into user-owned data directory.
- Unix defaults: `~/.local/share/freebuff/mobile-connect`, `~/.config/freebuff/mobile-connect-desktop.json`, `~/.local/bin/freebuff-mobile-connect`. Windows defaults use `%LOCALAPPDATA%\\Freebuff` and a `.cmd` launcher.
- Installer provisions through `POST /v1/relay/enroll` with relay bootstrap token, then stores issued 15-minute connector token and 90-day refresh token in a protected local credential file. Relay persists only hashes; agent rotates connector token through `POST /v1/relay/refresh`. Bootstrap token must be rotated by relay operator after provisioning.
- Installer refuses non-loopback plaintext relay URLs, refuses unmanaged destination collisions, supports `--dry-run`, and preserves config/state/credential on ordinary uninstall. `--purge` explicitly removes all three.
- Node 22 remains required because installed agent uses built-in WebSocket; bootstrap validates Node 22 or newer before network downloads, installer does not install Node or elevate privileges. Native Desktop integration remains pending supported Freebuff CLI/plugin boundary.
- Release packaging and bootstrap checks passed locally on Node `v22.23.1`; no GitHub release was published during implementation. A tagged release must upload generated assets before the documented one-command URL works.
- Relay enrollment bootstrap token must be protected server-side and used over public HTTPS; it is not persisted in Desktop config or credential file.

## Mobile todo dock design

- Native orchestrator renders agent tasks as `.thread-bottom .todo-dock`; its default CSS keeps it in the bottom flow immediately above the composer.
- Native todo markup is a collapsible `.todo-dock-header` plus scrollable `.todo-dock-list`; no source or React changes are needed for relocation.
- Mobile model/reasoning/time controls are injected above `.composer`, so the native bottom-flow todo dock competes for the same small vertical area and can be hidden behind those pills.
- Mobile override uses `position: fixed` below `--fb-mobile-header-height`, full available width with 8px gutters, bounded card/list height, safe-area-aware header offset, and a higher overlay layer than transcript content. Desktop remains untouched.
- Todo dock is not registered as a dismissible overlay: its native header remains interactive, and only intentionally opened context/menu sheets can cover it temporarily.

## Mobile floating-card collision design

- Top mobile layers use fixed/absolute coordinates: task card below header, session/thread menus at header, context card below header, model picker full-screen, and composer model/reasoning/time pills above composer.
- Unified overlay manager closes most mutually exclusive top layers, but persistent task card remains mounted; z-index alone prevents menus from being covered but does not prevent visual overlap.
- Collision manager measures visible top blockers and sets root CSS variables for task-card top/max height. Task card remains lower priority; menus/context stay anchored to header and stack above it.
- Composer and pill bounds define task-card bottom boundary. This prevents expanded task rows from reaching into model/reasoning/time controls or textarea.
- Recalculation uses shared body sync plus `ResizeObserver`, `resize`, and `orientationchange`; transcript mutations remain ignored by shared observer.

## Desktop auto-start design

- Auto-start stays opt-in; ordinary installs and upgrades must not create login/startup registrations. `--auto-start` enables and starts the companion, while `--no-auto-start` removes an existing registration and stops it.
- Linux uses a per-user systemd unit under `~/.config/systemd/user/`, with `Restart=on-failure`, `RestartSec=5`, network-online ordering, and no root/system service. `systemctl --user` is required only when the flag is requested or an existing registration is removed. It starts at user-session login; installer does not enable systemd linger or boot-time service execution.
- macOS uses a per-user `~/Library/LaunchAgents/com.freebuff.mobile-connect.plist` with `RunAtLoad` and `KeepAlive`; `launchctl bootstrap`/`bootout` targets the current GUI user and never uses sudo.
- Windows uses a per-user `Freebuff Mobile Connect` Task Scheduler task triggered `ONLOGON` at `LIMITED` run level. `schtasks.exe` is used only when requested; no administrator elevation or service account is needed.
- Generated service definitions execute the managed Node wrapper directly, so config/credential paths remain centralized and auto-start uses the same refresh/reconnect behavior as manual `serve`.
- Installer config records auto-start state; managed manifest records platform registration metadata so uninstall can remove only its own registration. Auto-start command failures must leave normal file installation intact only when user did not request auto-start; explicit `--auto-start` reports actionable failure.

## Mobile screenshot regression design

- Repository has no browser-test dependency or package manifest, so screenshot coverage uses Node 22's built-in WebSocket client against a locally launched headless Chromium DevTools Protocol endpoint.
- `src/mobile-ui-screenshot-fixture.html` supplies deterministic native selectors (`.tabbar`, `.composer`, `.todo-dock`, native model/effort/quota controls) and loads the real `mobile-ui.css`/`mobile-ui.js`; test does not duplicate mobile implementation rules.
- Regression viewport is 390×844 with touch emulation. Test captures `mobile-ui-header-composer-task.png`, checks PNG dimensions/content, and asserts slim-header height, three visible composer pills, task-card separation from header and pills, and task-card width.
- Test widens the same page to 1280×800 and asserts injected controls hide while native task dock position is no longer `fixed`, protecting desktop behavior.
- CI installs stable Chrome through `browser-actions/setup-chrome`, runs the same Node test, and uploads screenshot artifact for visual review. Local runs skip only when Chrome is absent; CI fails when browser discovery fails.

## Mobile session-close confirmation design

- Mobile session close has two injected entry points: per-row `.fb-session-menu-close` and title-menu `Close`; both delay the app's native `.tab-close` click until confirmation.
- Confirmation is a centered, safe-area-aware dialog registered as child overlay `session-close-confirm`; parent session menu/thread menu stays available behind it, so No cancels without losing menu context and Android/browser Back or Escape also cancels.
- Yes is explicit destructive red (`#d83c52`); No is explicit safe green (`#2eaa62`). Dialog uses `role=dialog`, `aria-modal`, labelled heading/copy, focus return, backdrop cancellation, and touch-sized buttons.
- Synthetic native close clicks suppress the injected title-menu capture handler, preventing a confirmed close from reopening the thread menu. Native app close behavior remains authoritative.
- Screenshot interaction coverage captures the confirmation state and exercises Escape, `history.back()` browser Back, backdrop click, No, and Yes; each cancellation verifies parent menu retention and focus returns to `.fb-session-menu-close`.
- Confirmation includes visible `.fb-session-close-announcement` status text with `role="status"`, `aria-live="assertive"`, and `aria-atomic="true"`; browser test verifies text, semantics, and non-zero layout bounds.
- Shared `.fb-mobile-live-region` announces `Selected session: “…”`, `Session “…” kept open.`, and `Session “…” closed.` or failure. It stays mounted, clears before repeat announcements, and uses polite live delivery for navigation/outcomes.

## Screen-reader validation

- Real TalkBack cannot run in current workspace: project-local `adb` sees no connected device, no AVD is configured, and host has no `/dev/kvm`; prior software-emulator boot timed out. Do not repeat same emulator attempt.
- Real VoiceOver cannot run on this Linux host: `xcrun`, `simctl`, and macOS accessibility runtime are unavailable.
- Fallback uses Chrome DevTools `Accessibility.getFullAXTree` in screenshot regression. It verifies status-role nodes and text for selected session, confirmation, kept-open cancellation, and closed outcome. This validates browser accessibility tree semantics, not spoken TalkBack/VoiceOver output.
