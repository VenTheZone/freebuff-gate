# Freebuff Gate iOS

Native iOS companion for the Freebuff Gate relay, mirroring the Android app:
QR pairing, Keychain-backed device identity, encrypted session storage,
restricted WKWebView, and reconnect with jittered exponential backoff.

## Layout

| File | Purpose |
| --- | --- |
| `project.yml` | XcodeGen project definition (generates `FreebuffGate.xcodeproj`) |
| `FreebuffGate/FreebuffGateApp.swift` | App entry point |
| `FreebuffGate/MainView.swift` | SwiftUI setup form, QR scanner, WebView host, session controller |
| `FreebuffGate/PairingModels.swift` | Pairing payload/session parsing, connection states |
| `FreebuffGate/PairingApi.swift` | Claim/refresh/session-cookie/push-token HTTP calls |
| `FreebuffGate/DeviceIdentity.swift` | EC P-256 keypair (Secure Enclave, Keychain fallback) |
| `FreebuffGate/SecureSessionStore.swift` | AES-GCM encrypted session in the Keychain |
| `FreebuffGate/QrScannerView.swift` | AVFoundation QR scanner |
| `FreebuffGate/RestrictedWebViewController.swift` | WKWebView locked to the relay origin and validates cookie installation |
| `FreebuffGate/ReconnectController.swift` | Network monitoring, serialized connect, jittered backoff |
| `FreebuffGate/WebSessionLoadGuard.swift` | Suppresses duplicate web-session loads and tracks cookie expiry |
| `FreebuffGate/OriginConfig.swift` | Parses configured relay origins and pins UI origin |
| `FreebuffGateTests/` | Unit tests (see below) |
| `ExportOptions.plist` | Local ad-hoc export template; CI generates a filled copy |

## Build locally (macOS)

XcodeGen is required once:

```bash
brew install xcodegen
cd ios
xcodegen generate
open FreebuffGate.xcodeproj
```

Run the unit tests from the command line:

```bash
cd ios
xcodebuild \
  -project FreebuffGate.xcodeproj \
  -scheme FreebuffGate \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  CODE_SIGNING_ALLOWED=NO \
  test
```

## Origin pinning

`MainView` reads two Info.plist keys, both filled from build settings so no
production origin is hardcoded in Swift:

- `FBDefaultPairingOrigin` ← `FB_DEFAULT_PAIRING_ORIGIN`
- `FBDefaultWebOrigin` ← `FB_DEFAULT_WEB_ORIGIN`

Both default to empty. A generic build pairs against the HTTPS origin in the
scanned QR and pins the WebView to that pairing relay origin. A claimed UI URL
on another origin is rejected, so the bearer access token is never sent to an
unrelated host. A production or CI build may configure a separate, known UI
origin:

```bash
xcodebuild ... \
  FB_DEFAULT_PAIRING_ORIGIN=https://relay.example.com \
  FB_DEFAULT_WEB_ORIGIN=https://ui.example.com
```

An insecure, credentialed, or malformed value is rejected at parse time, never
accepted. An invalid non-empty configuration fails closed; it is not treated as
an absent pin.

## Web session cookie

The app requests `/v1/mobile/session` with native HTTPS and keeps the access
token out of page JavaScript. It accepts only `__Host-freebuff_session` with
`Secure`, `HttpOnly`, host-only scope and root path. WebKit cookie installation
is verified before navigation; missing or rejected cookies never fall through
to an unauthenticated UI load.

The relay returns cookie expiry metadata. iOS preserves the loaded page across
ordinary access-token rotations, but refreshes the cookie after foreground
resume when it is within 24 hours of expiry. That avoids unnecessary reloads
while covering an app left in the background beyond the relay's seven-day
cookie lifetime.

## APNs environment

`FreebuffGate.entitlements` sets `aps-environment` from the
`FB_APS_ENVIRONMENT` build setting: `development` for Debug, `production` for
Release. It must match the relay's APNs host (`FB_APNS_SANDBOX`). The APNs
device token is uploaded with the active session and deleted
(`DELETE /v1/mobile/push-token`) when the user disconnects or the pairing is
revoked. If its access token has expired, cleanup attempts a device-session
refresh first and still treats deletion as best-effort.

## CI

`.github/workflows/ios.yml` builds on macOS runners:

