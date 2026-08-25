package com.freebuff.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Stay-alive background connection for turn notifications.
 *
 * Holds an HTTPS SSE stream to the relay's /v1/mobile/events endpoint (the
 * relay proxies the desktop orchestrator's /api/events stream through the
 * paired connector). When an agent event with event.type == "finish" arrives
 * (Buffy finished a turn) and the app is not in the foreground, a local
 * notification is raised. Runs as a foreground service (dataSync) so the OS
 * keeps the connection alive; reconnects with backoff, refreshing the
 * short-lived access token before each attempt.
 */
class TurnNotificationService : Service() {
    private val running = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor()
    private val sessionStore by lazy { SecureSessionStore(this) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running.compareAndSet(false, true)) {
            startForegroundCompat()
            executor.execute { runEventLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val channelId = SERVICE_CHANNEL_ID
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Freebuff Gate connection", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps Freebuff Gate connected so turn-finished notifications can arrive"
                },
            )
        }
        val notification = Notification.Builder(this, channelId)
            .setContentTitle("Freebuff Gate")
            .setContentText("Listening for agent updates")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification)
        }
    }

    private fun runEventLoop() {
        var backoffMs = 2_000L
        while (running.get()) {
            val session = sessionStore.load() ?: run {
                stopSelf()
                return
            }
            try {
                val refreshed = PairingApi(session.gatewayBaseUrl).refresh(session)
                sessionStore.save(refreshed)
                streamEvents(refreshed)
                backoffMs = 2_000L
            } catch (error: GatewayApiException) {
                if (error.status == 401 || error.status == 403) {
                    // Pairing revoked/expired; nothing left to watch.
                    stopSelf()
                    return
                }
                Log.w(TAG, "events stream error: ${error.message}")
            } catch (error: Exception) {
                Log.w(TAG, "events stream error: ${error.message}")
            }
            if (!running.get()) return
            try {
                Thread.sleep(backoffMs)
            } catch (_: InterruptedException) {
                // shutdownNow() interrupts the loop thread on stop; exit
                // cleanly instead of crashing the process mid-instrumentation.
                return
            }
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    private fun streamEvents(session: PairingSession) {
        val connection = (URL("${session.gatewayBaseUrl}/v1/mobile/events").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 0 // long-lived stream; the loop reconnects on drop
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("Cache-Control", "no-store")
            setRequestProperty("Authorization", "Bearer ${session.accessToken}")
        }
        try {
            val status = connection.responseCode
            if (status != 200) throw IOException("events stream HTTP $status")
            val reader = BufferedReader(InputStreamReader(connection.inputStream, Charsets.UTF_8))
            while (running.get()) {
                val rawLine = reader.readLine() ?: break
                if (rawLine.startsWith("data: ")) handleEvent(rawLine.substring(6))
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun handleEvent(raw: String) {
        val event = runCatching { JSONObject(raw) }.getOrNull() ?: return
        if (event.optString("type") != "agent") return
        val agentEvent = event.optJSONObject("event") ?: return
        if (agentEvent.optString("type") != "finish") return
        val threadId = event.optString("threadId")
        if (MainActivity.isForeground) return
        notifyTurnFinished(threadId)
    }

    private fun notifyTurnFinished(threadId: String) {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(FINISH_CHANNEL_ID, "Buffy finished", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Notifies when Buffy finishes working"
                },
            )
        }
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (threadId.isNotEmpty()) putExtra("threadId", threadId)
        }
        val pending = PendingIntent.getActivity(
            this,
            FINISH_REQUEST_CODE,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, FINISH_CHANNEL_ID)
            .setContentTitle("Buffy finished working")
            .setContentText("Tap to open Freebuff Gate")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        runCatching { manager.notify(FINISH_NOTIFICATION_ID, notification) }
    }

    companion object {
        private const val TAG = "TurnNotification"
        private const val SERVICE_CHANNEL_ID = "gate_service"
        private const val FINISH_CHANNEL_ID = "gate_turn_finished"
        private const val SERVICE_NOTIFICATION_ID = 1
        private const val FINISH_NOTIFICATION_ID = 2
        private const val FINISH_REQUEST_CODE = 1001
    }
}
