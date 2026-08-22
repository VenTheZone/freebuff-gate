package com.freebuff.mobile

import android.net.Uri
import android.view.View

/**
 * Rendering-engine seam used by [MainActivity]. The activity, pairing flow, and
 * origin guard are engine-agnostic; only this contract changes between the
 * system WebView and GeckoView (Firefox engine) builds.
 */
interface GateBrowserEngine {
    /** The engine's view; the host attaches it to the browser container. */
    val view: View

    /** One-time setup (JS/dom/cache flags, cookie acceptance, etc.). */
    fun configure(onBlockedDownload: () -> Unit)

    /**
     * Restricts top-level and subframe navigation to the given HTTPS origin.
     * [onBlocked] is invoked with the offending URL when a load is refused.
     */
    fun setRestriction(allowedOrigin: String, onBlocked: (String) -> Unit)

    /**
     * Loads [url]. [sessionCookie] is the relay's Set-Cookie value from the
     * native web-session exchange; each engine installs it in its own way and
     * never exposes it to page JavaScript.
     */
    fun load(url: String, sessionCookie: String?)

    fun canGoBack(): Boolean
    fun goBack()
    fun stopLoading()
    fun destroy()

    /**
     * Registers a callback the engine invokes when the page requests file
     * selection (<input type=file>). The activity provides the launcher that
     * opens the system file picker; [requestFile] receives the accept types
     * and whether multiple selection was requested.
     */
    fun setFilePickerLauncher(
        requestFile: (acceptTypes: Array<String>, allowMultiple: Boolean) -> Unit,
    ) {
    }

    /** Called with the picker's URIs (null = cancelled). No-op default so
     *  engines without file-picker support compile unchanged. */
    fun onFilePickerResult(uris: List<Uri>?) {}
}
