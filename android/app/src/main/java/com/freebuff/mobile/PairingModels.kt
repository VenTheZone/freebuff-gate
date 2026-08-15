package com.freebuff.mobile

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** Data carried in the QR URL fragment. Never log this object: token is a bearer secret. */
data class PairingPayload(
    val baseUrl: String,
    val pairingId: String,
    val token: String,
) {
    companion object {
        fun parse(raw: String): PairingPayload {
            val uri = URI(raw.trim())
            require(uri.scheme.equals("https", ignoreCase = true)) {
                "Pairing URL must use HTTPS"
            }
            require(uri.userInfo == null && !uri.host.isNullOrBlank()) {
                "Pairing URL must have a normal HTTPS host"
            }

            val fragment = uri.rawFragment ?: throw IllegalArgumentException("Pairing URL has no token fragment")
            val values = fragment.split('&')
                .filter { it.isNotBlank() }
                .associate { part ->
                    val pieces = part.split('=', limit = 2)
                    val key = URLDecoder.decode(pieces[0], StandardCharsets.UTF_8.name())
                    val value = URLDecoder.decode(pieces.getOrElse(1) { "" }, StandardCharsets.UTF_8.name())
                    key to value
                }

            val pairingId = values["pairingId"].orEmpty()
            val token = values["token"].orEmpty()
            require(pairingId.isNotBlank() && token.isNotBlank()) {
                "Pairing URL fragment is incomplete"
            }

            return PairingPayload(
                baseUrl = "${uri.scheme.lowercase()}://${uri.rawAuthority.lowercase()}",
                pairingId = pairingId,
                token = token,
            )
        }
    }
}

data class PairingSession(
    val gatewayBaseUrl: String,
    val deviceId: String,
    val deviceToken: String,
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val deviceExpiresAt: String,
    val relayUrl: String?,
    val uiUrl: String?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("gatewayBaseUrl", gatewayBaseUrl)
        .put("deviceId", deviceId)
        .put("deviceToken", deviceToken)
        .put("accessToken", accessToken)
        .put("accessTokenExpiresAt", accessTokenExpiresAt)
        .put("deviceExpiresAt", deviceExpiresAt)
        .putNullable("relayUrl", relayUrl)
        .putNullable("uiUrl", uiUrl)

    companion object {
        fun fromGatewayResponse(baseUrl: String, json: JSONObject): PairingSession {
            return PairingSession(
                gatewayBaseUrl = baseUrl,
                deviceId = json.requiredString("deviceId"),
                deviceToken = json.requiredString("deviceToken"),
                accessToken = json.requiredString("accessToken"),
                accessTokenExpiresAt = json.requiredString("accessTokenExpiresAt"),
                deviceExpiresAt = json.requiredString("deviceExpiresAt"),
                relayUrl = json.optionalString("relayUrl"),
                uiUrl = json.optionalString("uiUrl"),
            )
        }

        fun fromStoredJson(json: JSONObject): PairingSession {
            return PairingSession(
                gatewayBaseUrl = json.requiredString("gatewayBaseUrl"),
                deviceId = json.requiredString("deviceId"),
                deviceToken = json.requiredString("deviceToken"),
                accessToken = json.requiredString("accessToken"),
                accessTokenExpiresAt = json.requiredString("accessTokenExpiresAt"),
                deviceExpiresAt = json.requiredString("deviceExpiresAt"),
                relayUrl = json.optionalString("relayUrl"),
                uiUrl = json.optionalString("uiUrl"),
            )
        }
    }
}

enum class ConnectionState {
    UNPAIRED,
    PAIRING,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    OFFLINE,
    PAIRING_REQUIRED,
    REVOKED,
    DISCONNECTED,
    ERROR,
}

private fun JSONObject.requiredString(name: String): String {
    val value = optString(name, "").trim()
    require(value.isNotEmpty()) { "Gateway response missing $name" }
    return value
}

private fun JSONObject.optionalString(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return optString(name).trim().takeIf { it.isNotEmpty() }
}

private fun JSONObject.putNullable(name: String, value: String?): JSONObject {
    return if (value == null) put(name, JSONObject.NULL) else put(name, value)
}
