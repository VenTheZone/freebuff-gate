package com.freebuff.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("freebuff_secure_session", Context.MODE_PRIVATE)
    private val keyAlias = "freebuff-mobile-session"

    fun save(session: PairingSession) {
        val key = loadOrCreateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val encrypted = cipher.doFinal(session.toJson().toString().toByteArray(StandardCharsets.UTF_8))
        val value = listOf(
            encode(cipher.iv),
            encode(encrypted),
        ).joinToString(".")
        preferences.edit().putString(SESSION_KEY, value).apply()
    }

    fun load(): PairingSession? {
        val value = preferences.getString(SESSION_KEY, null) ?: return null
        return try {
            val pieces = value.split('.', limit = 2)
            require(pieces.size == 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                loadOrCreateKey(),
                GCMParameterSpec(128, decode(pieces[0])),
            )
            val json = JSONObject(String(cipher.doFinal(decode(pieces[1])), StandardCharsets.UTF_8))
            PairingSession.fromStoredJson(json)
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun clear() {
        preferences.edit().remove(SESSION_KEY).apply()
    }

    private fun loadOrCreateKey(): SecretKey {
        val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(keyAlias, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore",
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encode(bytes: ByteArray): String = Base64.encodeToString(
        bytes,
        Base64.NO_WRAP or Base64.URL_SAFE,
    )

    private fun decode(value: String): ByteArray = Base64.decode(
        value,
        Base64.NO_WRAP or Base64.URL_SAFE,
    )

    private companion object {
        const val SESSION_KEY = "encrypted-pairing-session"
    }
}
