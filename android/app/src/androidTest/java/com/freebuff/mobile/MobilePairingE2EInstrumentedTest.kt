package com.freebuff.mobile

import android.content.Context
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobilePairingE2EInstrumentedTest {
    @Test
    fun activityClaimsPairingAndLoadsAuthenticatedRelayUi() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixture = readFixture(instrumentation.context)
        assumeTrue("CI relay fixture is not installed", fixture != null)
        val pairingFixture = fixture ?: return

        val appContext = ApplicationProvider.getApplicationContext<Context>()
        SecureSessionStore(appContext).clear()
        instrumentation.runOnMainSync {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        }

        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            val relayOrigin = PairingApi.normalizeBaseUrl(pairingFixture.getString("relayOrigin"))
            val webOrigin = PairingApi.normalizeBaseUrl(pairingFixture.getString("webOrigin"))
            assertEquals(relayOrigin, PairingApi.normalizeBaseUrl(BuildConfig.DEFAULT_PAIRING_ORIGIN))
            assertEquals(webOrigin, PairingApi.normalizeBaseUrl(BuildConfig.DEFAULT_WEB_ORIGIN))

            scenario.onActivity { activity ->
                activity.findViewById<EditText>(R.id.pairingUrlInput)
                    .setText(pairingFixture.getString("pairingUrl"))
                activity.findViewById<EditText>(R.id.confirmationCodeInput)
                    .setText(pairingFixture.getString("manualCode"))
                activity.findViewById<Button>(R.id.pairButton).performClick()
            }

            assertTrue(
                "Android app did not load relay UI",
                waitForRelayPage(scenario, webOrigin),
            )
        } finally {
            scenario.close()
            SecureSessionStore(appContext).clear()
        }
    }

    private fun readFixture(testContext: Context): JSONObject? {
        val assetName = "e2e-pairing.json"
        if (!testContext.assets.list("").orEmpty().contains(assetName)) return null
        return testContext.assets.open(assetName).bufferedReader().use { JSONObject(it.readText()) }
    }

    private fun waitForRelayPage(
        scenario: ActivityScenario<MainActivity>,
        expectedOrigin: String,
        timeoutMs: Long = 45_000L,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            var ready = false
            scenario.onActivity { activity ->
                val webView = activity.findViewById<WebView>(R.id.webView)
                ready = webView.visibility == View.VISIBLE &&
                    webView.url?.startsWith(expectedOrigin) == true &&
                    webView.title == "Freebuff E2E Ready"
            }
            if (ready) return true
            Thread.sleep(250)
        }
        return false
    }
}
