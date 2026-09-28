import UIKit
import WebKit

/// WKWebView that only ever loads the relay origin, rejects every other
/// navigation, and blocks downloads. The session cookie is installed into
/// the WKWebsiteDataStore before the first load; JavaScript is enabled only
/// after the cookie is in place.
class RestrictedWebViewController: UIViewController, WKNavigationDelegate {
    private static let relaySessionCookieName = "__Host-freebuff_session"

    private let allowedOrigin: String
    private let onBlockedNavigation: (String) -> Void
    private var webView: WKWebView?

    init(allowedOrigin: String, onBlockedNavigation: @escaping (String) -> Void) {
        self.allowedOrigin = allowedOrigin
        self.onBlockedNavigation = onBlockedNavigation
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView = webView
        view = webView
    }

    func loadRemoteUi(url: URL) {
        guard let webView else { return }
        webView.load(URLRequest(url: url))
    }

    /// Parses the relay's Set-Cookie header and verifies the cookie was
    /// persisted for the pinned HTTPS origin. Failure is explicit; caller must
    /// not load the UI unauthenticated.
    func installCookie(_ cookieHeader: String, for url: URL) async throws {
        guard let store = webView?.configuration.websiteDataStore.httpCookieStore else {
            throw PairingError.badResponse("WebView cookie store is unavailable")
        }
        let cookies = try Self.validatedCookies(
            cookieHeader,
            for: url,
            allowedOrigin: allowedOrigin
        )
        for cookie in cookies {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                store.setCookie(cookie) {
                    continuation.resume()
                }
            }
        }

        let installedCookies = await withCheckedContinuation { (continuation: CheckedContinuation<[HTTPCookie], Never>) in
            store.getAllCookies { continuation.resume(returning: $0) }
        }
        for cookie in cookies {
            guard installedCookies.contains(where: {
                $0.name == cookie.name
                    && $0.value == cookie.value
                    && $0.domain == cookie.domain
                    && $0.path == cookie.path
            }) else {
                throw PairingError.badResponse("Relay session cookie could not be installed")
            }
        }
    }

    static func validatedCookies(
        _ cookieHeader: String,
        for url: URL,
        allowedOrigin: String
    ) throws -> [HTTPCookie] {
        guard originOf(url.absoluteString) == allowedOrigin else {
            throw PairingError.invalidUrl("Web session URL does not match pinned origin")
        }
        let attributes = cookieHeader
            .split(separator: ";")
            .dropFirst()
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        guard !attributes.contains(where: { $0.hasPrefix("domain=") }) else {
            throw PairingError.badResponse("Relay session cookie must be host-only")
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": cookieHeader], for: url)
        guard !cookies.isEmpty,
              cookies.allSatisfy({ cookie in
                  cookie.name == relaySessionCookieName
                      && cookie.path == "/"
                      && cookie.isSecure
                      && cookie.isHTTPOnly
                      && cookieMatchesOrigin(cookie, url: url)
              }) else {
            throw PairingError.badResponse("Relay returned an invalid session cookie")
        }
        return cookies
    }

    private static func cookieMatchesOrigin(_ cookie: HTTPCookie, url: URL) -> Bool {
        guard let host = url.host?.lowercased(), !cookie.domain.isEmpty else { return false }
        let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return host == domain
    }

    // WKNavigationDelegate -------------------------------------------------

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let target = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if Self.isAllowed(target, allowedOrigin: allowedOrigin) {
            decisionHandler(.allow)
        } else {
            onBlockedNavigation(target.absoluteString)
            decisionHandler(.cancel)
        }
    }

    /// True only for HTTPS navigations whose origin exactly matches the pinned
    /// relay origin: no other scheme, host, subdomain, or port.
    static func isAllowed(_ url: URL, allowedOrigin: String) -> Bool {
        url.scheme?.lowercased() == "https" && originOf(url.absoluteString) == allowedOrigin
    }

    /// `scheme://host[:port]` with a lowercased host, or nil when the URL has
    /// no scheme/host at all.
    static func originOf(_ raw: String) -> String? {
        guard let uri = URL(string: raw) else { return nil }
        var origin = "\(uri.scheme?.lowercased() ?? "")://\(uri.host?.lowercased() ?? "")"
        if let port = uri.port {
            origin += ":\(port)"
        }
        return origin
    }
}
