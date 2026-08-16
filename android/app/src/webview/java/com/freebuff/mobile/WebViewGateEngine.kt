package com.freebuff.mobile

import android.content.Context
import android.os.Build
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * System Chromium WebView engine. This is the behavior the GeckoView spike must
 * match: same origin restriction, same Secure/HttpOnly session cookie install,
 * same user-agent marker, downloads disabled, SSL errors never bypassed.
 */
class WebViewGateEngine(context: Context) : GateBrowserEngine {
    private val webView = WebView(context)
    private var allowedOrigin: String? = null

    override val view: View get() = webView

    override fun configure(onBlockedDownload: () -> Unit) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
            // HTML is no-store and hashed assets are immutable (set by the
            // proxy/orchestrator), so normal HTTP caching is safe.
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString FreebuffMobile/0.1"
        }
        webView.isVerticalScrollBarEnabled = false
        CookieManager.getInstance().setAcceptCookie(true)
        webView.setDownloadListener { _, _, _, _, _ -> onBlockedDownload() }
    }

    override fun setRestriction(allowedOrigin: String, onBlocked: (String) -> Unit) {
        this.allowedOrigin = allowedOrigin
        webView.webViewClient = RestrictedWebViewClient(allowedOrigin, onBlocked)
    }

    override fun load(url: String, sessionCookie: String?) {
        if (!sessionCookie.isNullOrBlank()) {
            val origin = allowedOrigin ?: RestrictedWebViewClient.originOf(url)
            if (origin != null) {
                CookieManager.getInstance().setCookie(origin, sessionCookie)
                CookieManager.getInstance().flush()
            }
        }
        webView.loadUrl(url)
    }

    override fun canGoBack(): Boolean = webView.canGoBack()
    override fun goBack() = webView.goBack()
    override fun stopLoading() = webView.stopLoading()
    override fun destroy() = webView.destroy()
}
