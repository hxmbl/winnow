# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Native Google sign-in. Tauri finds the plugin by class name and calls its commands by
# reflection; proguard-tauri.pro keeps @TauriPlugin / @InvokeArg classes in general, and
# this names ours so a change to those generated rules cannot strip it silently.
-keep class app.winnow.android.signin.GoogleSignInPlugin { *; }
-keep class app.winnow.android.signin.AuthorizeArgs { *; }
-keep class app.winnow.android.signin.OpenTabArgs { *; }
