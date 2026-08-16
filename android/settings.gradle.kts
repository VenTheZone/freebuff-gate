import org.gradle.api.initialization.resolve.RepositoriesMode

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // GeckoView (Firefox engine) stable channel. Used only by the "gecko"
        // product flavor; the default "webview" flavor never resolves it.
        maven("https://maven.mozilla.org/maven2/")
    }
}

rootProject.name = "FreebuffMobile"
include(":app")
