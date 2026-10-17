import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing: never from a value or a keystore committed to the repo.
//
// CI sets ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and
// ANDROID_KEY_PASSWORD from repository secrets. A local build can instead use an
// untracked gen/android/keystore.properties, the layout Tauri's docs suggest:
//
//   storeFile=/absolute/path/to/winnow-release.jks
//   password=<keystore password>
//   keyAlias=winnow
//   keyPassword=<key password; optional, defaults to password>
//
// The environment wins over the file. All four values present: the release build
// is signed with that keystore, and every later release must use the same one or
// Android refuses the update. Any missing: the release build is signed with the
// local debug key instead, so it still installs; CI names that APK `-debug`.
// See native/README.md, "Android signing".
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
fun signingValue(env: String, property: String): String? =
    System.getenv(env)?.takeIf { it.isNotEmpty() }
        ?: keystoreProperties.getProperty(property)?.takeIf { it.isNotEmpty() }

val releaseKeystore: String? = signingValue("ANDROID_KEYSTORE_PATH", "storeFile")?.takeIf { it.isNotBlank() }
val releaseKeystorePassword: String? = signingValue("ANDROID_KEYSTORE_PASSWORD", "password")
val releaseKeyAlias: String? = signingValue("ANDROID_KEY_ALIAS", "keyAlias")?.takeIf { it.isNotBlank() }
val releaseKeyPassword: String? = signingValue("ANDROID_KEY_PASSWORD", "keyPassword") ?: releaseKeystorePassword
val hasReleaseSigning = releaseKeystore != null && releaseKeystorePassword != null &&
    releaseKeyAlias != null && releaseKeyPassword != null

android {
    compileSdk = 37
    namespace = "app.winnow.android"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.winnow.android"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystore!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("Winnow: no release keystore configured; signing the release build with the debug key.")
                signingConfigs.getByName("debug")
            }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
