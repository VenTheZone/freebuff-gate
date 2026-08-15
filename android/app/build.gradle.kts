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

android {
    namespace = "com.freebuff.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.freebuff.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.1.4"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        // A configured HTTPS origin pins production/CI builds; an empty value lets
        // generic test builds bind to the exact HTTPS origin carried by the QR.
        buildConfigField("String", "DEFAULT_WEB_ORIGIN", "\"$defaultWebOrigin\"")
        buildConfigField("String", "DEFAULT_PAIRING_ORIGIN", "\"$defaultPairingOrigin\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
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
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
