package com.freebuff.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * System Chromium WebView engine. This is the behavior the GeckoView spike must
 * match: same origin restriction, same Secure/HttpOnly session cookie install,
 * same user-agent marker, downloads disabled, SSL errors never bypassed.
 */
class WebViewGateEngine(context: Context) : GateBrowserEngine {
    private val appContext = context.applicationContext
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
        // Dark surface behind the page so startup and slow loads don't flash
        // white between the window background and the gateway's first paint.
        webView.setBackgroundColor(android.graphics.Color.parseColor("#0B0B0F"))
        CookieManager.getInstance().setAcceptCookie(true)
        webView.setDownloadListener { _, _, _, _, _ -> onBlockedDownload() }
        // Bridge the injected mobile layer (mobile-ui.js) to the native
        // external browser: the ad popup's Open button calls
        // window.FreebuffNative.openExternal(url) to leave the WebView
        // instead of navigating inside it.
        webView.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun openExternal(url: String) {
                    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
                    if (uri.scheme != "http" && uri.scheme != "https") return
                    runCatching {
                        appContext.startActivity(
                            Intent(Intent.ACTION_VIEW, uri)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }
            },
            "FreebuffNative",
        )
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
