# Freebuff Mobile Android

Native Android shell for Freebuff mobile pairing.

## Current scope

- Scan pairing URL with CameraX + ML Kit QR detection.
- Accept six-digit terminal confirmation code.
- Generate device identity in Android Keystore.
- Encrypt device/session credentials with an Android Keystore AES-GCM key.
- Track `Unpaired`, `Pairing`, `Connecting`, `Connected`, `Reconnecting`,
  `Offline`, `Pairing required`, `Revoked`, and `Disconnected` states.
- Retry gateway refresh with exponential backoff and network callbacks.
- Load only an HTTPS allowlisted Freebuff origin in WebView.
- Exercise real claim, refresh, Secure/HttpOnly cookie exchange, and WebView
  loading through an ephemeral HTTPS relay in CI.
- Block cleartext traffic, arbitrary navigation, unsafe file access, and SSL
  certificate bypasses.

## Build

Open `android/` in Android Studio with an Android SDK installed, or provide a
Gradle installation and run:

```bash
gradle :app:assembleDebug
```

A clean checkout needs Gradle and Android SDK. This workspace uses ignored
project-local tools under `.tools/`: Gradle 8.9, Android API 35, build-tools
35.0.0, platform-tools, emulator, and the Google APIs x86_64 system image. A
local debug build runs from the repository root with:

```bash
export ANDROID_HOME="$PWD/.tools/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$PWD/.tools/gradle-home"
.tools/gradle-8.9/bin/gradle -p android --no-daemon :app:assembleDebug
```

`.github/workflows/android.yml` runs
on Ubuntu with Java 17, Android API 35/build tools, and Gradle 8.9; it creates an
ephemeral HTTPS certificate, starts the local relay/desktop/upstream fixture,
configures both Gradle relay origins, boots an API 35 Google APIs x86_64 emulator,
and runs `connectedDebugAndroidTest`. The E2E test trusts only generated debug
certificate resource, so production trust settings remain strict. CI builds the
AGP-generated signed debug APK, verifies its signature with `apksigner`, and
uploads APK/test reports for 14 days. Android Studio can import
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

## Pairing contract

The app expects the terminal URL fragment format emitted by the gateway:

```text
https://mobile.example/pair#pairingId=<id>&token=<one-use-token>
```

It posts to the URL origin:

- `POST /v1/pairings/claim`
- `POST /v1/sessions/refresh`

Claim request includes `pairingId`, `token`, `manualCode`, `deviceName`, and
Keystore public-key encoding. Refresh uses encrypted `deviceId` and
`deviceToken` storage. QR token and access token never enter Android logs.

The managed relay now exposes the data-plane contract: desktop outbound WSS,
HTTP/SSE forwarding, browser WebSocket forwarding, and
`GET /v1/mobile/session`. Start relay and desktop connector with
`src/mobile-connect-relay.js` and `src/mobile-connect-agent.js`; production
needs a real public HTTPS/WSS origin and connector enrollment token. The app
uses the short-lived access token only for that native request, installs
returned `Secure; HttpOnly; SameSite=Strict` cookie into WebView CookieManager,
then loads same-origin UI without an Authorization URL header.

## WebView boundary

The app loads `uiUrl` when it is HTTPS and non-local. Before navigation it
calls `GET /v1/mobile/session` over native HTTPS, installs the returned
`Secure; HttpOnly; SameSite=Strict` cookie into WebView CookieManager, and
never exposes the access token to page JavaScript or URL headers. The WebView
has no JavaScript bridge. Redirects and navigations outside the exact initial
origin are blocked.

Do not add provider credentials, permanent relay tokens, Tailscale auth keys, or
local IP addresses to Gradle files, resources, or QR payloads. CI-only pairing
assets and certificate resources are generated, git-ignored, and removed after
tests.
