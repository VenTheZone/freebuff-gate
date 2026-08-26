import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val defaultPairingOrigin = providers.gradleProperty("freebuffPairingOrigin")
    .orElse("")
    .get()
    .replace("\"", "")
val defaultWebOrigin = providers.gradleProperty("freebuffWebOrigin")
    .orElse("")
    .get()
    .replace("\"", "")
// The E2E tunnel is a Phase 1 prototype (docs/e2e-tunnel.md): the desktop
// agent does not join the rendezvous yet, so the app must not auto-enter
// tunnel mode on a pairing that happens to carry tunnel credentials. Gate it
// behind an opt-in build flag; the production HTTPS relay path stays default.
val tunnelEnabled = providers.gradleProperty("freebuffTunnelEnabled")
    .orElse("0")
    .get()
    .trim() == "1"

// Release signing. Pass freebuffKeystorePath/Password and freebuffKeyAlias/
// Password to sign with a production keystore (CI injects them from the
// ANDROID_KEYSTORE_* secrets). Without them the release build falls back to
// the debug key so CI and local builds always produce an installable APK.
val freebuffKeystorePath = providers.gradleProperty("freebuffKeystorePath").orNull
val freebuffKeystorePassword = providers.gradleProperty("freebuffKeystorePassword").orNull
val freebuffKeyAlias = providers.gradleProperty("freebuffKeyAlias").orNull
val freebuffKeyPassword = providers.gradleProperty("freebuffKeyPassword").orNull

android {
    namespace = "com.freebuff.mobile"
    compileSdk = 36

    // Two rendering engines share the same activity, pairing flow, and origin
    // guard. "webview" is the default (system Chromium WebView). "gecko" swaps
    // in GeckoView (Firefox engine) via the flavor-scoped source sets and
    // dependency, so a drop-in comparison can be built with
    // `gradle assembleGeckoDebug` without touching the default APK.
    flavorDimensions += "engine"
    productFlavors {
        create("webview") {
            dimension = "engine"
        }
        create("gecko") {
            dimension = "engine"
            // GeckoView ships 4 ABIs; keep phone ABIs only so the spike APK
            // stays usable (arm64-v8a + armeabi-v7a cover real devices).
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    defaultConfig {
        applicationId = "com.freebuff.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 11
        versionName = "0.1.12"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        // A configured HTTPS origin pins production/CI builds; an empty value lets
        // generic test builds bind to the exact HTTPS origin carried by the QR.
        buildConfigField("String", "DEFAULT_WEB_ORIGIN", "\"$defaultWebOrigin\"")
        buildConfigField("String", "DEFAULT_PAIRING_ORIGIN", "\"$defaultPairingOrigin\"")
        buildConfigField("boolean", "TUNNEL_ENABLED", "$tunnelEnabled")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (
                freebuffKeystorePath != null &&
                freebuffKeystorePassword != null &&
                freebuffKeyAlias != null &&
                freebuffKeyPassword != null
            ) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = file(freebuffKeystorePath)
                    storePassword = freebuffKeystorePassword
                    keyAlias = freebuffKeyAlias
                    keyPassword = freebuffKeyPassword
                }
            } else {
                // No production keystore configured: sign with the debug key so
                // the release APK stays installable (CI fallback path).
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("com.google.android.material:material:1.12.0")

    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    // CameraX exposes ListenableFuture in its public API. Newer GeckoView
    // dependency resolution selects the empty compatibility artifact unless
    // Guava is declared explicitly.
    implementation("com.google.guava:guava:33.6.0-android")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    // GeckoView stable channel. Flavor-scoped so default WebView APK stays
    // lean. Update engine with Mozilla security releases.
    "geckoImplementation"("org.mozilla.geckoview:geckoview:153.0.20260810162159")

    // JVM unit tests for the tunnel prototype (pure JVM stack, no device needed).
    testImplementation("junit:junit:4.13.2")

    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
