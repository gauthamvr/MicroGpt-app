package expo.modules.stablediffusion

import android.content.Context
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Expo bridge for on-device Stable Diffusion image generation.
 *
 * Supports TWO inference engines:
 *
 * 1. **local-dream** (MNN/QNN) — fast GPU/NPU path for MNN-format models.
 *    Uses Adreno OpenCL for GPU (~15-30s) or Qualcomm QNN for NPU (~5-10s).
 *    Models: ~1.2 GB each from xororz/sd-mnn and xororz/sd-qnn.
 *
 * 2. **sd.cpp** (CPU) — wide model support for GGUF/safetensors.
 *    Supports SD1.5, SDXL, SD3, Flux, any model sd.cpp can load.
 *    Slower (~3 min at 256x256) but the most flexible.
 *
 * The engine is chosen based on the model format:
 *   - Directory with clip.mnn + unet.mnn → local-dream
 *   - Single .gguf or .safetensors file → sd.cpp
 */
class ExpoStableDiffusionModule : Module() {

  companion object {
    private const val TAG = "ExpoStableDiffusion"

    /**
     * Recursively search [dir] and its subdirectories (up to [maxDepth]
     * levels) for a directory that contains [markerFile] (e.g. "unet.mnn"
     * or "unet.bin"). Returns the directory that contains the marker, or
     * null if not found.
     *
     * This handles both single-nested MNN zips (AbsoluteReality/unet.mnn)
     * and double-nested QNN zips (output_512/qnn_models_min/unet.bin).
     */
    fun resolveModelDir(dir: java.io.File, markerFile: String, maxDepth: Int = 3): java.io.File? {
      if (java.io.File(dir, markerFile).exists()) return dir
      if (maxDepth <= 0) return null
      dir.listFiles()?.filter { it.isDirectory }?.forEach { sub ->
        val found = resolveModelDir(sub, markerFile, maxDepth - 1)
        if (found != null) return found
      }
      return null
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val opMutex = Mutex()
  private var sdServer: SdServerProcess? = null
  private var localDream: LocalDreamProcess? = null
  private var activeEngine: String? = null // "sdcpp" or "localdream"

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ExpoStableDiffusion")

    Events("onGenerationProgress", "onGenerationError")

    Function("hello") {
      try {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val sdInNative = java.io.File(nativeDir, "libsd-server.so").exists()
        val ldInNative = java.io.File(nativeDir, "libstable_diffusion_core.so").exists()
        val sdInApk = BinaryResolver.existsInApk(context, "libsd-server.so")
        val ldInApk = BinaryResolver.existsInApk(context, "libstable_diffusion_core.so")

        val qnnVariant = LocalDreamProcess(context).detectQnnVariant()
        val soc = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else "unknown"

        buildString {
          append("ready")
          append(" sd-server=${if (sdInNative || sdInApk) "yes" else "no"}")
          append(" local-dream=${if (ldInNative || ldInApk) "yes" else "no"}")
          append(" soc=$soc")
          append(" qnn=${qnnVariant ?: "unsupported"}")
          if (!sdInNative && sdInApk) append(" sd-needs-extract")
          if (!ldInNative && ldInApk) append(" ld-needs-extract")
        }
      } catch (t: Throwable) {
        "error: ${t.message ?: t.javaClass.simpleName}"
      }
    }

    Function("isLoaded") {
      activeEngine != null
    }

    /**
     * Load a model. Detects engine based on path:
     * - If path is a DIRECTORY with unet.mnn or unet.bin → local-dream
     * - If path is a FILE (.gguf/.safetensors) → sd.cpp
     *
     * For directories, searches recursively (up to 3 levels) for model
     * marker files. This handles both MNN zips (single-nested) and QNN
     * zips (double-nested: output_512/qnn_models_min/unet.bin).
     */
    AsyncFunction("loadModel") { path: String, promise: expo.modules.kotlin.Promise ->
      scope.launch {
        try {
          opMutex.withLock {
            val file = java.io.File(path)

            // Resolve the actual model directory by searching for marker files
            val mnnDir = if (file.isDirectory) resolveModelDir(file, "unet.mnn") else null
            val qnnDir = if (file.isDirectory) resolveModelDir(file, "unet.bin") else null

            if (mnnDir != null || qnnDir != null) {
              // MNN/QNN model directory → local-dream engine
              stopAll()
              val ld = localDream ?: LocalDreamProcess(context).also { localDream = it }
              val qnnVariant = ld.detectQnnVariant()
              val useQnn = qnnDir != null && qnnVariant != null
              val modelDir = if (useQnn) qnnDir!! else mnnDir ?: qnnDir!!

              try {
                ld.startServer(modelDir.absolutePath, useQnn = useQnn, useOpenCL = true)
              } catch (qnnErr: Throwable) {
                // QNN failed — fall back to MNN/CPU if available
                if (useQnn && mnnDir != null) {
                  Log.w(TAG, "QNN startup failed (${qnnErr.message}), falling back to MNN/CPU")
                  ld.stopServer()
                  ld.startServer(mnnDir.absolutePath, useQnn = false, useOpenCL = true)
                } else if (useQnn) {
                  val soc = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else "unknown"
                  throw IllegalStateException(
                    "NPU not compatible with this device ($soc). " +
                    "This model requires a newer Snapdragon processor. " +
                    "Try a GPU model (MNN) instead."
                  )
                } else {
                  throw qnnErr
                }
              }
              activeEngine = "localdream"
            } else {
              // Single file → sd.cpp engine
              stopAll()
              val sd = sdServer ?: SdServerProcess(context).also { sdServer = it }
              sd.startServer(path)
              activeEngine = "sdcpp"
            }
          }
          promise.resolve(null)
        } catch (t: Throwable) {
          promise.reject(
            "ERR_LOAD_FAILED",
            "Failed to load model: ${t.message ?: t.javaClass.simpleName}",
            t,
          )
        }
      }
    }

    /**
     * Unzip a downloaded .zip model file to a directory.
     * Uses Java's built-in java.util.zip — no external dependency.
     */
    AsyncFunction("unzipModel") { zipPath: String, destDir: String, promise: expo.modules.kotlin.Promise ->
      scope.launch {
        try {
          withContext(Dispatchers.IO) {
            val destFile = java.io.File(destDir)
            destFile.mkdirs()
            val zipFile = java.util.zip.ZipFile(zipPath)
            try {
              val entries = zipFile.entries()
              val buf = ByteArray(1024 * 1024) // 1 MB buffer for speed
              var count = 0
              while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                val outFile = java.io.File(destDir, entry.name)
                // Path traversal protection
                if (!outFile.canonicalPath.startsWith(java.io.File(destDir).canonicalPath)) {
                  continue
                }
                if (entry.isDirectory) {
                  outFile.mkdirs()
                } else {
                  outFile.parentFile?.mkdirs()
                  zipFile.getInputStream(entry).use { input ->
                    java.io.FileOutputStream(outFile).use { fos ->
                      var len: Int
                      while (input.read(buf).also { len = it } > 0) {
                        fos.write(buf, 0, len)
                      }
                    }
                  }
                  count++
                }
              }
              android.util.Log.d("ExpoStableDiffusion", "Unzipped $count files from $zipPath to $destDir")
            } finally {
              zipFile.close()
            }
          }
          promise.resolve(null)
        } catch (t: Throwable) {
          android.util.Log.e("ExpoStableDiffusion", "Unzip failed: ${t.message}", t)
          promise.reject("ERR_UNZIP", "Unzip failed: ${t.message}", t)
        }
      }
    }

    AsyncFunction("unloadModel") { promise: expo.modules.kotlin.Promise ->
      scope.launch {
        try {
          opMutex.withLock { stopAll() }
          promise.resolve(null)
        } catch (t: Throwable) {
          promise.reject("ERR_UNLOAD", t.message ?: "unknown", t)
        }
      }
    }

    AsyncFunction("generate") {
        prompt: String,
        negativePrompt: String,
        width: Int,
        height: Int,
        steps: Int,
        cfgScale: Double,
        seed: Double,
        promise: expo.modules.kotlin.Promise ->

      scope.launch {
        try {
          try {
            sendEvent("onGenerationProgress", mapOf("step" to 0, "totalSteps" to steps))
          } catch (_: Throwable) {}

          val base64 = opMutex.withLock {
            // Determine backend label for the UI based on actual engine + model
            val backendLabel = when (activeEngine) {
              "localdream" -> {
                // Check if the loaded model dir has unet.bin (QNN/NPU) or unet.mnn (MNN/GPU)
                val dir = localDream?.let {
                  try {
                    val f = it.javaClass.getDeclaredField("loadedModelDir")
                    f.isAccessible = true
                    f.get(it) as? String
                  } catch (_: Throwable) { null }
                }
                if (dir != null && java.io.File(dir, "unet.bin").exists()) "NPU (Hexagon)"
                else "GPU (OpenCL)"
              }
              "sdcpp" -> "CPU"
              else -> "Unknown"
            }

            val onStep = { step: Int, total: Int ->
              try {
                sendEvent("onGenerationProgress", mapOf(
                  "step" to step,
                  "totalSteps" to total,
                  "engine" to (activeEngine ?: "unknown"),
                  "backend" to backendLabel,
                ))
              } catch (_: Throwable) {}
            }

            when (activeEngine) {
              "localdream" -> {
                val ld = localDream ?: throw IllegalStateException("local-dream not loaded")
                ld.generate(
                  prompt = prompt,
                  negativePrompt = negativePrompt,
                  width = width,
                  height = height,
                  steps = steps,
                  cfgScale = cfgScale.toFloat(),
                  seed = seed.toLong(),
                  onStep = onStep,
                )
              }
              "sdcpp" -> {
                val sd = sdServer ?: throw IllegalStateException("sd.cpp not loaded")
                sd.generate(
                  prompt = prompt,
                  negativePrompt = negativePrompt,
                  width = width,
                  height = height,
                  steps = steps,
                  cfgScale = cfgScale.toFloat(),
                  seed = seed.toLong(),
                  onStep = onStep,
                )
              }
              else -> throw IllegalStateException("No model loaded")
            }
          }

          try {
            sendEvent("onGenerationProgress", mapOf("step" to steps, "totalSteps" to steps))
          } catch (_: Throwable) {}

          promise.resolve(base64)
        } catch (t: Throwable) {
          try {
            sendEvent("onGenerationError", mapOf("message" to (t.message ?: "unknown")))
          } catch (_: Throwable) {}
          promise.reject(
            "ERR_GENERATE_FAILED",
            "Image generation failed: ${t.message ?: t.javaClass.simpleName}",
            t,
          )
        }
      }
    }

    AsyncFunction("cancelGeneration") { promise: expo.modules.kotlin.Promise ->
      try {
        when (activeEngine) {
          "localdream" -> localDream?.stopServer()
          "sdcpp" -> sdServer?.stopServer()
        }
        activeEngine = null
        promise.resolve(null)
      } catch (t: Throwable) {
        promise.reject("ERR_CANCEL", t.message ?: "unknown", t)
      }
    }

    OnDestroy {
      try { stopAll() } catch (_: Throwable) {}
    }
  }

  private fun stopAll() {
    try { localDream?.stopServer() } catch (_: Throwable) {}
    try { sdServer?.stopServer() } catch (_: Throwable) {}
    activeEngine = null
  }
}
