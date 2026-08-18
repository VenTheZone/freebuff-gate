plugins {
    id("com.android.application") version "8.9.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.21" apply false
}

// Keep Android build tooling clear of known transitive CVEs while retaining
// AGP's compatible plugin version.
buildscript {
    configurations.classpath {
        resolutionStrategy.force(
            "org.bouncycastle:bcpkix-jdk18on:1.80.2",
            "org.bouncycastle:bcprov-jdk18on:1.80.2",
            "org.bouncycastle:bcutil-jdk18on:1.80.2",
            "com.google.protobuf:protobuf-java:3.25.5",
            "com.google.protobuf:protobuf-java-util:3.25.5",
            "commons-io:commons-io:2.16.1",
        )
    }
}
