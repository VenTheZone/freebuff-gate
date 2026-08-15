package com.freebuff.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec

class DeviceIdentity {
    private val keyAlias = "freebuff-mobile-device"

    fun publicKeyForPairing(): String {
        val keyPair = loadOrCreateKeyPair()
        return Base64.encodeToString(
            keyPair.public.encoded,
            Base64.NO_WRAP or Base64.URL_SAFE,
        )
    }

    private fun loadOrCreateKeyPair(): KeyPair {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getCertificate(keyAlias)?.publicKey
        val privateKey = keyStore.getKey(keyAlias, null) as? java.security.PrivateKey
        if (existing != null && privateKey != null) {
            return KeyPair(existing, privateKey)
        }

        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            "AndroidKeyStore",
        )
        generator.initialize(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKeyPair()
    }
}
