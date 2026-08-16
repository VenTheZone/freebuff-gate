package com.freebuff.mobile

import android.content.Context

/** Flavor-scoped engine selector: this copy ships the system WebView. */
object GateEngineFactory {
    fun create(context: Context): GateBrowserEngine = WebViewGateEngine(context)
}