- `build-test`: installs a pinned XcodeGen, generates the project, normalizes
  the emitted project format, builds for the simulator without signing, runs
  the unit tests, and uploads the unsigned `.app`.
- `signed-ipa`: runs only when **all** signing secrets are present. If some but
  not all are set, the job fails immediately naming the missing ones. It
  imports the distribution certificate, installs the provisioning profile,
  archives, and exports an ad-hoc IPA.
- `attach-release` (main only): publishes the unsigned simulator build as
  `freebuff-gate-simulator.app.zip` on the `ios-debug-latest` rolling release,
  and the signed IPA as `freebuff-gate.ipa` on `ios-latest`, each with a
  SHA-256 checksum.

Signing secrets:

| Secret | Purpose |
| --- | --- |
| `IOS_SIGNING_CERT_BASE64` | base64 of the `.p12` distribution certificate |
| `IOS_SIGNING_CERT_PASSWORD` | password for that `.p12` |
| `IOS_TEAM_ID` | Apple Developer Team ID |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the ad-hoc `.mobileprovision` |
| `IOS_PROVISIONING_PROFILE_NAME` | profile name shown in the Apple Developer portal |

The repository never stores a Team ID or profile name.

## Free installation on iOS (No paid Apple Developer account needed)

Users who do not have a paid Apple Developer account ($99/year) can run Freebuff Gate on their iPhone using two free methods:

### Method 1: Safari Standalone / PWA (Instant, no computer required)
1. Open the browser link generated by Freebuff Gate (`https://<relay-host>/?fb_gate=<token>`) in Safari on your iPhone.
2. Tap the **Share** button (the square with an arrow pointing up).
3. Tap **Add to Home Screen** (*На экран «Домой»*).
4. Tap **Add**. An app icon will appear on your iOS home screen.
When opened from the home screen, the UI runs in standalone full-screen mode without Safari navigation bars, uses the mobile touch styling layer, and persists your authentication session.

### Method 2: Sideloading the native app via personal Apple ID (Sideloadly / AltStore)
If you want the native app with camera QR scanning:
1. Obtain the app package (`.ipa` or unsigned `.app` from CI / local build).
2. Use a free sideloading tool such as [Sideloadly](https://sideloadly.io/) or [AltStore](https://altstore.io/).
3. Connect your iPhone via USB or Wi-Fi, select the app, and sign in with your ordinary free personal Apple ID.
4. The tool will automatically sign and install the app onto your iPhone for 7 days (auto-refreshed over local Wi-Fi by AltStore/Sideloadly).

## Signing for a real device

1. Create an iOS distribution certificate and an ad-hoc provisioning profile
   in the Apple Developer portal for bundle id `com.freebuff.gate` (the value in
   `ios/project.yml`).
2. Export the certificate as a `.p12` with a password.
3. Base64-encode the `.p12` and the `.mobileprovision` and add the five secrets
   above to the repository.
4. For an App Store/TestFlight export instead, change `method` in the generated
   export options (and set `FB_APS_ENVIRONMENT` accordingly).

Ad-hoc signed IPAs install on up to 100 registered devices via Apple
Configurator or a web distribution link; TestFlight needs an App Store export.

## Security notes

Same posture as the Android app:

- Pairing URLs must be HTTPS with the token in the URL fragment; the token is
  never logged. Invalid URLs fail through the normal error path.
- Device identity lives in the Secure Enclave when available, with a
  Keychain-persisted P-256 fallback when it is not (for example the Simulator).
  Only the public key is sent to the relay and it has the same encoding either
  way.
- The session is stored encrypted with AES-GCM under a Keychain key.
- The WKWebView is restricted to the exact pinned HTTPS origin: no other
  scheme, host, subdomain, or port is ever loaded. The access token is used
  only by native requests; only the relay-issued HttpOnly cookie reaches WebView.
- Non-HTTPS origins, cleartext, and certificate bypasses are refused.

## Tests

`FreebuffGateTests` covers URL normalization and failure modes, configured
origin parsing and fallback pinning, exact-origin WebView navigation, secure
cookie parsing and installation policy, cookie expiry tracking, device identity
stability, connect-gate serialization, backoff/token-freshness math, and
push-token upload/cleanup (including expired-token refresh selection).
All run on the Simulator; a device-only run additionally exercises the Secure
Enclave path.
