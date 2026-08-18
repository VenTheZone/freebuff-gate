# Freebuff Gate Android

Native Android shell for Freebuff Gate mobile pairing.

## Current scope

- Scan pairing URL with CameraX + ML Kit QR detection.
- Generate device identity in Android Keystore.
- Encrypt device/session credentials with an Android Keystore AES-GCM key.
- Track `Unpaired`, `Pairing`, `Connecting`, `Connected`, `Reconnecting`,
  `Offline`, `Pairing required`, `Revoked`, and `Disconnected` states.
- Retry gateway refresh with exponential backoff and network callbacks.
- Use a dark Material 3 setup shell with theme-aware surfaces and readable primary/secondary text.
- Load only an HTTPS allowlisted Freebuff origin in WebView.
- Exercise real claim, refresh, Secure/HttpOnly cookie exchange, and WebView
  loading through an ephemeral HTTPS relay in CI.
- Block cleartext traffic, arbitrary navigation, unsafe file access, and SSL
  certificate bypasses.

## Build

Open `android/` in Android Studio with an Android SDK installed, or provide a
Gradle installation and run:

```bash
gradle :app:assembleWebviewDebug      # system WebView engine (default)
gradle :app:assembleGeckoDebug        # GeckoView / Firefox engine (spike)
```

A clean checkout needs Gradle and Android SDK. This workspace uses ignored
project-local tools under `.tools/`: Gradle 8.11.1, Android API 36, build-tools
36.0.0, platform-tools, emulator, and the Google APIs x86_64 system image. A
local debug build runs from the repository root with:

```bash
export ANDROID_HOME="$PWD/.tools/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$PWD/.tools/gradle-home"
.tools/gradle-8.11.1/bin/gradle -p android --no-daemon :app:assembleWebviewDebug
```

`.github/workflows/android.yml` runs
on Ubuntu with Java 17, Android API 36/build tools, and Gradle 8.11.1; it creates an
ephemeral HTTPS certificate, starts the local relay/desktop/upstream fixture,
configures both Gradle relay origins, boots an API 35 Google APIs x86_64 emulator,
and runs `connectedDebugAndroidTest`. The E2E test trusts only generated debug
certificate resource, so production trust settings remain strict. CI builds the
debug APK for the emulator run, verifies its signature with `apksigner`, and
uploads APK/test reports for 14 days. Before the debug APK is published to the
`mobile-debug-latest` release, a separate main-only job smoke-tests the generic
(unpinned) build on an API 35 emulator: it installs the exact artifact that
ships and runs `ReleaseArtifactSmokeInstrumentedTest` (activity boots, pairing
screen renders, WebView engine attached) plus the offline security tests
(origin guard, pairing payload rules, keystore identity). The full TLS pairing
+ gateway-UI-load E2E runs only against the pinned build in the `debug-apk`
job: the generic build cannot be TLS-tested on the API 35 emulator because its
trust store lives in the immutable conscrypt APEX, which rejects runtime CA
injection (verified empirically: correct hash name, SELinux label, and sha1 in
`/system/etc/security/cacerts` are ignored; the apex mount refuses remount). Android Studio can import
this project locally; do not commit local SDK paths. The same workflow also
runs Node 22 relay/agent integration tests and uploads TAP output.

Instrumentation coverage lives under `app/src/androidTest`:

- `PairingSecurityInstrumentedTest` checks QR fragment parsing, HTTPS rejection,
  stable Keystore identity, and encrypted session round-trip/clear.
- `RestrictedWebViewInstrumentedTest` checks exact-origin HTTPS navigation and
  blocks HTTP/subdomain navigation.
- `MobilePairingE2EInstrumentedTest` reads CI-only pairing data, drives the
  activity's claim flow, waits for the relay page title, and proves the
  authenticated WebView path works end to end. It skips when fixture asset is
  absent from local builds.

GitHub Actions boots API 35 emulator and runs:

```bash
gradle --no-daemon --stacktrace :app:connectedDebugAndroidTest
```

## Install the debug APK

The one-command installer does all of this for you (download, checksum
verify, uninstall the old build, install with permissions granted):

```bash
./install-release-apk.sh            # latest WebView build
./install-release-apk.sh --gecko    # GeckoView spike build
./install-release-apk.sh --apk /path/to/app.apk --skip-checksum
./install-release-apk.sh --serial <serial>   # pick a device
```

It needs `gh` (authenticated, with repo access), `adb`, and `sha256sum`.

