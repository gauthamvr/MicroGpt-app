package expo.modules.stablediffusion

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.URL

/**
 * Manages the local-dream subprocess — a MNN/QNN-based Stable Diffusion
 * inference server for fast GPU/NPU image generation.
 *
 * This is the FAST path (5-30 seconds per image). For wide model support
 * (GGUF, safetensors, SDXL, Flux), [SdServerProcess] handles the sd.cpp
 * CPU path.
 *
 * Models are in MNN format (~1.2 GB each, zipped) from xororz/sd-mnn
 * and xororz/sd-qnn on HuggingFace.
 */
internal class LocalDreamProcess(private val context: Context) {

  companion object {
    private const val TAG = "LocalDreamProcess"
    private const val PORT = 18081
    private const val BINARY_NAME = "libstable_diffusion_core.so"
    private const val HEALTH_TIMEOUT_MS = 120_000L
    private const val HEALTH_POLL_MS = 500L
  }

  @Volatile private var process: Process? = null
  @Volatile private var loadedModelDir: String? = null

  val isRunning: Boolean get() = process?.isAlive == true

  /**
   * Detect the Snapdragon SoC model for QNN variant selection.
   * Returns the chipset suffix ("8gen2", "8gen1", "min") or null
   * if the chip isn't QNN-capable.
   *
   * Classification rule: only chips with Hexagon 780 or newer get a
   * variant. The three tiers map to the `xororz/sd-qnn` model-zip
   * suffixes:
   *   "8gen2" — large flagship kernels (Hexagon 790 / 800 / 810)
   *   "8gen1" — standard flagship kernels (Hexagon 780 on 8 Gen 1)
   *   "min"   — small kernels (borderline 780 and QNN-capable mid-range)
   *
   * Unknown chips return null so NPU rows stay hidden and the user
   * doesn't waste bandwidth on a download that would fail to load.
   * When Qualcomm ships a new flagship whose SOC_MODEL isn't listed
   * yet, users fall back to the GPU/CPU variants until the next app
   * update — that's a safer default than blindly claiming support.
   */
  fun detectQnnVariant(): String? {
    if (Build.VERSION.SDK_INT < 31) return null
    val soc = Build.SOC_MODEL ?: return null
    if (!soc.startsWith("SM") && !soc.startsWith("QC")) return null

    // The SOC_MODEL on-device can include an AOSP-style suffix like
    // "-AB" or "-AC" (e.g., "SM8750-AB"), so we match on a stripped
    // base. This also covers "-3-AB" style seen on some SKUs.
    val base = soc.substringBefore('-').uppercase()

    return when (base) {
      // ═══ Flagship 8-series (Hexagon 790 / 800) ═══
      // Full QNN flagship kernels — verified via Qualcomm product
      // briefs, GSMArena, and xororz/local-dream's compatibility list.
      "SM8550", "SM8550P" -> "8gen2"   // 8 Gen 2 / 8 Gen 2 for Galaxy (2022-2023)
      "QCS8550", "QCM8550" -> "8gen2"  // IoT/automotive 8 Gen 2 variants (rare on phones)
      "SM8650", "SM8650P" -> "8gen2"   // 8 Gen 3 / 8 Gen 3 for Galaxy (2023-2024)
      "SM8750", "SM8750P" -> "8gen2"   // 8 Elite / 8 Elite for Galaxy (2024-2025)
      "SM8850", "SM8850P" -> "8gen2"   // 8 Elite Gen 5 "Sun" (Sept 2025)

      // ═══ Premium mid-range 8s-series (Hexagon 790) ═══
      "SM8635" -> "8gen2"              // 8s Gen 3 (2024)
      "SM8735" -> "8gen2"              // 8s Gen 4 (2025)
      // SM8845 — reported by GSMArena as Snapdragon 8 Gen 5
      // sub-flagship; not on a shipping device at research time.
      // Gate it cautiously at the same tier as its 8s siblings.
      "SM8845" -> "8gen2"

      // ═══ Snapdragon 8 Gen 1 family (Hexagon 780) ═══
      "SM8450" -> "8gen1"              // 8 Gen 1 (2022)
      "SM8475" -> "8gen1"              // 8+ Gen 1 (2022)

      // ═══ Premium 7-series with QNN-capable DSP ═══
      "SM7550" -> "min"                // 7 Gen 3 (Nov 2023)
      "SM7635" -> "min"                // 7s Gen 3 (2024)
      "SM7675" -> "min"                // 7+ Gen 3 (2024)
      "SM7750" -> "min"                // 7 Gen 4 (2025)

      // ═══ Borderline Hexagon 780 (Snapdragon 888 / 888+) ═══
      "SM8350", "SM8350P" -> "min"     // 888 / 888+ (2021)

      // ═══ Forward-compat placeholders (rumored, unverified) ═══
      // Leaked SOC_MODEL codes for Snapdragon 8 Elite Gen 6 /
      // 8 Elite Gen 6 Pro — reported by GSMArena / Gizmochina /
      // Digital Chat Station in Feb–April 2026, no shipping device
      // yet. Default to the large-kernel tier so early adopters on
      // next-gen silicon aren't stuck with no NPU support until the
      // next app update. If the code ends up wrong, the native
      // load-failure path already falls back to GPU/CPU.
      "SM8950" -> "8gen2"              // 8 Elite Gen 6 (expected late 2026)
      "SM8975" -> "8gen2"              // 8 Elite Gen 6 Pro (expected late 2026)

      // Older Snapdragon (865/855/7-series pre-Gen 3), Dimensity,
      // Exynos, Google Tensor — no useful QNN runtime support.
      else -> null
    }
  }

