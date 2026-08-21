package expo.modules.stablediffusion

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipFile

/**
 * Resolves native binary executables for both subprocess engines.
 *
 * On debug builds (npx expo run:android), extractNativeLibs=true ensures
 * the .so files are extracted to nativeLibraryDir with execute permission.
 *
 * On Play Store AAB builds, this may NOT happen — the binaries can be
 * compressed inside the APK and loaded via mmap for System.loadLibrary,
 * but NOT executable via ProcessBuilder.
 *
 * This resolver tries nativeLibraryDir first, then falls back to
 * extracting from the APK into the app's private filesDir (which has
 * execute permission on Android 10+ for app-owned files).
 */
internal object BinaryResolver {

  private const val TAG = "BinaryResolver"

  /**
   * Find or extract a binary by name. Returns the executable File.
   * Throws if the binary can't be found or extracted.
   */
  fun resolve(context: Context, binaryName: String): File {
    // 1. Check nativeLibraryDir (works with extractNativeLibs=true)
    val nativeDir = context.applicationInfo.nativeLibraryDir
    val nativeBinary = File(nativeDir, binaryName)
    if (nativeBinary.exists() && nativeBinary.canExecute()) {
      Log.d(TAG, "Found $binaryName in nativeLibraryDir: ${nativeBinary.absolutePath}")
      return nativeBinary
    }

    // 2. Check if we already extracted it previously
    val extractDir = File(context.filesDir, "native_bin")
    val extractedBinary = File(extractDir, binaryName)
    val apkFile = File(context.applicationInfo.sourceDir)

    if (extractedBinary.exists() &&
        extractedBinary.canExecute() &&
        extractedBinary.lastModified() >= apkFile.lastModified()) {
      Log.d(TAG, "Found cached $binaryName: ${extractedBinary.absolutePath}")
      return extractedBinary
    }

    // 3. Extract from APK (or split APKs for Play Store AAB installs)
    Log.i(TAG, "Extracting $binaryName from APK...")
    extractDir.mkdirs()

    val entryPath = "lib/arm64-v8a/$binaryName"

    // On Play Store AAB installs, native libs may be in a split APK
    // (e.g. split_config.arm64_v8a.apk) rather than the base APK.
    // Check all APKs: base first, then splits.
    val apkPaths = mutableListOf(apkFile.absolutePath)
    context.applicationInfo.splitSourceDirs?.let { splits ->
      apkPaths.addAll(splits)
    }

    var extracted = false
    for (apkPath in apkPaths) {
      try {
        val zip = ZipFile(File(apkPath))
        val entry = zip.getEntry(entryPath)
        if (entry != null) {
          Log.i(TAG, "Found $binaryName in ${File(apkPath).name}")
          zip.getInputStream(entry).use { input ->
            FileOutputStream(extractedBinary).use { output ->
              input.copyTo(output, bufferSize = 256 * 1024)
            }
          }
          zip.close()
          extracted = true
          break
        }
        zip.close()
      } catch (t: Throwable) {
        Log.w(TAG, "Failed to check ${File(apkPath).name}: ${t.message}")
      }
    }

    if (!extracted) {
      // Also check assets/qnnlibs/ as a last-resort fallback (matching
      // the reference project's dual-redundancy pattern)
      try {
        context.assets.open("qnnlibs/$binaryName").use { input ->
          FileOutputStream(extractedBinary).use { output ->
            input.copyTo(output, bufferSize = 256 * 1024)
          }
        }
        Log.i(TAG, "Extracted $binaryName from assets/qnnlibs/")
        extracted = true
      } catch (_: Throwable) {
        // Not in assets either
      }
    }

    if (!extracted) {
      val baseAbis = try { listApkAbis(ZipFile(apkFile)) } catch (_: Throwable) { emptyList() }
      throw IllegalStateException(
        "$binaryName not found in any APK or assets. " +
          "Base APK ABIs: ${baseAbis.joinToString()}. " +
          "Split APKs: ${(context.applicationInfo.splitSourceDirs?.size ?: 0)}"
      )
    }

    // Set execute permission
    if (!extractedBinary.setExecutable(true, false)) {
      Log.w(TAG, "setExecutable returned false for $binaryName")
    }

    if (!extractedBinary.canExecute()) {
      throw IllegalStateException(
        "$binaryName extracted but not executable at ${extractedBinary.absolutePath}"
      )
    }

    Log.i(TAG, "Extracted $binaryName: ${extractedBinary.length()} bytes, exec=${extractedBinary.canExecute()}")
    return extractedBinary
  }

  /**
   * Check if a binary exists in the APK (without extracting).
   */
  fun existsInApk(context: Context, binaryName: String): Boolean {
    val entryPath = "lib/arm64-v8a/$binaryName"
    // Check base APK and all split APKs (Play Store AAB installs)
    val apkPaths = mutableListOf(context.applicationInfo.sourceDir)
    context.applicationInfo.splitSourceDirs?.let { apkPaths.addAll(it) }
    for (apkPath in apkPaths) {
      try {
        val zipFile = ZipFile(File(apkPath))
        val exists = zipFile.getEntry(entryPath) != null
        zipFile.close()
        if (exists) return true
      } catch (t: Throwable) {
        Log.w(TAG, "Failed to check ${File(apkPath).name} for $binaryName: ${t.message}")
      }
    }
    return false
  }

  /**
   * Get the LD_LIBRARY_PATH that includes wherever the binary was resolved to.
   * This ensures the dynamic linker finds companion .so files.
   */
  fun getLibraryPath(context: Context, binaryFile: File): String {
    val paths = mutableListOf<String>()
    // The directory containing the binary itself
    binaryFile.parentFile?.absolutePath?.let { paths.add(it) }
    // Standard Android native lib paths
    paths.add(context.applicationInfo.nativeLibraryDir)
    paths.add("/system/lib64")
    paths.add("/vendor/lib64")
    paths.add("/vendor/lib64/egl")
    return paths.joinToString(":")
  }

  private fun listApkAbis(zipFile: ZipFile): List<String> {
    val abis = mutableSetOf<String>()
    val entries = zipFile.entries()
    while (entries.hasMoreElements()) {
      val entry = entries.nextElement()
      if (entry.name.startsWith("lib/") && entry.name.endsWith(".so")) {
        val parts = entry.name.split("/")
        if (parts.size >= 3) abis.add(parts[1])
      }
    }
    return abis.toList()
  }
}
