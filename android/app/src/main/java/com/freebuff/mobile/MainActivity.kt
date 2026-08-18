package com.freebuff.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.net.URI
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var setupPanel: View
    private lateinit var scannerPanel: FrameLayout
    private lateinit var browserHost: FrameLayout
    private lateinit var engine: GateBrowserEngine
    private lateinit var stateLabel: TextView
    private lateinit var pairingUrlInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var pairButton: Button
    private lateinit var disconnectButton: Button

    private lateinit var sessionStore: SecureSessionStore
    private lateinit var deviceIdentity: DeviceIdentity
    private lateinit var reconnectController: ReconnectController
    private lateinit var qrScanner: QrScanner
    private var webSessionLoading = false
    private var loadedWebSessionKey: String? = null
    // E2E tunnel prototype (docs/e2e-tunnel.md §5): owns the loopback proxy +
    // tunnel peer while the WebView is pointed at 127.0.0.1.
    private var tunnelGateway: com.freebuff.mobile.tunnel.TunnelGateway? = null
    private val pairingExecutor = Executors.newSingleThreadExecutor()

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) openScanner() else showState(ConnectionState.ERROR, "Camera permission is required for QR pairing")
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        // Best effort: the background turn-notification service still runs
        // without POST_NOTIFICATIONS; only the notification itself is hidden.
    }

    override fun onResume() {
        super.onResume()
        isForeground = true
        if (::reconnectController.isInitialized) reconnectController.onResume()
    }

    override fun onPause() {
        isForeground = false
        super.onPause()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        setupPanel = findViewById(R.id.setupPanel)
        scannerPanel = findViewById(R.id.scannerPanel)
        browserHost = findViewById(R.id.browserHost)
        stateLabel = findViewById(R.id.connectionState)
        pairingUrlInput = findViewById(R.id.pairingUrlInput)
        deviceNameInput = findViewById(R.id.deviceNameInput)
        pairButton = findViewById(R.id.pairButton)
        disconnectButton = findViewById(R.id.disconnectButton)

        deviceNameInput.setText(Build.MODEL)
        engine = GateEngineFactory.create(this)
        engine.configure {
            showState(ConnectionState.ERROR, "Downloads are disabled in Freebuff Gate")
        }
        browserHost.addView(
            engine.view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        sessionStore = SecureSessionStore(this)
        deviceIdentity = DeviceIdentity()
        reconnectController = ReconnectController(this, sessionStore) { state, detail, session ->
            runOnUiThread { renderConnection(state, detail, session) }
        }

        qrScanner = QrScanner(
            context = this,
            lifecycleOwner = this,
            previewView = findViewById<PreviewView>(R.id.qrPreview),
            onResult = { value ->
                runOnUiThread {
                    pairingUrlInput.setText(value)
                    closeScanner()
                    deviceNameInput.requestFocus()
                    showState(ConnectionState.PAIRING, "QR captured; tap Pair device")
                }
            },
            onError = { message -> runOnUiThread { showState(ConnectionState.ERROR, message) } },
        )

        findViewById<Button>(R.id.scanQrButton).setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                openScanner()
            } else {
                cameraPermission.launch(Manifest.permission.CAMERA)
            }
        }
        findViewById<Button>(R.id.closeScannerButton).setOnClickListener { closeScanner() }
        pairButton.setOnClickListener { claimPairing() }
        disconnectButton.setOnClickListener {
            reconnectController.disconnect(clearSession = true)
            stopTunnelGateway()
            engine.stopLoading()
            browserHost.visibility = View.GONE
            setupPanel.visibility = View.VISIBLE
        }

        reconnectController.start()
    }


    override fun onBackPressed() {
        if (scannerPanel.visibility == View.VISIBLE) {
            closeScanner()
        } else if (browserHost.visibility == View.VISIBLE && engine.canGoBack()) {
            engine.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        isForeground = false
        stopTurnNotifications()
        stopTunnelGateway()
        if (::qrScanner.isInitialized) qrScanner.close()
        if (::reconnectController.isInitialized) reconnectController.close()
        pairingExecutor.shutdownNow()
        engine.destroy()
        super.onDestroy()
    }

    companion object {
        @Volatile
        var isForeground = false
            private set
    }

    private fun claimPairing() {
        val rawUrl = pairingUrlInput.text?.toString()?.trim().orEmpty()
        val deviceName = deviceNameInput.text?.toString()?.trim().orEmpty().ifBlank { Build.MODEL }
        if (rawUrl.isBlank()) {
            showState(ConnectionState.ERROR, "Scan or paste pairing URL")
            return
        }

        pairButton.isEnabled = false
        showState(ConnectionState.PAIRING, "Pairing device securely")
        pairingExecutor.execute {
            try {
                val payload = PairingPayload.parse(rawUrl)
                val configuredPairingOrigin = configuredOrigin(BuildConfig.DEFAULT_PAIRING_ORIGIN)
                require(configuredPairingOrigin == null || payload.baseUrl == configuredPairingOrigin) {
                    "Pairing URL is not from configured Freebuff relay"
                }
                val session = PairingApi(payload.baseUrl).claim(
                    payload = payload,
                    deviceName = deviceName,
                    devicePublicKey = deviceIdentity.publicKeyForPairing(),
                )
                sessionStore.save(session)
                runOnUiThread {
                    pairButton.isEnabled = true
                    reconnectController.reconnect()
                    showState(ConnectionState.CONNECTING, "Pairing accepted; connecting")
                }
            } catch (error: GatewayApiException) {
                runOnUiThread {
                    pairButton.isEnabled = true
                    showState(ConnectionState.ERROR, "Pairing failed (${error.status}): ${error.message}")
                }
            } catch (error: Exception) {
                runOnUiThread {
                    pairButton.isEnabled = true
                    showState(ConnectionState.ERROR, error.message ?: "Pairing failed")
                }
            }
        }
    }

    private fun renderConnection(state: ConnectionState, detail: String, session: PairingSession?) {
        showState(state, detail)
        val hasSession = session != null || sessionStore.load() != null
        disconnectButton.visibility = if (hasSession) View.VISIBLE else View.GONE
        // While a stored session exists, transient states (connecting/reconnecting/
        // offline) must not look like a fresh pairing request: keep the pairing
        // form hidden so the app reads as "reconnecting", not "scan a new QR".
        setPairingFormVisible(hasSession == false)

        when (state) {
            ConnectionState.CONNECTED -> {
                if (session != null) loadRemoteUi(session)
                startTurnNotifications()
            }
            ConnectionState.UNPAIRED,
            ConnectionState.PAIRING_REQUIRED,
            ConnectionState.REVOKED,
            ConnectionState.DISCONNECTED,
            -> {
                setupPanel.visibility = View.VISIBLE
                browserHost.visibility = View.GONE
                stopTurnNotifications()
            }
            ConnectionState.RECONNECTING,
            ConnectionState.OFFLINE,
            ConnectionState.CONNECTING,
            ConnectionState.PAIRING,
            ConnectionState.ERROR,
            -> {
                if (browserHost.visibility != View.VISIBLE) setupPanel.visibility = View.VISIBLE
            }
        }
    }

    private fun startTurnNotifications() {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        runCatching {
            ContextCompat.startForegroundService(this, Intent(this, TurnNotificationService::class.java))
        }
    }

    private fun stopTurnNotifications() {
        runCatching { stopService(Intent(this, TurnNotificationService::class.java)) }
    }

    private fun setPairingFormVisible(visible: Boolean) {
        val visibility = if (visible) View.VISIBLE else View.GONE
        findViewById<View>(R.id.scanQrButton).visibility = visibility
        findViewById<View>(R.id.pairingUrlField).visibility = visibility
        findViewById<View>(R.id.deviceNameField).visibility = visibility
        pairButton.visibility = visibility
    }

    private fun loadRemoteUi(session: PairingSession) {
        if (session.tunnelEnabled) {
            loadRemoteUiViaTunnel(session)
            return
        }
        val configuredUi = session.uiUrl?.takeIf { isHttpsUrl(it) }
        val candidate = configuredUi ?: session.relayUrl?.let { relayToHttp(it) }
        val uri = candidate?.let { runCatching { URI(it) }.getOrNull() }
        if (uri == null || !uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrBlank()) {
            showState(ConnectionState.CONNECTED, "Paired; managed relay UI URL is not configured yet")
            return
        }

        val target = uri.toString()
        val origin = RestrictedWebViewClient.originOf(target)
        if (origin == null) {
            showState(ConnectionState.ERROR, "Remote UI origin is invalid")
            return
        }
        val configuredWebOrigin = configuredOrigin(BuildConfig.DEFAULT_WEB_ORIGIN)
        val sessionOrigin = configuredWebOrigin
            ?: PairingApi.normalizeBaseUrl(session.gatewayBaseUrl)
        if (origin != sessionOrigin) {
            showState(ConnectionState.ERROR, "Remote UI origin is not configured for this app")
            return
        }
        engine.setRestriction(origin) { blockedUrl ->
            confirmOpenExternal(blockedUrl)
        }
        val sessionKey = "${session.deviceId}:${session.accessToken}"
        if (webSessionLoading || (loadedWebSessionKey == sessionKey && browserHost.visibility == View.VISIBLE)) return
        webSessionLoading = true
        showState(ConnectionState.CONNECTED, "Establishing secure session")
        pairingExecutor.execute {
            try {
                val cookie = PairingApi(origin).establishWebSession(origin, session.accessToken)
                runOnUiThread {
                    loadedWebSessionKey = sessionKey
                    webSessionLoading = false
                    setupPanel.visibility = View.GONE
                    browserHost.visibility = View.VISIBLE
                    // Relay exchanged access token for Secure/HttpOnly cookie;
                    // token is not passed into page JavaScript or URL headers.
                    engine.load(target, cookie)
                }
            } catch (error: GatewayApiException) {
                runOnUiThread {
                    webSessionLoading = false
                    showState(ConnectionState.ERROR, "Browser session failed (${error.status}): ${error.message}")
                }
            } catch (error: Exception) {
                runOnUiThread {
                    webSessionLoading = false
                    showState(ConnectionState.ERROR, error.message ?: "Browser session failed")
                }
            }
        }
    }

    /**
     * Tunnel mode (Phase 1 prototype): WebView points at the loopback proxy
     * (127.0.0.1) whose traffic rides the encrypted tunnel to the desktop
     * agent. No relay session cookie — the desktop orchestrator's own cookie
     * flows back through the tunnel like a desktop browser (docs/e2e-tunnel.md
     * §5.6).
     */
    private fun loadRemoteUiViaTunnel(session: PairingSession) {
        val sessionKey = "${session.deviceId}:tunnel"
        if (webSessionLoading || (loadedWebSessionKey == sessionKey && browserHost.visibility == View.VISIBLE)) return
        webSessionLoading = true
        showState(ConnectionState.CONNECTED, "Establishing encrypted tunnel")
        try {
            val gateway = com.freebuff.mobile.tunnel.TunnelGateway(session)
            val baseUrl = gateway.start()
            val origin = RestrictedWebViewClient.originOf(baseUrl)
            if (origin == null) {
                gateway.close()
                throw IllegalStateException("Tunnel loopback origin is invalid")
            }
            tunnelGateway = gateway
            engine.setRestriction(origin) { blockedUrl ->
                confirmOpenExternal(blockedUrl)
            }
            loadedWebSessionKey = sessionKey
            webSessionLoading = false
            setupPanel.visibility = View.GONE
            browserHost.visibility = View.VISIBLE
            engine.load(baseUrl, null)
        } catch (error: Exception) {
            webSessionLoading = false
            stopTunnelGateway()
            showState(ConnectionState.ERROR, error.message ?: "Tunnel failed to start")
        }
    }

    private fun stopTunnelGateway() {
        tunnelGateway?.close()
        tunnelGateway = null
    }

    private fun configuredOrigin(raw: String): String? {
        val value = raw.trim()
        if (value.isBlank()) return null
        return PairingApi.normalizeBaseUrl(value)
    }

    private fun isHttpsUrl(raw: String): Boolean {
        val uri = runCatching { URI(raw) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
    }

    private fun relayToHttp(raw: String): String? {
        val normalized = raw.trim()
        return when {
            normalized.startsWith("wss://", ignoreCase = true) -> "https://${normalized.substring(6)}".trimEnd('/')
            normalized.startsWith("ws://", ignoreCase = true) -> null
            normalized.startsWith("https://", ignoreCase = true) -> normalized.trimEnd('/')
            else -> null
        }
    }

    // Ad clicks and other off-origin links are refused by the WebView guard.
    // Instead of an error banner, ask: show the destination and let the user
    // open it in the device's external browser, or close the prompt.
    private fun confirmOpenExternal(rawUrl: String) {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull()
        if (uri == null || (uri.scheme != "http" && uri.scheme != "https")) return
        val host = uri.host?.removePrefix("www.") ?: return
        AlertDialog.Builder(this)
            .setTitle("Open in browser?")
            .setMessage("Open \"$host\" in your external browser?")
            .setPositiveButton("Open") { _, _ ->
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun openScanner() {
        scannerPanel.visibility = View.VISIBLE
        setupPanel.visibility = View.GONE
        qrScanner.start()
    }

    private fun closeScanner() {
        qrScanner.stop()
        scannerPanel.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
    }

    private fun showState(state: ConnectionState, detail: String) {
        stateLabel.text = "${state.name.replace('_', ' ')}\n$detail"
    }
}
