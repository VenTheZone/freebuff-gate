package com.freebuff.mobile.tunnel

import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.Volatile

/**
 * Kotlin mirror of the Node `TunnelPeer` in `src/mobile-connect-tunnel.js`.
 *
 * Wire-compatible with the Node side: two peers rendezvous through the relay's
 * blind /v1/tunnel endpoint, exchange ephemeral X25519 public keys as
 * `tunnel.hello`, derive per-direction AES-256-GCM keys from the shared secret
 * plus the rendezvous token via HKDF-SHA256, and confirm with an encrypted
 * `tunnel.confirm` frame. Application JSON messages then ride as `tunnel.frame`
 * (nonce `n`, ciphertext `c` — base64).
 *
 * PROTOTYPE NOTE: like the Node side, the key agreement is ECDH + token-mixed
 * KDF (EKE-lite), NOT SPAKE2. The design doc (docs/e2e-tunnel.md §5.3) calls
 * for SPAKE2 (RFC 9382) before production; the framing and bridge here stay
 * unchanged when that lands.
 */
class TunnelPeer(
    url: String,
    private val token: String,
    private val role: String, // 'mobile' or 'agent'
    private val onReady: () -> Unit,
    onMessage: (Map<String, Any?>) -> Unit,
    private val onClose: (Int, String) -> Unit,
    private val onError: (Exception) -> Unit,
    private val transport: WsTransport? = null,
) {
    private val wsUrl = normalizeWsUrl(url)
    private var keyPair: KeyPair? = null
    private var peerEph: ByteArray? = null
    private var sendKey: ByteArray? = null
    private var recvKey: ByteArray? = null
    private var sentConfirm = false
    private var confirmReceived = false

    @Volatile
    var ready: Boolean = false
        private set
    @Volatile
    var closed: Boolean = false
        private set

    // Reassignable so the loopback proxy can register itself as the message
    // sink (mirrors the Node peer.onMessage assignment).
    var onMessage: (Map<String, Any?>) -> Unit = onMessage

    private var ws: WsTransport? = null

    fun start(): TunnelPeer {
        val client = transport ?: WsClient(wsUrl, { _ -> }, { _, _ -> }, { _ -> })
        client.onOpen = { sendHello() }
        client.onText = { text -> handleText(text) }
        client.onClose = { code, reason ->
            closed = true
            onClose(code, reason)
        }
        client.onError = { error -> fail(error.message ?: "WebSocket error") }
        ws = client
        client.start()
        return this
    }

    private fun sendHello() {
        if (closed) return
        val pair = generateKeyPair()
        keyPair = pair
        val hello = mapOf(
            "type" to "tunnel.hello",
            "role" to role,
            "protocol" to TUNNEL_PROTOCOL,
            "eph" to Base64.getEncoder().encodeToString(pair.public.encoded),
        )
        ws?.sendText(SimpleJson.stringify(hello))
    }

    fun send(message: Map<String, Any?>): Boolean {
        if (!ready || sendKey == null || closed) return false
        val plaintext = SimpleJson.stringify(message).toByteArray(Charsets.UTF_8)
        val (nonce, body) = seal(sendKey!!, plaintext)
        return sendFrame(nonce, body)
    }

    fun close(code: Int = 1000, reason: String = "") {
        closed = true
        ws?.close(code, reason)
    }

    internal fun handleText(text: String) {
        val message = try {
            SimpleJson.parseObject(text)
        } catch (error: Exception) {
            fail("relay sent a non-JSON frame: ${error.message}")
            return
        }
        when (SimpleJson.string(message["type"])) {
            "tunnel.hello" -> {
                val eph = message["eph"] ?: run {
                    fail("hello missing ephemeral key")
                    return
                }
                peerEph = try {
                    Base64.getDecoder().decode(SimpleJson.string(eph))
                } catch (error: Exception) {
                    fail("hello ephemeral key is not base64")
                    return
                }
                tryDerive()
            }
            "tunnel.frame" -> {
                if (recvKey == null) {
                    fail("encrypted frame before handshake completed")
                    return
                }
                val plain = try {
                    open(
                        recvKey!!,
                        Base64.getDecoder().decode(SimpleJson.string(message["n"])),
                        Base64.getDecoder().decode(SimpleJson.string(message["c"])),
                    )
                } catch (error: Exception) {
                    fail("decrypt failed: ${error.message}")
                    return
                }
                val parsed = try {
                    SimpleJson.parseObject(plain.toString(Charsets.UTF_8))
                } catch (error: Exception) {
                    fail("decrypted payload is not JSON")
                    return
                }
                if (!ready && SimpleJson.string(parsed["type"]) == "tunnel.confirm") {
                    confirmReceived = true
                    maybeReady()
                    return
                }
                if (!ready) {
                    fail("application message before confirm")
                    return
                }
                onMessage(parsed)
            }
            else -> fail("unexpected message type: ${message["type"]}")
        }
    }

    private fun tryDerive() {
        val pair = keyPair ?: return
        val peer = peerEph ?: return
        if (sendKey != null) return
        val shared: ByteArray = try {
            val keyAgreement = KeyAgreement.getInstance("X25519")
            keyAgreement.init(pair.private)
            keyAgreement.doPhase(peerPublicKey(peer), true)
            // Android's KeyAgreement.doPhase returns the intermediate Key (not
            // the byte[] some desktop JDKs return); generateSecret() yields the
            // shared secret on both platforms.
            keyAgreement.generateSecret()
        } catch (error: Exception) {
            fail("key agreement failed: ${error.message}")
            return
        }
        val (m2a, a2m) = deriveKeys(shared, token)
        sendKey = if (role == "agent") a2m else m2a
        recvKey = if (role == "agent") m2a else a2m
        val confirm = SimpleJson.stringify(mapOf("type" to "tunnel.confirm", "protocol" to TUNNEL_PROTOCOL))
            .toByteArray(Charsets.UTF_8)
        val (nonce, body) = seal(sendKey!!, confirm)
        sendFrame(nonce, body)
        sentConfirm = true
        maybeReady()
    }

    private fun maybeReady() {
        if (!ready && sentConfirm && confirmReceived) {
            ready = true
            onReady()
        }
    }

    private fun sendFrame(nonce: ByteArray, body: ByteArray): Boolean {
        val ws = ws ?: return false
        val frame = mapOf(
            "type" to "tunnel.frame",
            "n" to Base64.getEncoder().encodeToString(nonce),
            "c" to Base64.getEncoder().encodeToString(body),
        )
        return ws.sendText(SimpleJson.stringify(frame))
    }

    private fun fail(reason: String) {
        onError(IllegalStateException(reason))
        close(4002, reason)
    }

    companion object {
        const val TUNNEL_PROTOCOL = "fb-tunnel-v0"

        fun normalizeWsUrl(raw: String): String {
            val parsed = java.net.URI(raw)
            val scheme = parsed.scheme?.lowercase()
            require(scheme == "wss" || scheme == "ws") { "Tunnel URL must use WSS/WS" }
            return raw.trimEnd('/')
        }

        fun generateKeyPair(): KeyPair {
            return KeyPairGenerator.getInstance("X25519").generateKeyPair()
        }

        fun peerPublicKey(der: ByteArray): java.security.PublicKey {
            return KeyFactory.getInstance("X25519").generatePublic(X509EncodedKeySpec(der))
        }

        /**
         * Matches the Node `deriveKeys(sharedSecret, token)`:
         * ikm = sharedSecret || token, salt = "freebuff-gate-tunnel-v0",
         * HKDF-SHA256 expand with info "m2a"/"a2m", 32 bytes each.
         */
        fun deriveKeys(sharedSecret: ByteArray, token: String): Pair<ByteArray, ByteArray> {
            val ikm = sharedSecret + token.toByteArray(Charsets.UTF_8)
            val salt = "freebuff-gate-tunnel-v0".toByteArray(Charsets.UTF_8)
            val m2a = hkdf(ikm, salt, "m2a".toByteArray(Charsets.UTF_8), 32)
            val a2m = hkdf(ikm, salt, "a2m".toByteArray(Charsets.UTF_8), 32)
            return m2a to a2m
        }

        /** RFC 5869 HKDF (extract + expand), matching Node's hkdfSync. */
        fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(salt, "HmacSHA256"))
            val prk = mac.doFinal(ikm)
            var block = ByteArray(0)
            val output = ByteArrayOutputStream()
            var counter = 1
            while (output.size() < length) {
                mac.init(SecretKeySpec(prk, "HmacSHA256"))
                mac.update(block)
                mac.update(info)
                mac.update(counter.toByte())
                block = mac.doFinal()
                output.write(block)
                counter++
            }
            return output.toByteArray().copyOf(length)
        }

        /** AES-256-GCM seal: 12-byte random nonce, body = ciphertext || tag. */
        fun seal(key: ByteArray, plaintext: ByteArray): Pair<ByteArray, ByteArray> {
            val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            val body = cipher.doFinal(plaintext)
            return nonce to body
        }

        /** AES-256-GCM open: body is ciphertext || tag (Java GCM appends the tag). */
        fun open(key: ByteArray, nonce: ByteArray, body: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
            return cipher.doFinal(body)
        }
    }
}
