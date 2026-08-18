package com.freebuff.mobile.tunnel

import java.io.BufferedInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Minimal RFC 6455 WebSocket client used by the tunnel prototype. Pure JVM
 * (java.net sockets + optional TLS), no external websocket dependency, so the
 * tunnel stack is unit-testable on the host and runs on Android.
 *
 * Supports text frames, client masking, ping/pong, close, and continuation
 * reassembly. The relay's /v1/tunnel endpoint pipes bytes verbatim, so the
 * client never needs extensions or compression.
 */
/** Transport seam so tests can drive a peer from a server-side socket. */
interface WsTransport {
    fun start()
    fun sendText(text: String): Boolean
    fun close(code: Int = 1000, reason: String = "")
    var onOpen: () -> Unit
    var onText: (String) -> Unit
    var onClose: (Int, String) -> Unit
    var onError: (Exception) -> Unit
}

class WsClient(
    url: String,
    onText: (String) -> Unit,
    onClose: (Int, String) -> Unit,
    onError: (Exception) -> Unit,
) : WsTransport {
    private val parsed = java.net.URI(url)
    private val secure = parsed.scheme.equals("wss", ignoreCase = true)
    private val host: String = parsed.host
    private val port: Int = if (parsed.port != -1) parsed.port else if (secure) 443 else 80
    private val path: String = if (parsed.rawPath.isNullOrEmpty()) "/" else parsed.rawPath +
        (parsed.rawQuery?.let { "?$it" } ?: "")

    private val socket = Socket()
    private var inputStream: InputStream? = null
    private var outputStream: OutputStream? = null
    private val closed = AtomicBoolean(false)
    @Volatile
    private var wsThread: Thread? = null

    override var onOpen: () -> Unit = {}
    override var onText: (String) -> Unit = onText
    override var onClose: (Int, String) -> Unit = onClose
    override var onError: (Exception) -> Unit = onError

    override fun start() {
        val thread = Thread({ run() }, "fb-tunnel-ws").apply { isDaemon = true }
        wsThread = thread
        thread.start()
    }

    fun isOpen(): Boolean = !closed.get() && socket.isConnected && !socket.isClosed

    override fun sendText(text: String): Boolean {
        if (closed.get()) return false
        return try {
            writeFrame(OP_TEXT, text.toByteArray(StandardCharsets.UTF_8))
            true
        } catch (error: Exception) {
            fail(error)
            false
        }
    }

    override fun close(code: Int, reason: String) {
        if (closed.compareAndSet(false, true)) {
            try {
                val payload = ByteArray(2 + reason.toByteArray(StandardCharsets.UTF_8).size)
                payload[0] = (code ushr 8).toByte()
                payload[1] = code.toByte()
                reason.toByteArray(StandardCharsets.UTF_8).copyInto(payload, 2)
                writeFrame(OP_CLOSE, payload)
            } catch (_: Exception) {
                // best-effort close frame; socket teardown below
            }
            runCatching { socket.close() }
        }
    }

    private fun run() {
        try {
            connectSocket()
            val buffered = BufferedInputStream(inputStream!!)
            performHandshake(buffered)
            readLoop(buffered)
        } catch (error: EOFException) {
            if (closed.compareAndSet(false, true)) {
                runCatching { socket.close() }
                onClose(1006, "Connection closed")
            }
        } catch (error: Exception) {
            fail(error)
        }
    }

    private fun connectSocket() {
        socket.tcpNoDelay = true
        socket.connect(InetSocketAddress(host, port), 15_000)
        val wire: Socket = if (secure) {
            val ssl = javax.net.ssl.SSLContext.getDefault().socketFactory
                .createSocket(socket, host, port, true) as javax.net.ssl.SSLSocket
            ssl.startHandshake()
            ssl
        } else {
            socket
        }
        inputStream = wire.getInputStream()
        outputStream = wire.getOutputStream()
    }

    private fun performHandshake(handshakeInput: InputStream) {
        val keyBytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = Base64.getEncoder().encodeToString(keyBytes)
        val request = StringBuilder()
            .append("GET ").append(path).append(" HTTP/1.1\r\n")
            .append("Host: ").append(host)
            .append(if (port == 80 || port == 443) "" else ":$port").append("\r\n")
            .append("Upgrade: websocket\r\n")
            .append("Connection: Upgrade\r\n")
            .append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            .append("Sec-WebSocket-Version: 13\r\n")
            .append("\r\n")
        writeRaw(request.toString().toByteArray(StandardCharsets.UTF_8))

        // Read the HTTP response headers.
        val headerBytes = ArrayList<Byte>()
        while (true) {
            val b = handshakeInput.read()
            if (b < 0) throw EOFException("Connection closed during handshake")
            headerBytes.add(b.toByte())
            if (headerBytes.size >= 4) {
                val size = headerBytes.size
                if (headerBytes[size - 4] == '\r'.code.toByte() &&
                    headerBytes[size - 3] == '\n'.code.toByte() &&
                    headerBytes[size - 2] == '\r'.code.toByte() &&
                    headerBytes[size - 1] == '\n'.code.toByte()
                ) {
                    break
                }
            }
            if (headerBytes.size > 16 * 1024) throw IllegalStateException("Handshake headers too large")
        }
        val headerText = headerBytes.toByteArray().toString(StandardCharsets.UTF_8)
        val lines = headerText.split("\r\n")
        val statusLine = lines.firstOrNull() ?: throw IllegalStateException("Empty handshake response")
        if (!statusLine.contains(" 101 ")) {
            throw IllegalStateException("WebSocket upgrade rejected: $statusLine")
        }
        val accept = lines.firstOrNull { it.startsWith("Sec-WebSocket-Accept:", ignoreCase = true) }
            ?.substringAfter(':')?.trim()
        val expected = Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-1").digest(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.US_ASCII),
            ),
        )
        if (accept != expected) throw IllegalStateException("WebSocket accept key mismatch")
        if (!closed.get()) onOpen()
    }

    private fun readLoop(buffered: InputStream) {
        while (!closed.get()) {
            val opcode = readFrame(buffered) ?: return
            if (closed.get()) return
        }
    }

    // Reads one frame; returns its opcode (0x9 ping -> auto-pong handled
    // inline, 0x8 close -> returns null after closing).
    private fun readFrame(buffered: InputStream): Int? {
        val byte0 = buffered.read()
        if (byte0 < 0) throw EOFException("Connection closed")
        val fin = (byte0 and 0x80) != 0
        val opcode = byte0 and 0x0F

        val byte1 = buffered.read()
        if (byte1 < 0) throw EOFException("Connection closed")
        val masked = (byte1 and 0x80) != 0
        var length = (byte1 and 0x7F).toLong()
        if (length == 126L) {
            length = ((buffered.read() shl 8) or buffered.read()).toLong()
        } else if (length == 127L) {
            length = 0
            repeat(8) { length = (length shl 8) or buffered.read().toLong() }
        }
        if (length < 0 || length > MAX_FRAME_BYTES) throw IllegalStateException("Frame too large: $length")

        var maskKey = ByteArray(0)
        if (masked) {
            maskKey = ByteArray(4)
            readFully(buffered, maskKey)
        }
        val payload = ByteArray(length.toInt())
        readFully(buffered, payload)
        if (masked) {
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
        }

        when (opcode) {
            OP_CONTINUATION -> {
                continuationBuffer.append(payload.toString(StandardCharsets.UTF_8))
                if (fin) {
                    val message = continuationBuffer.toString()
                    continuationBuffer = StringBuilder()
                    if (!closed.get()) onText(message)
                }
            }
            OP_TEXT -> {
                if (fin) {
                    if (!closed.get()) onText(payload.toString(StandardCharsets.UTF_8))
                } else {
                    continuationBuffer = StringBuilder(payload.toString(StandardCharsets.UTF_8))
                }
            }
            OP_PING -> {
                // Respond with an unsolicited pong carrying the same payload.
                try { writeFrame(OP_PONG, payload) } catch (_: Exception) {}
            }
            OP_PONG -> { /* keepalive heartbeat; nothing to do */ }
            OP_CLOSE -> {
                val code = if (payload.size >= 2) ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF) else 1005
                val reason = if (payload.size > 2) payload.copyOfRange(2, payload.size).toString(StandardCharsets.UTF_8) else ""
                if (closed.compareAndSet(false, true)) {
                    runCatching { writeFrame(OP_CLOSE, ByteArray(0)) }
                    runCatching { socket.close() }
                    onClose(code, reason)
                }
                return null
            }
            else -> throw IllegalStateException("Unsupported opcode $opcode")
        }
        return opcode
    }

    private var continuationBuffer = StringBuilder()

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val stream = outputStream!!
        val header = ByteArray(10)
        header[0] = (0x80 or opcode).toByte()
        val mask = ByteArray(4).also { SecureRandom().nextBytes(it) }
        var index = 1
        when {
            payload.size < 126 -> {
                header[index++] = (0x80 or payload.size).toByte()
            }
            payload.size <= 0xFFFF -> {
                header[index++] = (0x80 or 126).toByte()
                header[index++] = (payload.size ushr 8).toByte()
                header[index++] = payload.size.toByte()
            }
            else -> {
                header[index++] = (0x80 or 127).toByte()
                var len = payload.size.toLong()
                for (i in 7 downTo 0) header[index++] = ((len shr (8 * i)) and 0xFF).toByte()
            }
        }
        val maskedPayload = ByteArray(payload.size)
        for (i in payload.indices) maskedPayload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        stream.write(header, 0, index)
        stream.write(mask)
        stream.write(maskedPayload)
        stream.flush()
    }

    private fun writeRaw(bytes: ByteArray) {
        val stream = outputStream!!
        stream.write(bytes)
        stream.flush()
    }

    private fun readFully(buffered: InputStream, target: ByteArray) {
        var read = 0
        while (read < target.size) {
            val n = buffered.read(target, read, target.size - read)
            if (n < 0) throw EOFException("Connection closed mid-frame")
            read += n
        }
    }

    private fun fail(error: Exception) {
        if (closed.compareAndSet(false, true)) {
            runCatching { socket.close() }
            onError(error)
        }
    }

    companion object {
        private const val OP_CONTINUATION = 0x0
        private const val OP_TEXT = 0x1
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xA
        private const val MAX_FRAME_BYTES = 16L * 1024 * 1024
    }
}
