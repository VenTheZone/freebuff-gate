package com.freebuff.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

class ReconnectController(
    context: Context,
    private val sessionStore: SecureSessionStore,
    private val listener: (ConnectionState, String, PairingSession?) -> Unit,
) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scheduleConnect(immediate = true)
        }

        override fun onLost(network: Network) {
            if (!manualDisconnect) emit(ConnectionState.OFFLINE, "Network unavailable", sessionStore.load())
        }
    }

    @Volatile
    private var manualDisconnect = false
    private var retryAttempt = 0
    private var scheduled: ScheduledFuture<*>? = null
    private var refreshTimer: ScheduledFuture<*>? = null
    private var started = false

    fun start() {
        if (started) return
        started = true
        manualDisconnect = false
        runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }
        scheduleConnect(immediate = true)
    }

    fun onResume() {
        if (!started) start() else if (!manualDisconnect) scheduleConnect(immediate = true)
    }

    fun disconnect(clearSession: Boolean) {
        manualDisconnect = true
        scheduled?.cancel(false)
        refreshTimer?.cancel(false)
        refreshTimer = null
        if (clearSession) sessionStore.clear()
        emit(
            if (clearSession) ConnectionState.UNPAIRED else ConnectionState.DISCONNECTED,
            if (clearSession) "Pairing removed" else "Disconnected by user",
            sessionStore.load(),
        )
    }

    fun reconnect() {
        manualDisconnect = false
        retryAttempt = 0
        scheduleConnect(immediate = true)
    }

    fun close() {
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        scheduled?.cancel(true)
        refreshTimer?.cancel(true)
        executor.shutdownNow()
        started = false
    }

    private fun scheduleConnect(immediate: Boolean) {
        if (manualDisconnect || !started) return
        scheduled?.cancel(false)
        val delay = if (immediate) 0L else retryDelayMs()
        scheduled = executor.schedule({ connectOnce() }, delay, TimeUnit.MILLISECONDS)
    }

    private fun connectOnce() {
        if (manualDisconnect) return
        val stored = sessionStore.load()
        if (stored == null) {
            emit(ConnectionState.UNPAIRED, "Scan a pairing QR code", null)
            return
        }

        val reconnecting = retryAttempt > 0
        emit(
            if (reconnecting) ConnectionState.RECONNECTING else ConnectionState.CONNECTING,
            if (reconnecting) "Retrying gateway connection" else "Connecting to gateway",
            stored,
        )

        try {
            val refreshed = PairingApi(stored.gatewayBaseUrl).refresh(stored)
            sessionStore.save(refreshed)
            retryAttempt = 0
            scheduleSessionRefresh(refreshed)
            emit(ConnectionState.CONNECTED, "Gateway authenticated", refreshed)
        } catch (error: GatewayApiException) {
            if (error.status == 401 || error.status == 403) {
                sessionStore.clear()
                refreshTimer?.cancel(false)
                refreshTimer = null
                emit(ConnectionState.PAIRING_REQUIRED, "Pairing expired or revoked", null)
            } else {
                scheduleRetry(stored, error.message ?: "Gateway error")
            }
        } catch (error: IOException) {
            scheduleRetry(stored, "Waiting for network")
        } catch (error: Exception) {
            scheduleRetry(stored, error.message ?: "Connection failed")
        }
    }

    private fun scheduleSessionRefresh(session: PairingSession) {
        refreshTimer?.cancel(false)
        val expiresAt = runCatching { java.time.Instant.parse(session.accessTokenExpiresAt).toEpochMilli() }
            .getOrElse { System.currentTimeMillis() + 10 * 60_000L }
        val delay = (expiresAt - System.currentTimeMillis() - 60_000L)
            .coerceIn(30_000L, 10 * 60_000L)
        refreshTimer = executor.schedule({
            refreshTimer = null
            if (!manualDisconnect) connectOnce()
        }, delay, TimeUnit.MILLISECONDS)
    }

    private fun scheduleRetry(session: PairingSession, detail: String) {
        retryAttempt += 1
        emit(ConnectionState.RECONNECTING, detail, session)
        scheduleConnect(immediate = false)
    }

    private fun retryDelayMs(): Long {
        val exponent = min(retryAttempt - 1, 6)
        val base = min(60_000L, 1_000L shl exponent)
        val jitter = Random.nextDouble(0.8, 1.2)
        return (base * jitter).toLong()
    }

    private fun emit(state: ConnectionState, detail: String, session: PairingSession?) {
        mainHandler.post { listener(state, detail, session) }
    }
}
