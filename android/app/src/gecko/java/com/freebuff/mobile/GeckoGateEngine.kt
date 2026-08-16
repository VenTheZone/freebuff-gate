package com.freebuff.mobile

import android.content.Context
import android.view.View
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoView
import org.mozilla.geckoview.WebResponse

/**
 * GeckoView (Firefox engine) implementation of [GateBrowserEngine]. This is the
 * spike: the same pairing flow and origin guard run over Gecko instead of the
 * system WebView.
 *
 * Known gap vs WebView: GeckoView has no public set-cookie API, so the relay's
 * session cookie is attached to the initial top-level load as a `Cookie`
 * request header rather than installed into a cookie jar. See [load].
 */
class GeckoGateEngine(context: Context) : GateBrowserEngine {
    private val session: GeckoSession
    private val geckoView: GeckoView
    private var canGoBackState = false

    override val view: View get() = geckoView

    init {
        geckoView = GeckoView(context)
        session = GeckoSession()
        // Match WebView: no tracking protection, no ad/tracker blocking.
        session.settings.useTrackingProtection = false
        session.open(runtime(context))
        geckoView.setSession(session)
    }

    override fun configure(onBlockedDownload: () -> Unit) {
        // Workaround for Gecko Bug 1758212 (also blocks downloads the same way
        // the WebView DownloadListener does).
        session.contentDelegate = object : GeckoSession.ContentDelegate {
            override fun onExternalResponse(session: GeckoSession, response: WebResponse) {
                onBlockedDownload()
            }
        }
    }

    override fun setRestriction(allowedOrigin: String, onBlocked: (String) -> Unit) {
        session.navigationDelegate = RestrictedGeckoNavigationDelegate(
            allowedOrigin = allowedOrigin,
            onBlocked = onBlocked,
            onCanGoBack = { canGoBackState = it },
        )
    }

    override fun load(url: String, sessionCookie: String?) {
        val loader = GeckoSession.Loader().uri(url)
        if (!sessionCookie.isNullOrBlank()) {
            loader.additionalHeaders(mapOf("Cookie" to cookieHeaderValue(sessionCookie)))
                .headerFilter(GeckoSession.HEADER_FILTER_UNRESTRICTED_UNSAFE)
        }
        session.load(loader)
    }

    override fun canGoBack(): Boolean = canGoBackState
    override fun goBack() = session.goBack()
    override fun stopLoading() = session.stop()
    override fun destroy() {
        geckoView.releaseSession()
        session.close()
    }

    /** Set-Cookie strings carry attributes; a Cookie header only takes name=value. */
    private fun cookieHeaderValue(setCookie: String): String =
        setCookie.substringBefore(';').trim()

    companion object {
        @Volatile
        private var runtime: GeckoRuntime? = null

        // GeckoRuntime may only be created once per process (the activity is not
        // recreated on rotation thanks to configChanges, but keep the guard).
        private fun runtime(context: Context): GeckoRuntime =
            runtime ?: synchronized(this) {
                runtime ?: GeckoRuntime.create(
                    context.applicationContext,
                    GeckoRuntimeSettings.Builder()
                        .javaScriptEnabled(true)
                        .remoteDebuggingEnabled(false)
                        .consoleOutput(false)
                        .build(),
                ).also { runtime = it }
            }
    }
}
