package com.freebuff.mobile

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets

class PairingApi(rawBaseUrl: String) {
    private val baseUrl = normalizeBaseUrl(rawBaseUrl)

    fun claim(
        payload: PairingPayload,
        manualCode: String,
        deviceName: String,
        devicePublicKey: String,
    ): PairingSession {
        require(payload.baseUrl == baseUrl) { "Pairing payload endpoint changed" }
        val request = JSONObject()
            .put("pairingId", payload.pairingId)
            .put("token", payload.token)
            .put("manualCode", manualCode.trim())
            .put("deviceName", deviceName.trim())
            .put("devicePublicKey", devicePublicKey)
        return PairingSession.fromGatewayResponse(baseUrl, post("/v1/pairings/claim", request))
    }

    fun refresh(session: PairingSession): PairingSession {
        require(session.gatewayBaseUrl == baseUrl) { "Session endpoint changed" }
        val request = JSONObject()
            .put("deviceId", session.deviceId)
            .put("deviceToken", session.deviceToken)
        return PairingSession.fromGatewayResponse(
            baseUrl,
            post("/v1/sessions/refresh", request),
            deviceTokenOverride = session.deviceToken,
            deviceExpiresAtOverride = session.deviceExpiresAt,
        )
    }

    /**
     * Exchanges short-lived access token for relay-owned Secure/HttpOnly cookie.
     * Cookie is returned to native code and must be installed into WebView's
     * CookieManager; access token is never injected into page JavaScript.
     */
    fun establishWebSession(webBaseUrl: String, accessToken: String): String {
        val webOrigin = normalizeBaseUrl(webBaseUrl)
        val result = request(
            baseUrl = webOrigin,
            path = "/v1/mobile/session",
            method = "GET",
            body = null,
            headers = mapOf("Authorization" to "Bearer $accessToken"),
        )
        val cookie = result.setCookie
        require(!cookie.isNullOrBlank()) { "Relay did not return a session cookie" }
        return cookie
    }

    private fun post(path: String, body: JSONObject): JSONObject {
        return request(baseUrl, path, "POST", body, emptyMap()).json
    }

    private data class HttpResult(
        val json: JSONObject,
        val setCookie: String?,
    )

    private fun request(
        baseUrl: String,
        path: String,
        method: String,
        body: JSONObject?,
        headers: Map<String, String>,
    ): HttpResult {
        val connection = (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            doInput = true
            doOutput = body != null
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Cache-Control", "no-store")
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
        }

        try {
            if (body != null) {
                val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            val response = runCatching { JSONObject(responseText) }.getOrElse { JSONObject() }
            if (status !in 200..299) {
                throw GatewayApiException(
                    status = status,
                    message = response.optString("message", "Gateway request failed"),
                )
            }
            val setCookie = connection.headerFields.entries
                .firstOrNull { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                ?.value
                ?.firstOrNull()
            return HttpResult(response, setCookie)
        } catch (error: GatewayApiException) {
            throw error
        } catch (error: IOException) {
            throw error
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        fun normalizeBaseUrl(raw: String): String {
            val uri = URI(raw.trim())
            require(uri.scheme.equals("https", ignoreCase = true)) {
                "Gateway endpoint must use HTTPS"
            }
            require(uri.userInfo == null && !uri.host.isNullOrBlank()) {
                "Gateway endpoint must not contain credentials"
            }
            return "${uri.scheme.lowercase()}://${uri.rawAuthority.lowercase()}".trimEnd('/')
        }
    }
}

class GatewayApiException(
    val status: Int,
    override val message: String,
) : IOException(message)