  /**
   * Check if the local-dream binary is available in the APK.
   */
  fun isBinaryAvailable(): Boolean {
    val nativeDir = context.applicationInfo.nativeLibraryDir
    return File(nativeDir, BINARY_NAME).exists() || BinaryResolver.existsInApk(context, BINARY_NAME)
  }

  /**
   * Ensure QNN runtime libraries are extracted from assets to filesDir.
   */
  private fun ensureQnnLibsExtracted(): String {
    val runtimeDir = File(context.filesDir, "runtime_libs")
    if (runtimeDir.exists() && (runtimeDir.listFiles()?.size ?: 0) > 5) {
      return runtimeDir.absolutePath
    }
    runtimeDir.mkdirs()

    try {
      val assetFiles = context.assets.list("qnnlibs") ?: emptyArray()
      for (fileName in assetFiles) {
        val dest = File(runtimeDir, fileName)
        if (dest.exists()) continue
        context.assets.open("qnnlibs/$fileName").use { input ->
          FileOutputStream(dest).use { output -> input.copyTo(output) }
        }
        dest.setExecutable(true, false)
        dest.setReadable(true, false)
      }
      Log.i(TAG, "Extracted ${assetFiles.size} QNN libs to ${runtimeDir.absolutePath}")
    } catch (e: Exception) {
      Log.w(TAG, "No QNN libs in assets (MNN-only mode): ${e.message}")
    }

    return runtimeDir.absolutePath
  }

