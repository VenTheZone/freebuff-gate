package com.freebuff.mobile

import java.net.URI
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession

/**
 * GeckoView equivalent of [RestrictedWebViewClient]: only HTTPS navigations
 * whose origin exactly matches [allowedOrigin] are permitted. Top-level and
 * subframe loads are both gated (mirrors WebView's shouldOverrideUrlLoading,
 * which also fires for frames), and new windows are refused the same way the
 * WebView build sets setSupportMultipleWindows(false).
 */
class RestrictedGeckoNavigationDelegate(
    private val allowedOrigin: String,
    private val onBlocked: (String) -> Unit,
    private val onCanGoBack: (Boolean) -> Unit = {},
) : GeckoSession.NavigationDelegate {

    override fun onLoadRequest(
        session: GeckoSession,
        request: GeckoSession.NavigationDelegate.LoadRequest,
    ): GeckoResult<AllowOrDeny>? {
        if (isAllowed(request.uri)) return null
        onBlocked(request.uri)
        return GeckoResult.fromValue(AllowOrDeny.DENY)
    }

    override fun onSubframeLoadRequest(
        session: GeckoSession,
        request: GeckoSession.NavigationDelegate.LoadRequest,
    ): GeckoResult<AllowOrDeny>? {
        if (isAllowed(request.uri)) return null
        onBlocked(request.uri)
        return GeckoResult.fromValue(AllowOrDeny.DENY)
    }

    override fun onNewSession(session: GeckoSession, uri: String): GeckoResult<GeckoSession>? = null

    override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
        onCanGoBack(canGoBack)
    }

    private fun isAllowed(rawUrl: String): Boolean = runCatching {
        val uri = URI(rawUrl)
        uri.scheme.equals("https", ignoreCase = true) &&
            RestrictedWebViewClient.originOf(rawUrl) == allowedOrigin
    }.getOrDefault(false)
}
