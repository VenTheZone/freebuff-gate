package com.freebuff.mobile

import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RestrictedWebViewInstrumentedTest {
    @Test
    fun webViewAllowsOnlyConfiguredHttpsOrigin() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        lateinit var webView: WebView
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView = WebView(context)
        }

        val blocked = mutableListOf<String>()
        val client = RestrictedWebViewClient("https://mobile.example.test") {
            blocked += it
        }

        try {
            assertFalse(
                client.shouldOverrideUrlLoading(
                    webView,
                    "https://mobile.example.test/thread/123",
                ),
            )
            assertTrue(
                client.shouldOverrideUrlLoading(
                    webView,
                    "https://evil.example.test/thread/123",
                ),
            )
            assertTrue(
                client.shouldOverrideUrlLoading(
                    webView,
                    "http://mobile.example.test/thread/123",
                ),
            )
            assertEquals(2, blocked.size)
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                webView.destroy()
            }
        }
    }

    private fun assertEquals(expected: Int, actual: Int) {
        org.junit.Assert.assertEquals(expected, actual)
    }
}