  /**
   * Start the local-dream server with an MNN or QNN model.
   *
   * @param modelDir Directory containing clip.mnn, unet.mnn/bin, etc.
   * @param useQnn Whether to use QNN (NPU) backend
   * @param useOpenCL Whether to use OpenCL GPU acceleration (MNN only)
   */
  suspend fun startServer(
    modelDir: String,
    useQnn: Boolean = false,
    useOpenCL: Boolean = true,
  ) {
    if (isRunning && loadedModelDir == modelDir) return
    stopServer()

    val binaryFile = BinaryResolver.resolve(context, BINARY_NAME)

    val runtimeDir = ensureQnnLibsExtracted()

    // ── Resolve file paths ──
    // The local-dream binary auto-detects clip_v2.mnn when given
    // --clip clip.mnn — it searches the same directory for clip_v2.mnn
    // and loads pos_emb.bin + token_emb.bin automatically. Passing
    // clip_v2.mnn directly causes a segfault, so we ALWAYS pass
    // "clip.mnn" as the clip path regardless of which variant exists.
    val hasMnnClip = File(modelDir, "clip.mnn").exists() ||
                     File(modelDir, "clip_v2.mnn").exists()
    val clipFile = if (hasMnnClip) "$modelDir/clip.mnn" else "$modelDir/clip.bin"
    val unetFile = if (useQnn) "$modelDir/unet.bin" else "$modelDir/unet.mnn"
    val vaeFile = if (useQnn) "$modelDir/vae_decoder.bin" else "$modelDir/vae_decoder.mnn"
    val tokFile = "$modelDir/tokenizer.json"

    // Validate required model files (clip can be either v1 or v2)
    if (!hasMnnClip && !File("$modelDir/clip.bin").exists()) {
      val contents = File(modelDir).listFiles()?.map { it.name } ?: emptyList()
      throw IllegalStateException(
        "Missing clip file (clip.mnn, clip_v2.mnn, or clip.bin)\n" +
        "Model dir: $modelDir\nContents: ${contents.joinToString(", ")}"
      )
    }
    for ((label, path) in listOf("unet" to unetFile, "vae" to vaeFile, "tokenizer" to tokFile)) {
      if (!File(path).exists()) {
        val contents = File(modelDir).listFiles()?.map { it.name } ?: emptyList()
        throw IllegalStateException(
          "Missing $label file: ${File(path).name}\n" +
          "Model dir: $modelDir\nContents: ${contents.joinToString(", ")}"
        )
      }
    }

    // Validate QNN runtime libraries if NPU mode requested
    if (useQnn) {
      val htpLib = File(runtimeDir, "libQnnHtp.so")
      val sysLib = File(runtimeDir, "libQnnSystem.so")
      if (!htpLib.exists() || !sysLib.exists()) {
        throw IllegalStateException(
          "QNN/NPU runtime libraries not available on this device. " +
          "NPU models require Qualcomm Snapdragon with QNN support. " +
          "Try a GPU (MNN) model instead."
        )
      }
    }

    Log.i(TAG, "Starting local-dream: modelDir=$modelDir, qnn=$useQnn, opencl=$useOpenCL, clip=${File(clipFile).name}")

    val cmd = mutableListOf(
      binaryFile.absolutePath,
      "--clip", clipFile,
      "--unet", unetFile,
      "--vae_decoder", vaeFile,
      "--tokenizer", tokFile,
      "--port", PORT.toString(),
      "--text_embedding_size", "768",
    )

    // Add VAE encoder if available (for img2img)
    val vaeEnc = if (useQnn) "$modelDir/vae_encoder.bin" else "$modelDir/vae_encoder.mnn"
    if (File(vaeEnc).exists()) {
      cmd.addAll(listOf("--vae_encoder", vaeEnc))
    }

    if (useQnn) {
      cmd.addAll(listOf(
        "--backend", "$runtimeDir/libQnnHtp.so",
        "--system_library", "$runtimeDir/libQnnSystem.so",
      ))
      // Only use CPU clip when MNN clip files exist (clip.mnn or clip_v2.mnn)
      if (hasMnnClip) {
        cmd.add("--use_cpu_clip")
      }
    } else {
      cmd.add("--cpu")
    }

    val nativeDir = context.applicationInfo.nativeLibraryDir
    val env = mutableMapOf(
      "LD_LIBRARY_PATH" to "$runtimeDir:$nativeDir:${binaryFile.parentFile?.absolutePath}:/system/lib64:/vendor/lib64:/vendor/lib64/egl",
      "DSP_LIBRARY_PATH" to runtimeDir,
      "ADSP_LIBRARY_PATH" to runtimeDir,
    )
    if (!useQnn && useOpenCL) {
      env["MNN_OPENCL_TUNING"] = "WIDE"
    }

    val pb = ProcessBuilder(cmd).apply {
      directory(binaryFile.parentFile)
      redirectErrorStream(true)
      environment().putAll(env)
    }

    val proc = withContext(Dispatchers.IO) { pb.start() }
    process = proc
    loadedModelDir = modelDir

    // Capture stdout/stderr for error diagnostics
    val outputLines = java.util.concurrent.CopyOnWriteArrayList<String>()
    Thread {
      try {
        BufferedReader(InputStreamReader(proc.inputStream)).forEachLine { line ->
          Log.d(TAG, "[server] $line")
          outputLines.add(line)
          // Keep only last 20 lines to avoid unbounded growth
          while (outputLines.size > 20) outputLines.removeAt(0)
        }
      } catch (_: Throwable) {}
    }.apply { isDaemon = true; name = "localdream-stdout"; start() }

    waitForReady(outputLines)
    Log.i(TAG, "local-dream server is ready")
  }

