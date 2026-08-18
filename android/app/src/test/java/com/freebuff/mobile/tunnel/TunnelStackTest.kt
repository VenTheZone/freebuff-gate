package com.freebuff.mobile.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class SimpleJsonTest {
    @Test
    fun roundTripsFlatAndNested() {
        val msg = mapOf(
            "type" to "http.request",
            "id" to "p_1",
            "method" to "GET",
            "path" to "/api/projects",
            "h:host" to "127.0.0.1:58060",
            "h:x-probe" to "via-tunnel",
            "bodyBase64" to null,
            "nested" to mapOf("a" to listOf(1, 2, 3), "b" to true, "c" to 1.5),
        )
        val text = SimpleJson.stringify(msg)
        val parsed = SimpleJson.parseObject(text)
        assertEquals("http.request", SimpleJson.string(parsed["type"]))
        assertEquals("p_1", SimpleJson.string(parsed["id"]))
        assertEquals("via-tunnel", SimpleJson.string(parsed["h:x-probe"]))
        assertTrue(parsed.containsKey("bodyBase64"))
        assertEquals(null, parsed["bodyBase64"])
        val nested = parsed["nested"] as Map<*, *>
        assertEquals(listOf(1L, 2L, 3L), nested["a"])
        assertEquals(true, nested["b"])
        assertEquals(1.5, (nested["c"] as Number).toDouble(), 0.0)
    }

    @Test
    fun parsesEscapesAndNumbers() {
        val parsed = SimpleJson.parseObject("""{"s":"a\"b\\c\nd","n":-42,"f":3.25,"u":"\u0041"}""")
        assertEquals("a\"b\\c\nd", SimpleJson.string(parsed["s"]))
        assertEquals(-42L, parsed["n"])
        assertEquals(3.25, (parsed["f"] as Number).toDouble(), 0.0)
        assertEquals("A", SimpleJson.string(parsed["u"]))
    }
}

class TunnelPeerCryptoTest {
    @Test
    fun deriveKeysMatchesNodeVectors() {
        // sharedSecret = 32 bytes of 0x07, token = "secret" — cross-checked
        // against src/mobile-connect-tunnel.js (Node hkdfSync).
        val shared = ByteArray(32) { 7 }
        val (m2a, a2m) = TunnelPeer.deriveKeys(shared, "secret")
        assertEquals(
            "d3a7b91c34d4e235a743b1e9dd52257f65ce99e23bf637bb672644f327e00dfd",
            m2a.toHex(),
        )
        assertEquals(
            "866cccdbc43796b3dba3bf8e39b7dbd846094461f18108696da8a0a9cc6b67f8",
            a2m.toHex(),
        )
    }

    @Test
    fun sealOpenRoundTripsAndRejectsWrongKey() {
        val shared = ByteArray(32) { 7 }
        val (m2a, a2m) = TunnelPeer.deriveKeys(shared, "secret")
        val (nonce, body) = TunnelPeer.seal(m2a, "hello tunnel".toByteArray())
        val plain = TunnelPeer.open(m2a, nonce, body)
        assertEquals("hello tunnel", plain.toString(StandardCharsets.UTF_8))
        // Wrong key fails authentication.
        assertThrows(Exception::class.java) {
            TunnelPeer.open(a2m, nonce, body)
        }
    }

    @Test
    fun x25519KeyPairProducesSpkiDer() {
        val pair = TunnelPeer.generateKeyPair()
        val der = pair.public.encoded
        assertNotNull(der)
        assertTrue(der.size > 24)
        // Peer public key reconstructs from the SPKI DER.
        val reconstructed = TunnelPeer.peerPublicKey(der)
        assertArrayEquals(pair.public.encoded, reconstructed.encoded)
    }
}

/**
 * Full-loop test: the Kotlin phone stack (WsClient + TunnelPeer mobile +
 * LoopbackProxy) talks to a fake agent on the other end of a real TCP socket.
 * The fake agent is itself a TunnelPeer (role=agent) driven by a server-side
 * WS transport, so the test covers the real WsClient frame codec, the ECDH
 * handshake, and the loopback HTTP forwarding end to end.
 */
