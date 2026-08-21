# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# ─── OkHttp (used by expo-download-manager for multi-GB downloads) ───
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }
-keep class okio.** { *; }

# ─── kotlinx-coroutines (used by both custom modules) ───
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
-keep class kotlinx.coroutines.android.** { *; }

# ─── Custom Expo native modules ───
-keep class expo.modules.downloadmanager.** { *; }
-keep class expo.modules.stablediffusion.** { *; }

# ─── Expo modules core (module discovery / reflection) ───
-keep class expo.modules.kotlin.** { *; }
-keepclassmembers class * extends expo.modules.kotlin.modules.Module {
    public <methods>;
}