  private suspend fun waitForReady(outputLines: List<String>) = withContext(Dispatchers.IO) {
    val deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline) {
      val proc = process ?: throw IllegalStateException("local-dream died during startup")
      if (!proc.isAlive) {
        val tail = outputLines.takeLast(5).joinToString("\n")
        throw IllegalStateException(
          "local-dream exited with code ${proc.exitValue()}" +
          if (tail.isNotBlank()) "\nOutput:\n$tail" else ""
        )
      }
      try {
        val conn = URL("http://127.0.0.1:$PORT/health").openConnection() as HttpURLConnection
        conn.connectTimeout = 1000
        conn.readTimeout = 1000
        val code = conn.responseCode
        conn.disconnect()
        if (code == 200) return@withContext
      } catch (_: Throwable) {}
      Thread.sleep(HEALTH_POLL_MS)
    }
    throw IllegalStateException("local-dream failed to start within ${HEALTH_TIMEOUT_MS / 1000}s")
  }

  /**
   * Generate an image via SSE streaming. Returns base64 PNG.
   * Progress is reported via [onStep] callback with step previews.
   */
  suspend fun generate(
    prompt: String,
    negativePrompt: String,
    width: Int,
    height: Int,
    steps: Int,
    cfgScale: Float,
    seed: Long,
    useOpenCL: Boolean = true,
    onStep: (step: Int, totalSteps: Int) -> Unit = { _, _ -> },
  ): String = withContext(Dispatchers.IO) {
    val proc = process
    if (proc == null || !proc.isAlive) {
      // Process died while idle — attempt auto-restart from the last
      // loaded model directory before failing with a confusing error.
      val dir = loadedModelDir
      if (dir != null) {
        Log.w(TAG, "local-dream died while idle, auto-restarting from $dir")
        val hasQnn = java.io.File(dir, "unet.bin").exists()
        val qnnVariant = detectQnnVariant()
        val restartQnn = hasQnn && qnnVariant != null
        startServer(dir, useQnn = restartQnn, useOpenCL = useOpenCL)
      } else {
        throw IllegalStateException("local-dream is not running")
      }
    }

    Log.i(TAG, "Generating: prompt=\"${prompt.take(60)}\", ${width}x${height}, steps=$steps")

    val body = JSONObject().apply {
      put("prompt", prompt)
      put("negative_prompt", negativePrompt)
      put("width", width)
      put("height", height)
      put("steps", steps)
      put("cfg", cfgScale.toDouble())
      if (seed >= 0) put("seed", seed)
      put("scheduler", "dpm")
      put("use_opencl", useOpenCL)
      put("show_diffusion_process", false)
    }

    val conn = URL("http://127.0.0.1:$PORT/generate").openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.setRequestProperty("Content-Type", "application/json")
    conn.doOutput = true
    conn.connectTimeout = 10_000
    conn.readTimeout = 0 // no timeout — generation can take minutes

    conn.outputStream.use { it.write(body.toString().toByteArray()) }

    if (conn.responseCode != 200) {
      val err = conn.errorStream?.bufferedReader()?.readText() ?: "no body"
      conn.disconnect()
      throw RuntimeException("local-dream HTTP ${conn.responseCode}: $err")
    }

    // Parse SSE stream
    var resultBase64Png: String? = null
    var resultWidth = width
    var resultHeight = height

    BufferedReader(InputStreamReader(conn.inputStream)).use { reader ->
      var line: String?
      while (reader.readLine().also { line = it } != null) {
        val trimmed = line!!.trim()
        if (!trimmed.startsWith("data: ")) continue

        try {
          val data = JSONObject(trimmed.substring(6))
          when (data.optString("type")) {
            "progress" -> {
              val step = data.optInt("step", 0)
              val total = data.optInt("total_steps", steps)
              try { onStep(step, total) } catch (_: Throwable) {}
              Log.d(TAG, "Step $step/$total")
            }
            "complete" -> {
              val rgbBase64 = data.getString("image")
              resultWidth = data.optInt("width", width)
              resultHeight = data.optInt("height", height)
              val genTime = data.optInt("generation_time_ms", 0)
              Log.i(TAG, "Complete! ${resultWidth}x${resultHeight} in ${genTime}ms")

              // Convert raw RGB to PNG base64
              resultBase64Png = rgbToPngBase64(rgbBase64, resultWidth, resultHeight)
            }
            "error" -> {
              throw RuntimeException("Generation error: ${data.optString("message")}")
            }
          }
        } catch (e: org.json.JSONException) {
          Log.w(TAG, "SSE parse error: ${e.message}")
        }
      }
    }
    conn.disconnect()

    resultBase64Png ?: throw RuntimeException("No image in SSE response")
  }

  fun stopServer() {
    val proc = process ?: return
    Log.i(TAG, "Stopping local-dream")
    try {
      proc.destroy()
      Thread {
        try {
          Thread.sleep(5000)
          if (proc.isAlive) proc.destroyForcibly()
        } catch (_: Throwable) {}
      }.apply { isDaemon = true; start() }
    } catch (_: Throwable) {}
    process = null
    loadedModelDir = null
  }

  /**
   * Convert raw RGB bytes (base64) to PNG (base64).
   * local-dream sends raw RGB; we need PNG for the Image component.
   */
  private fun rgbToPngBase64(rgbBase64: String, width: Int, height: Int): String {
    val rgbBytes = Base64.decode(rgbBase64, Base64.DEFAULT)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val pixels = IntArray(width * height)
    for (i in 0 until minOf(width * height, rgbBytes.size / 3)) {
      val idx = i * 3
      val r = rgbBytes[idx].toInt() and 0xFF
      val g = rgbBytes[idx + 1].toInt() and 0xFF
      val b = rgbBytes[idx + 2].toInt() and 0xFF
      pixels[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }
    bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
    bitmap.recycle()
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }
}
