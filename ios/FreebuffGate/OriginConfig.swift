import Foundation

/// Parses the build-time configured relay origins.
///
/// The values come from `Info.plist` keys (`FBDefaultPairingOrigin` and
/// `FBDefaultWebOrigin`), which are filled from the `FB_DEFAULT_PAIRING_ORIGIN`
/// and `FB_DEFAULT_WEB_ORIGIN` build settings. Generic builds leave them
/// empty: pairing trusts the HTTPS origin carried by the QR code, and the
/// WebView is pinned to that pairing relay unless the claimed UI URL uses the
/// same origin. A production/CI build can override the web origin to pin a
/// single known UI origin.
///
/// A blank or missing value yields `nil`; an insecure, credentialed, or
/// malformed value throws so callers cannot mistake invalid configuration for
/// an intentionally unpinned build.
enum OriginConfig {
    static func configuredOrigin(_ raw: String?) throws -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return try PairingApi.normalizeBaseUrl(trimmed)
    }

    /// Uses an explicit UI pin when configured; otherwise bind the UI to the
    /// relay that issued the pairing session, never to an arbitrary claimed URL.
    static func expectedWebOrigin(configuredWebOrigin: String?, pairingOrigin: String) throws -> String {
        if let configured = try configuredOrigin(configuredWebOrigin) {
            return configured
        }
        guard let pairing = try configuredOrigin(pairingOrigin) else {
            throw PairingError.invalidUrl("Pairing relay origin is invalid")
        }
        return pairing
    }

    static func allowsWebUrl(
        _ webUrl: String,
        configuredWebOrigin: String?,
        pairingOrigin: String
    ) throws -> Bool {
        let actualOrigin = try PairingApi.normalizeBaseUrl(webUrl)
        let expectedOrigin = try expectedWebOrigin(
            configuredWebOrigin: configuredWebOrigin,
            pairingOrigin: pairingOrigin
        )
        return actualOrigin == expectedOrigin
    }
}
