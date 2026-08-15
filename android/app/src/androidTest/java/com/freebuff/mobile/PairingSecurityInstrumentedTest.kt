package com.freebuff.mobile

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.json.JSONObject
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingSecurityInstrumentedTest {
    private lateinit var context: Context
    private lateinit var sessionStore: SecureSessionStore

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        sessionStore = SecureSessionStore(context)
        sessionStore.clear()
    }

    @After
    fun tearDown() {
        sessionStore.clear()
    }

    @Test
    fun pairingPayloadReadsFragmentTokenWithoutQueryCredential() {
        val payload = PairingPayload.parse(
            "https://mobile.example.test/pair#pairingId=p_test&token=one-time-token",
        )

        assertEquals("https://mobile.example.test", payload.baseUrl)
        assertEquals("p_test", payload.pairingId)
        assertEquals("one-time-token", payload.token)
    }

    @Test
    fun pairingPayloadRejectsNonHttpsEndpoint() {
        try {
            PairingPayload.parse("http://mobile.example.test/pair#pairingId=p&token=t")
            throw AssertionError("HTTP pairing URL should be rejected")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("HTTPS"))
        }
    }

    @Test
    fun deviceIdentityIsKeystoreBackedAndStable() {
        val identity = DeviceIdentity()
        val first = identity.publicKeyForPairing()
        val second = identity.publicKeyForPairing()

        assertEquals(first, second)
        assertTrue(
            Base64.decode(first, Base64.NO_WRAP or Base64.URL_SAFE).isNotEmpty(),
        )
    }

    @Test
    fun refreshResponseReusesStoredDeviceTokenWhenGatewayOmitsIt() {
        val response = JSONObject()
            .put("deviceId", "d_test")
            .put("accessToken", "refreshed-access-token")
            .put("accessTokenExpiresAt", "2026-08-15T12:00:00Z")
            .put("deviceExpiresAt", "2026-11-13T12:00:00Z")
            .put("relayUrl", "wss://mobile.example.test")
            .put("uiUrl", "https://mobile.example.test")

        val refreshed = PairingSession.fromGatewayResponse(
            "https://mobile.example.test",
            response,
            deviceTokenOverride = "stored-device-token",
        )

        assertEquals("stored-device-token", refreshed.deviceToken)
        assertEquals("refreshed-access-token", refreshed.accessToken)
    }

    @Test
    fun sessionStoreRoundTripsEncryptedSessionAndClearsIt() {
        val original = PairingSession(
            gatewayBaseUrl = "https://mobile.example.test",
            deviceId = "d_test",
            deviceToken = "device-token",
            accessToken = "access-token",
            accessTokenExpiresAt = "2026-08-15T12:00:00Z",
            deviceExpiresAt = "2026-11-13T12:00:00Z",
            relayUrl = "wss://mobile.example.test",
            uiUrl = "https://mobile.example.test",
        )

        sessionStore.save(original)
        assertNotNull(sessionStore.load())
        assertEquals(original, sessionStore.load())

        sessionStore.clear()
        assertNull(sessionStore.load())
    }
}
