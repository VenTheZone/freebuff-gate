package com.freebuff.mobile

import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Network-free smoke test for the published (generic) debug APK. The full
 * TLS pairing + gateway UI E2E cannot run against the generic build on the
 * API 35 emulator: its trust store lives in the immutable conscrypt APEX,
 * so no CI relay certificate can be injected. This test instead verifies
 * the exact uploaded artifact installs, boots, renders the pairing screen,
 * and has the WebView engine wired into the activity.
 */
@RunWith(AndroidJUnit4::class)
class ReleaseArtifactSmokeInstrumentedTest {
    @Test
    fun releaseArtifactLaunchesPairingScreenWithEngineAttached() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val pairingInput = activity.findViewById<EditText>(R.id.pairingUrlInput)
                val deviceNameInput = activity.findViewById<EditText>(R.id.deviceNameInput)
                val pairButton = activity.findViewById<Button>(R.id.pairButton)
                val browserHost = activity.findViewById<FrameLayout>(R.id.browserHost)

                assertNotNull("pairing URL input must render", pairingInput)
                assertNotNull("device name input must render", deviceNameInput)
                assertNotNull("pair button must render", pairButton)

                assertEquals(
                    "browser engine view must be attached",
                    1,
                    browserHost.childCount,
                )
                val engineView = browserHost.getChildAt(0)
                assertTrue(
                    "browser engine view must be a WebView",
                    engineView is WebView,
                )
                assertTrue(
                    "browser engine view must be visible",
                    engineView.visibility == android.view.View.VISIBLE,
                )
            }
        }
    }
}
