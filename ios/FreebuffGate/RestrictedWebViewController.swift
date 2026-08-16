import UIKit
import WebKit

/// WKWebView that only ever loads the relay origin, rejects every other
/// navigation, and blocks downloads. The session cookie is installed into
/// the WKWebsiteDataStore before the first load; JavaScript is enabled only
/// after the cookie is in place.
class RestrictedWebViewController: UIViewController, WKNavigationDelegate {
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

    /// Parses the relay's Set-Cookie header and installs the cookies into the
    /// WKWebsiteDataStore. The access token is never passed to page JS.
    func installCookie(_ cookieHeader: String, for url: URL) async {
        guard let store = webView?.configuration.websiteDataStore.httpCookieStore else { return }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": cookieHeader], for: url)
        for cookie in cookies {
            await withCheckedContinuation { continuation in
                store.setCookie(cookie) {
                    continuation.resume()
                }
            }
        }
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
        if isAllowed(target) {
            decisionHandler(.allow)
        } else {
            onBlockedNavigation(target.absoluteString)
            decisionHandler(.cancel)
        }
    }

    private func isAllowed(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && Self.originOf(url.absoluteString) == allowedOrigin
    }

    static func originOf(_ raw: String) -> String? {
        guard let uri = URL(string: raw) else { return nil }
        var origin = "\(uri.scheme?.lowercased() ?? "")://\(uri.host?.lowercased() ?? "")"
        if let port = uri.port {
            origin += ":\(port)"
        }
        return origin
    }
}