Every push to `main` rebuilds the unpinned WebView debug APK and publishes it
as `freebuff-gate-debug.apk` on the `mobile-debug-latest` GitHub release, with
a SHA-256 checksum file (`freebuff-gate-debug.apk.sha256`) next to it. The APK
is generic: it pairs against the HTTPS origin carried by the QR, not the CI
relay. The repo is private, so downloads need repo access.

Download both files from the release page (or with
`gh release download mobile-debug-latest`), then verify the checksum before
installing:

```bash
sha256sum -c freebuff-gate-debug.apk.sha256
```

It must print `freebuff-gate-debug.apk: OK`. If it reports FAILED or the
checksum file is missing, do not install the APK: the download was truncated
or tampered with.

Install the verified APK with adb:

```bash
adb install freebuff-gate-debug.apk
```

or copy it to the phone and open it, allowing "install unknown apps" for your
file manager or browser when prompted. The debug APK is signed with the
per-machine debug key, so installing a new build over an old one requires
uninstalling the previous app first (`adb uninstall com.freebuff.mobile` or
Settings → Apps → Freebuff Gate → Uninstall).

## Pairing contract

The app expects the terminal URL fragment format emitted by the gateway:

```text
https://mobile.example/pair#pairingId=<id>&token=<one-use-token>
```

It posts to the URL origin:

- `POST /v1/pairings/claim`
- `POST /v1/sessions/refresh`

Claim request includes `pairingId`, `token`, `deviceName`, and Keystore
public-key encoding; the QR token alone is the pairing secret, so keep the
pairing URL private. Refresh uses encrypted `deviceId` and `deviceToken`
storage. QR token and access token never enter Android logs.

The managed relay now exposes the data-plane contract: desktop outbound WSS,
HTTP/SSE forwarding, browser WebSocket forwarding, and
`GET /v1/mobile/session`. Start relay and desktop connector with
`src/mobile-connect-relay.js` and `src/mobile-connect-agent.js`; production
needs a real public HTTPS/WSS origin and connector enrollment token. The app
uses the short-lived access token only for that native request, installs
returned `Secure; HttpOnly; SameSite=Strict` cookie into WebView CookieManager,
then loads same-origin UI without an Authorization URL header.

## GeckoView spike (Firefox engine)

The app has two product flavors that share the same activity, pairing flow, and
origin guard, differing only in the rendering engine behind `GateBrowserEngine`:

- `webview` — system Chromium WebView (`WebViewGateEngine`).
- `gecko` — GeckoView, the Firefox engine (`GeckoGateEngine` +
  `RestrictedGeckoNavigationDelegate`), pinned to GeckoView
  `153.0.20260810162159`, the current stable engine at release review time.

The origin restriction is identical: only HTTPS navigations whose exact origin
matches the paired relay are allowed, top-level and subframe loads alike, and
new windows are refused. The session cookie is installed differently —
GeckoView has no `CookieManager.setCookie` equivalent, so the spike attaches
the relay cookie to the initial top-level load as a `Cookie` request header
(`HEADER_FILTER_UNRESTRICTED_UNSAFE`). This is the main known gap until a
Gecko cookie API ships or the session is established inside Gecko itself.

Spike findings:

- WebView debug APK: ~29 MB.
- GeckoView debug APK: ~326 MB (even with arm64-v8a + armeabi-v7a only;
  `libxul.so` is ~150 MB per ABI). Engine updates and security patches must be
  shipped with the app, unlike WebView which updates through Play.

## WebView boundary

The app loads `uiUrl` when it is HTTPS and non-local. CI and production builds
can pin pairing/UI origins with `-PfreebuffPairingOrigin` and
`-PfreebuffWebOrigin`. Generic debug builds leave those properties empty and
bind to the exact HTTPS origin carried by the QR; the claim response must use
that same relay origin before WebView navigation is allowed. Before navigation
it calls `GET /v1/mobile/session` over native HTTPS, installs the returned
`Secure; HttpOnly; SameSite=Strict` cookie into WebView CookieManager, and
never exposes the access token to page JavaScript or URL headers. The WebView
has no JavaScript bridge. Redirects and navigations outside the exact initial
origin are blocked.

Do not add provider credentials, permanent relay tokens, Tailscale auth keys, or
local IP addresses to Gradle files, resources, or QR payloads. CI-only pairing
assets and certificate resources are generated, git-ignored, and removed after
tests.
