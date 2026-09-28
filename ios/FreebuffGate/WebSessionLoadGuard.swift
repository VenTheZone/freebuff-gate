import Foundation

/// Identifies the relay web session a WebView load belongs to.
///
/// Keyed on device identity and target URL, not short-lived access token:
/// ordinary token rotation must not reload the page. Cookie expiry is tracked
/// separately and checked when the app returns to foreground.
enum WebSessionKey {
    static func make(session: PairingSession, url: URL) -> String {
        "\(session.deviceId):\(url.absoluteString)"
    }
}

/// Decides whether the relay web session should be (re)established and the
/// WKWebView reloaded. It is intentionally free of WebKit so the rules are
/// unit-testable.
final class WebSessionLoadGuard {
    static let cookieRefreshMargin: TimeInterval = 24 * 60 * 60

    private var loadedKey: String?
    private var loadedCookieExpiresAt: Date?
    private var loadingKey: String?
    private var failedKey: String?

    /// True when a load should start for `key`: never while another load is in
    /// flight, already loaded, or failed until the user requests a retry.
    func shouldLoad(key: String) -> Bool {
        if loadingKey != nil { return false }
        if key == loadedKey || key == failedKey { return false }
        return true
    }

    func begin(key: String) {
        loadingKey = key
        failedKey = nil
    }

    /// Records successful setup with relay-provided cookie expiry.
    func finish(key: String, cookieExpiresAt: Date) {
        guard loadingKey == key else { return }
        loadingKey = nil
        loadedKey = key
        loadedCookieExpiresAt = cookieExpiresAt
        failedKey = nil
    }

    /// Releases only the matching in-flight key without marking it loaded.
    func fail(key: String) {
        guard loadingKey == key else { return }
        loadingKey = nil
        failedKey = key
    }

    /// Clears failure marker after explicit retry request.
    func retry(key: String) {
        if failedKey == key { failedKey = nil }
    }

    /// Forces a new exchange only when browser cookie is within refresh margin.
    func refreshIfCookieExpiresSoon(
        key: String,
        now: Date = Date(),
        margin: TimeInterval = cookieRefreshMargin
    ) {
        guard loadedKey == key,
              let expiresAt = loadedCookieExpiresAt,
              expiresAt.timeIntervalSince(now) <= margin else { return }
        loadedKey = nil
        loadedCookieExpiresAt = nil
    }

    /// Drops all markers after revoke/clear or host teardown.
    func invalidate() {
        loadedKey = nil
        loadedCookieExpiresAt = nil
        loadingKey = nil
        failedKey = nil
    }
}
