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
            uri.scheme.equals("https", ignoreCase = true) && originOf(uri) == allowedOrigin
        }.getOrDefault(false)
    }

    companion object {
        fun originOf(rawUrl: String): String? = runCatching { originOf(URI(rawUrl)) }.getOrNull()

        private fun originOf(uri: URI): String {
            val port = if (uri.port == -1) "" else ":${uri.port}"
            return "${uri.scheme.lowercase()}://${uri.host.lowercase()}$port"
        }
    }
}
