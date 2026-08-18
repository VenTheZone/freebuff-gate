package com.freebuff.mobile.tunnel

import com.freebuff.mobile.PairingSession

/**
 * Prototype wiring for Phase 1 (docs/e2e-tunnel.md): starts the E2E tunnel to
 * the desktop agent through the blind relay rendezvous, plus the loopback HTTP
 * proxy the WebView is pointed at. All WebView traffic rides the encrypted
 * tunnel; the relay never sees the data plane.
 *
 * The session's `tunnelWsUrl`/`tunnelToken`/`tunnelSessionId` come from the
 * relay's claim/refresh response (same token the desktop connector received at
 * pairing time). When the tunnel is up, the WebView loads `baseUrl()` with NO
 * cookie: the desktop orchestrator issues its own session cookie through the
 * tunnel, exactly like a desktop browser.
 */
class TunnelGateway(private val session: PairingSession) {
    private var peer: TunnelPeer? = null
    private var proxy: LoopbackProxy? = null

    /** Starts the tunnel + loopback proxy; returns the base URL for the WebView. */
    @Synchronized
    fun start(): String {
        require(session.tunnelEnabled) { "Session has no tunnel rendezvous config" }
        val wsUrl = session.tunnelWsUrl!!
        // The relay rendezvous keys tunnels by session id; the token is the
        // shared rendezvous secret both endpoints received from the relay.
        // The relay's tunnelWsUrl is <wss://relay>/v1/tunnel; the rendezvous
        // pairs by the session id in the query.
        val peer = TunnelPeer(
            url = "$wsUrl?session=${session.tunnelSessionId!!}",
            token = session.tunnelToken!!,
            role = "mobile",
            onReady = { },
            onMessage = { },
            onClose = { _, _ -> },
            onError = { },
        )
        val proxy = LoopbackProxy(peer)
        proxy.start()
        peer.start()
        this.peer = peer
        this.proxy = proxy
        return proxy.baseUrl()
    }

    @Synchronized
    fun close() {
        proxy?.close()
        proxy = null
        peer?.close()
        peer = null
    }
}
