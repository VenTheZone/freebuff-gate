package com.freebuff.mobile

import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.net.URI

class RestrictedWebViewClient(
    private val allowedOrigin: String,
    private val onBlockedNavigation: (String) -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val target = request.url?.toString().orEmpty()
        if (isAllowed(target)) return false
        onBlockedNavigation(target)
        return true
    }

    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
        if (isAllowed(url)) return false
        onBlockedNavigation(url)
        return true
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        // Never provide a certificate bypass path in production WebView.
        handler.cancel()
    }

    private fun isAllowed(rawUrl: String): Boolean {
        return runCatching {
            val uri = URI(rawUrl)
            val schemeOk = uri.scheme.equals("https", ignoreCase = true) ||
                // Tunnel mode (docs/e2e-tunnel.md): the WebView is pinned to the
                // app's own loopback proxy origin. http is only permitted for
                // loopback hosts AND the origin must still match exactly, so the
                // pinning is unchanged — only the scheme relaxation for
                // localhost, which is app-controlled.
                (uri.scheme.equals("http", ignoreCase = true) && isLoopbackHost(uri.host))
            schemeOk && originOf(uri) == allowedOrigin
        }.getOrDefault(false)
    }

    private fun isLoopbackHost(host: String?): Boolean {
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    companion object {
        fun originOf(rawUrl: String): String? = runCatching { originOf(URI(rawUrl)) }.getOrNull()

        private fun originOf(uri: URI): String {
            val port = if (uri.port == -1) "" else ":${uri.port}"
            return "${uri.scheme.lowercase()}://${uri.host.lowercase()}$port"
        }
    }
}