class TunnelStackLoopTest {
    @Test
    fun phoneProxyThroughTunnelToAgent() {
        val token = "rendezvous-token"
        val fakeAgent = FakeAgentServer(token)
        fakeAgent.start()

        val phoneReady = CountDownLatch(1)
        val phoneErrors = CopyOnWriteArrayList<Exception>()
        val agentErrors = CopyOnWriteArrayList<Exception>()
        val phone = TunnelPeer(
            url = "ws://127.0.0.1:${fakeAgent.port}/v1/tunnel?session=sess",
            token = token,
            role = "mobile",
            onReady = { phoneReady.countDown() },
            onMessage = { },
            onClose = { _, _ -> },
            onError = { phoneErrors.add(it); println("PHONE ERR: $it") },
        )
        fakeAgent.errorSink = { agentErrors.add(it); println("AGENT ERR: $it") }

        val proxy = LoopbackProxy(phone)
        proxy.start()
        phone.start()

        assertTrue("phone tunnel ready (phone=$phoneErrors agent=$agentErrors)", phoneReady.await(10, TimeUnit.SECONDS))
        assertTrue("agent tunnel ready (phone=$phoneErrors agent=$agentErrors)", fakeAgent.agentReady.await(10, TimeUnit.SECONDS))
        assertTrue("no phone errors: ${phoneErrors}", phoneErrors.isEmpty())

        // Plain HTTP request through the loopback proxy -> tunnel -> agent.
        val (status, body) = httpGet("http://127.0.0.1:${proxy.port()}/hello?probe=1")
        assertEquals(200, status)
        val parsed = SimpleJson.parseObject(body)
        assertEquals("world", SimpleJson.string(parsed["hello"]))
        assertEquals("via-tunnel", SimpleJson.string(parsed["query"]))
        assertEquals("1", SimpleJson.string(parsed["probe"]))

        // POST body round trip.
        val (postStatus, postBody) = httpPost(
            "http://127.0.0.1:${proxy.port()}/echo",
            """{"ping":"pong"}""",
        )
        assertEquals(200, postStatus)
        assertEquals("""{"echoed":"{\"ping\":\"pong\"}"}""", postBody)

        // Agent saw the request and the flat h: headers rode the tunnel.
        assertEquals(2, fakeAgent.requests.size)
        val first = fakeAgent.requests[0]
        assertEquals("GET", SimpleJson.string(first["method"]))
        assertEquals("/hello?probe=1", SimpleJson.string(first["path"]))
        assertEquals("via-tunnel", SimpleJson.string(first["h:x-probe"]))

        proxy.close()
        phone.close()
        fakeAgent.close()
    }

    @Test
    fun wrongTokenNeverBecomesReady() {
        val token = "rendezvous-token"
        val fakeAgent = FakeAgentServer(token)
        fakeAgent.start()

        val phoneReady = CountDownLatch(1)
        val phone = TunnelPeer(
            url = "ws://127.0.0.1:${fakeAgent.port}/v1/tunnel?session=sess",
            token = "wrong-token",
            role = "mobile",
            onReady = { phoneReady.countDown() },
            onMessage = { },
            onClose = { _, _ -> },
            onError = { },
        )
        phone.start()

        assertFalse("wrong token must not become ready", phoneReady.await(2, TimeUnit.SECONDS))
        phone.close()
        fakeAgent.close()
    }

    // --- helpers -----------------------------------------------------------

    private fun httpGet(url: String): Pair<Int, String> {
        val parsed = java.net.URI(url)
        val socket = Socket(parsed.host, parsed.port)
        socket.use {
            val out = it.getOutputStream()
            val request = "GET ${parsed.rawPath}${parsed.rawQuery?.let { q -> "?$q" } ?: ""} HTTP/1.1\r\n" +
                "Host: ${parsed.host}:${parsed.port}\r\n" +
                "X-Probe: via-tunnel\r\n" +
                "Connection: close\r\n\r\n"
            out.write(request.toByteArray(StandardCharsets.UTF_8))
            out.flush()
            return readHttpResponse(it.getInputStream())
        }
    }

    private fun httpPost(url: String, body: String): Pair<Int, String> {
        val parsed = java.net.URI(url)
        val socket = Socket(parsed.host, parsed.port)
        socket.use {
            val out = it.getOutputStream()
            val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
            val request = "POST ${parsed.rawPath} HTTP/1.1\r\n" +
                "Host: ${parsed.host}:${parsed.port}\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: ${bodyBytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            out.write(request.toByteArray(StandardCharsets.UTF_8))
            out.write(bodyBytes)
            out.flush()
            return readHttpResponse(it.getInputStream())
        }
    }

