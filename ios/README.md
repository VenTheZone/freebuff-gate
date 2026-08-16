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
| `FreebuffGate/PairingApi.swift` | Claim/refresh/session-cookie HTTP calls |
| `FreebuffGate/DeviceIdentity.swift` | EC P-256 keypair in the Keychain (Secure Enclave) |
| `FreebuffGate/SecureSessionStore.swift` | AES-GCM encrypted session in the Keychain |
| `FreebuffGate/QrScannerView.swift` | AVFoundation QR scanner |
| `FreebuffGate/RestrictedWebViewController.swift` | WKWebView locked to the relay origin |
| `FreebuffGate/ReconnectController.swift` | Network monitoring + jittered backoff |
| `FreebuffGateTests/` | Unit tests for parsing and backoff math |
| `ExportOptions.plist` | ad-hoc export options for the signed CI job |

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

## CI

`.github/workflows/ios.yml` builds on macOS runners:

- `build-test`: generates the project, builds for the simulator without
  signing, runs the unit tests, and uploads the unsigned `.app`.
- `signed-ipa`: skipped unless the `IOS_SIGNING_CERT_BASE64` and
  `IOS_SIGNING_CERT_PASSWORD` secrets exist. It imports the distribution
  certificate, archives, and exports an ad-hoc IPA.

## Signing for a real device

A device-installable build needs an Apple Developer account:

1. Create an iOS distribution certificate and an ad-hoc provisioning
   profile in the Apple Developer portal.
2. Export the certificate as a `.p12` with a password.
3. Add `IOS_SIGNING_CERT_BASE64` (base64 of the `.p12`) and
   `IOS_SIGNING_CERT_PASSWORD` to the repository secrets.
4. Set the bundle id in `ios/project.yml` (`com.freebuff.gate`) in the
   provisioning profile, and update `ExportOptions.plist` if you prefer
   App Store export over ad-hoc.

Ad-hoc signed IPAs install on up to 100 registered devices via Apple Configurator
or a web distribution link; they do not need App Store review. TestFlight
requires an App Store export method and App Store Connect setup instead.

## Security notes

Same posture as the Android app:

- Pairing URLs must be HTTPS with the token in the URL fragment; the token is
  never logged.
- Device identity lives in the Keychain (Secure Enclave when available);
  only the public key is sent to the relay.
- The session is stored encrypted with AES-GCM under a Keychain key.
- The WKWebView is restricted to the exact relay origin: no other scheme or
  host is ever loaded, downloads are rejected, and the access token is never
  exposed to page JavaScript (only the relay-issued cookie is installed).
- Non-HTTPS origins, cleartext, and certificate bypasses are refused.
