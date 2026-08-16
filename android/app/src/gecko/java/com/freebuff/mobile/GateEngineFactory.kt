package com.freebuff.mobile

import android.content.Context

/** Flavor-scoped engine selector: this copy ships GeckoView (Firefox engine). */
object GateEngineFactory {
    fun create(context: Context): GateBrowserEngine = GeckoGateEngine(context)
}