    private fun readHttpResponse(input: InputStream): Pair<Int, String> {
        val buffered = BufferedInputStream(input)
        val headerBytes = ArrayList<Byte>()
        while (true) {
            val b = buffered.read()
            if (b < 0) throw IllegalStateException("EOF in response headers")
            headerBytes.add(b.toByte())
            val size = headerBytes.size
            if (size >= 4 &&
                headerBytes[size - 4] == '\r'.code.toByte() &&
                headerBytes[size - 3] == '\n'.code.toByte() &&
                headerBytes[size - 2] == '\r'.code.toByte() &&
                headerBytes[size - 1] == '\n'.code.toByte()
            ) {
                break
            }
        }
        val headerText = headerBytes.toByteArray().toString(StandardCharsets.UTF_8)
        val statusLine = headerText.substringBefore("\r\n")
        val status = statusLine.split(" ").getOrNull(1)?.toIntOrNull() ?: 0
        val rest = buffered.readBytes()
        return status to rest.toString(StandardCharsets.UTF_8)
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/**
 * Server-side WS transport + fake agent. Accepts one client, performs the
 * RFC 6455 handshake, then drives a TunnelPeer(role=agent) over the socket.
 */
private class FakeAgentServer(private val token: String) {
    private val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort
    val agentReady = CountDownLatch(1)
    val requests = CopyOnWriteArrayList<Map<String, Any?>>()
    var errorSink: (Exception) -> Unit = {}
    private val thread = Thread({ acceptLoop() }, "fake-agent").apply { isDaemon = true }
    private var agentPeer: TunnelPeer? = null
    private var socket: Socket? = null

    fun start() = thread.start()

    fun close() {
        runCatching { server.close() }
        runCatching { socket?.close() }
    }

    private fun acceptLoop() {
        val s = server.accept()
        socket = s
        val input = BufferedInputStream(s.getInputStream())
        val output = s.getOutputStream()
        val key = performHandshake(input, output)

        val transport = ServerWsTransport(input, output)
        val peer = TunnelPeer(
            url = "ws://fake",
            token = token,
            role = "agent",
            onReady = { agentReady.countDown() },
            onMessage = { message -> handleMessage(message) },
            onClose = { _, _ -> },
            onError = { errorSink(it) },
            transport = transport,
        )
        agentPeer = peer
        // start() wires the transport callbacks (including onText -> handleText)
        // and starts the read loop; required for the agent to send its confirm.
        peer.start()
    }

    private fun handleMessage(message: Map<String, Any?>) {
        requests.add(message)
        when (SimpleJson.string(message["type"])) {
            "http.request" -> {
                val id = SimpleJson.string(message["id"])
                val path = SimpleJson.string(message["path"])
                if (path.startsWith("/hello")) {
                    val query = SimpleJson.string(message["h:x-probe"], "none")
                    val probe = path.substringAfter("probe=", "none")
                    agentPeer?.send(
                        mapOf(
                            "type" to "http.response.start",
                            "id" to id,
                            "status" to 200,
                            "headers" to mapOf("Content-Type" to "application/json"),
                        ),
                    )
                    agentPeer?.send(
                        mapOf(
                            "type" to "http.response.chunk",
                            "id" to id,
                            "dataBase64" to Base64.getEncoder().encodeToString(
                                SimpleJson.stringify(
                                    mapOf("hello" to "world", "query" to query, "probe" to probe),
                                ).toByteArray(),
                            ),
                        ),
                    )
                    agentPeer?.send(mapOf("type" to "http.response.end", "id" to id))
                } else if (path.startsWith("/echo")) {
                    val body = SimpleJson.string(message["bodyBase64"], "").let {
                        if (it.isEmpty()) "" else String(Base64.getDecoder().decode(it))
                    }
                    agentPeer?.send(
                        mapOf(
                            "type" to "http.response.start",
                            "id" to id,
                            "status" to 200,
                            "headers" to mapOf("Content-Type" to "application/json"),
                        ),
                    )
                    agentPeer?.send(
                        mapOf(
                            "type" to "http.response.chunk",
                            "id" to id,
                            "dataBase64" to Base64.getEncoder().encodeToString(
                                SimpleJson.stringify(mapOf("echoed" to body)).toByteArray(),
                            ),
                        ),
                    )
                    agentPeer?.send(mapOf("type" to "http.response.end", "id" to id))
                }
            }
        }
    }

    private fun performHandshake(input: InputStream, output: OutputStream): String {
        val header = readHttpHeaders(input)
        val keyLine = header.lines().firstOrNull { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
            ?: throw IllegalStateException("No Sec-WebSocket-Key")
        val key = keyLine.substringAfter(":").trim()
        val accept = Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-1").digest(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.US_ASCII),
            ),
        )
        val response = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n\r\n"
        output.write(response.toByteArray(StandardCharsets.UTF_8))
        output.flush()
        return key
    }

    private fun readHttpHeaders(input: InputStream): String {
        val bytes = ArrayList<Byte>()
        while (true) {
            val b = input.read()
            if (b < 0) throw IllegalStateException("EOF in handshake")
            bytes.add(b.toByte())
            val size = bytes.size
            if (size >= 4 &&
                bytes[size - 4] == '\r'.code.toByte() &&
                bytes[size - 3] == '\n'.code.toByte() &&
                bytes[size - 2] == '\r'.code.toByte() &&
                bytes[size - 1] == '\n'.code.toByte()
            ) {
                break
            }
        }
        return bytes.toByteArray().toString(StandardCharsets.UTF_8)
    }
}

/** Server side of the WebSocket transport: reads masked client frames, writes unmasked. */
private class ServerWsTransport(
    private val input: BufferedInputStream,
    private val output: OutputStream,
) : WsTransport {
    override var onOpen: () -> Unit = {}
    override var onText: (String) -> Unit = {}
    override var onClose: (Int, String) -> Unit = { _, _ -> }
    override var onError: (Exception) -> Unit = {}
    private val thread = Thread({ readLoop() }, "fake-agent-ws").apply { isDaemon = true }

    override fun start() {
        // Handshake already completed by the acceptor; the tunnel peer sends
        // its hello on open.
        onOpen()
        thread.start()
    }

    override fun sendText(text: String): Boolean {
        val payload = text.toByteArray(StandardCharsets.UTF_8)
        val header = ByteArray(10)
        header[0] = (0x80 or 0x1).toByte()
        var index = 1
        when {
            payload.size < 126 -> header[index++] = payload.size.toByte()
            payload.size <= 0xFFFF -> {
                header[index++] = 126.toByte()
                header[index++] = (payload.size ushr 8).toByte()
                header[index++] = payload.size.toByte()
            }
            else -> {
                header[index++] = 127.toByte()
                var len = payload.size.toLong()
                for (i in 7 downTo 0) header[index++] = ((len shr (8 * i)) and 0xFF).toByte()
            }
        }
        synchronized(output) {
            output.write(header, 0, index)
            output.write(payload)
            output.flush()
        }
        return true
    }

    override fun close(code: Int, reason: String) {
        runCatching { output.flush() }
    }

    private fun readLoop() {
        try {
            while (true) {
                val byte0 = input.read()
                if (byte0 < 0) return
                val fin = (byte0 and 0x80) != 0
                val opcode = byte0 and 0x0F
                val byte1 = input.read()
                val masked = (byte1 and 0x80) != 0
                var length = (byte1 and 0x7F).toLong()
                if (length == 126L) length = ((input.read() shl 8) or input.read()).toLong()
                else if (length == 127L) {
                    length = 0
                    repeat(8) { length = (length shl 8) or input.read().toLong() }
                }
                val maskKey = if (masked) ByteArray(4).also { readFully(it) } else ByteArray(0)
                val payload = ByteArray(length.toInt())
                readFully(payload)
                if (masked) for (i in payload.indices) {
                    payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
                }
                when (opcode) {
                    0x1 -> if (fin) onText(payload.toString(StandardCharsets.UTF_8))
                    0x8 -> return
                    0x9 -> { /* ping: reply pong */ }
                }
            }
        } catch (error: Exception) {
            onError(error)
        }
    }

    private fun readFully(target: ByteArray) {
        var read = 0
        while (read < target.size) {
            val n = input.read(target, read, target.size - read)
            if (n < 0) throw IllegalStateException("EOF mid-frame")
            read += n
        }
    }
}
