package com.freebuff.mobile.tunnel

import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * Loopback HTTP proxy (127.0.0.1) that the WebView is pointed at. Each incoming
 * request is serialized as a flat `http.request` tunnel message (headers ride
 * as `h:<name>` keys, matching the Kotlin SimpleJson encoder) and forwarded
 * through the [TunnelPeer] to the agent, which bridges it to the desktop UI.
 * Responses stream back as `http.response.start` / `http.response.chunk` /
 * `http.response.end` and are written to the client connection.
 *
 * Pure JVM (ServerSocket) so it is unit-testable on the host and runs on
 * Android. Prototype: one connection per request (Connection: close) — correct,
 * slower than keep-alive; fine for validating the tunnel path.
 */
class LoopbackProxy(private val peer: TunnelPeer) {
    private val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    private val pending = ConcurrentHashMap<String, PendingResponse>()
    private val idCounter = AtomicLong(0)
    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "fb-loopback").apply { isDaemon = true }
    }

    init {
        // The peer's message sink is the proxy's response dispatcher.
        peer.onMessage = { message -> dispatch(message) }
    }

    fun start(): LoopbackProxy {
        executor.execute { acceptLoop() }
        return this
    }

    fun port(): Int = server.localPort

    fun baseUrl(): String = "http://127.0.0.1:${server.localPort}/"

    fun close() {
        runCatching { server.close() }
        for (entry in pending.values) entry.finish()
        pending.clear()
        executor.shutdownNow()
    }

    private fun acceptLoop() {
        while (!server.isClosed) {
            val socket = try {
                server.accept()
            } catch (error: Exception) {
                return
            }
            executor.execute { handleConnection(socket) }
        }
    }

    private fun handleConnection(socket: Socket) {
        val output = socket.getOutputStream()
        try {
            val input = BufferedInputStream(socket.getInputStream())
            val reader = BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8))

            // Request line.
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) {
                writeError(output, 400, "Bad request line")
                return
            }
            val method = parts[0].uppercase()
            val path = parts[1]

            // Headers.
            val headers = LinkedHashMap<String, String>()
            var line = reader.readLine()
            while (line != null && line.isNotEmpty()) {
                val idx = line.indexOf(':')
                if (idx > 0) {
                    headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
                }
                line = reader.readLine()
            }

            // Body by Content-Length.
            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = input.read(body, read, contentLength - read)
                if (n < 0) break
                read += n
            }

            val id = "p_" + idCounter.incrementAndGet()
            val entry = PendingResponse(output)
            pending[id] = entry

            val message = LinkedHashMap<String, Any?>()
            message["type"] = "http.request"
            message["id"] = id
            message["method"] = method
            message["path"] = path
            for ((name, value) in headers) message["h:$name"] = value
            message["bodyBase64"] = if (body.isNotEmpty()) Base64.getEncoder().encodeToString(body) else null

            if (!peer.send(message)) {
                pending.remove(id)
                if (!entry.started) writeError(output, 502, "Tunnel not ready")
                return
            }
            entry.await()
        } catch (error: Exception) {
            // Client went away mid-request; nothing to write.
        } finally {
            runCatching { socket.close() }
        }
    }

    private fun dispatch(message: Map<String, Any?>) {
        val entry = pending[SimpleJson.string(message["id"])] ?: return
        when (SimpleJson.string(message["type"])) {
            "http.response.start" -> {
                val status = (message["status"] as? Number)?.toInt() ?: 200
                val headers = message["headers"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
                entry.start(status, headers)
            }
            "http.response.chunk" -> {
                val data = Base64.getDecoder().decode(SimpleJson.string(message["dataBase64"]))
                entry.writeChunk(data)
            }
            "http.response.end" -> {
                pending.remove(SimpleJson.string(message["id"]))
                entry.finish()
            }
            "http.error" -> {
                pending.remove(SimpleJson.string(message["id"]))
                if (!entry.started) {
                    entry.writeError(502, SimpleJson.string(message["message"], "Upstream error"))
                }
                entry.finish()
            }
        }
    }

    private fun writeError(output: OutputStream, status: Int, message: String) {
        val body = message.toByteArray(StandardCharsets.UTF_8)
        val head = "HTTP/1.1 $status Error\r\n" +
            "Content-Type: text/plain\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Connection: close\r\n\r\n"
        runCatching {
            output.write(head.toByteArray(StandardCharsets.UTF_8))
            output.write(body)
            output.flush()
        }
    }

    private class PendingResponse(private val output: OutputStream) {
        private val latch = CountDownLatch(1)
        @Volatile
        var started: Boolean = false
            private set

        @Synchronized
        fun start(status: Int, headers: Map<*, *>) {
            if (started) return
            started = true
            val reason = when (status) {
                200 -> "OK"
                204 -> "No Content"
                301 -> "Moved Permanently"
                302 -> "Found"
                304 -> "Not Modified"
                400 -> "Bad Request"
                401 -> "Unauthorized"
                403 -> "Forbidden"
                404 -> "Not Found"
                500 -> "Internal Server Error"
                502 -> "Bad Gateway"
                else -> "Status"
            }
            val sb = StringBuilder()
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
            sb.append("Connection: close\r\n")
            for ((key, value) in headers) {
                val name = key.toString()
                if (name.equals("connection", ignoreCase = true) ||
                    name.equals("transfer-encoding", ignoreCase = true)
                ) {
                    continue
                }
                sb.append(name).append(": ").append(value).append("\r\n")
            }
            sb.append("\r\n")
            runCatching {
                output.write(sb.toString().toByteArray(StandardCharsets.UTF_8))
                output.flush()
            }
        }

        @Synchronized
        fun writeChunk(data: ByteArray) {
            if (!started) return
            runCatching {
                output.write(data)
                output.flush()
            }
        }

        @Synchronized
        fun writeError(status: Int, message: String) {
            if (started) return
            val body = message.toByteArray(StandardCharsets.UTF_8)
            val head = "HTTP/1.1 $status Error\r\n" +
                "Content-Type: text/plain\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Connection: close\r\n\r\n"
            runCatching {
                output.write(head.toByteArray(StandardCharsets.UTF_8))
                output.write(body)
                output.flush()
            }
        }

        fun finish() {
            latch.countDown()
        }

        fun await(timeoutMs: Long = 120_000) {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        }
    }
}
