package expo.modules.stablediffusion

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Manages the sd-server subprocess — a standalone stable-diffusion.cpp
 * HTTP server binary compiled for Android ARM64.
 *
 * Architecture: the binary runs as a child process on localhost:PORT,
 * accepting OpenAI-compatible image generation requests. This is the
 * same pattern local-dream uses, but built from MIT-licensed sd.cpp
 * sources instead of CC-NC local-dream code.
 *
 * The binary is packaged as `libsd-server.so` inside the APK's
 * `lib/arm64-v8a/` directory (the `.so` naming is an Android trick —
 * it's an executable, not a shared library, but Android only extracts
 * files matching `lib*.so` from the APK into `nativeLibraryDir`).
 *
 * Lifecycle:
 *   1. [startServer] spawns the process with the model path
 *   2. [waitForReady] polls /health until the server is up
 *   3. [generate] POSTs to /v1/images/generations
 *   4. [stopServer] sends SIGTERM and waits for exit
 */
internal class SdServerProcess(private val context: Context) {

  companion object {
    private const val TAG = "SdServerProcess"
    private const val PORT = 8087 // avoid collision with Metro (8081)
    private const val BINARY_NAME = "libsd-server.so"
    private const val HEALTH_TIMEOUT_MS = 300_000L // 5 min max for large safetensors on slow CPU
    private const val HEALTH_POLL_MS = 500L
  }

  @Volatile
  private var process: Process? = null

  @Volatile
  private var loadedModelPath: String? = null

  val isRunning: Boolean
    get() = process?.isAlive == true

  /**
   * Start the sd-server process with the given model loaded. If a
   * server with the same model is already running, this is a no-op.
   * If a different model is loaded, the old server is stopped first.
   */
  suspend fun startServer(modelPath: String) {
    if (isRunning && loadedModelPath == modelPath) {
      Log.d(TAG, "Server already running with model $modelPath")
      return
    }
    stopServer()

    // Resolve binary — tries nativeLibraryDir first, then extracts
    // from APK as fallback. This handles both debug APK (extractNativeLibs=true)
    // and Play Store AAB (may not extract native libs to disk).
    val binaryFile = BinaryResolver.resolve(context, BINARY_NAME)

    Log.i(TAG, "Starting sd-server: model=$modelPath, port=$PORT")
    Log.i(TAG, "Binary: ${binaryFile.absolutePath} (${binaryFile.length()} bytes)")

    val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 8)

    val cmd = mutableListOf(
      binaryFile.absolutePath,
      "--model", modelPath,
      "--listen-port", PORT.toString(),
      "--listen-ip", "127.0.0.1",
      "-t", threads.toString(),
      "--vae-tiling",
      "--clip-on-cpu",
      "--vae-on-cpu",
    )

    Log.i(TAG, "Starting with $threads threads, vae-tiling enabled")

    val pb = ProcessBuilder(cmd).apply {
      directory(binaryFile.parentFile)
      redirectErrorStream(true)
      environment()["LD_LIBRARY_PATH"] = BinaryResolver.getLibraryPath(context, binaryFile)
    }

    val proc = withContext(Dispatchers.IO) { pb.start() }
    process = proc
    loadedModelPath = modelPath

    // Drain stdout/stderr in a background thread to prevent the
    // process from blocking on a full pipe buffer.
    Thread {
      try {
        val reader = BufferedReader(InputStreamReader(proc.inputStream))
        reader.forEachLine { line ->
          Log.d(TAG, "[server] $line")
        }
      } catch (_: Throwable) {}
    }.apply {
      isDaemon = true
      name = "sd-server-stdout"
      start()
    }

    // Wait for the server to become ready (model loaded, HTTP listening)
    waitForReady()
    Log.i(TAG, "sd-server is ready")
  }

  /**
   * Poll the server's /health endpoint until it responds 200.
   * Throws if the process dies or the timeout is exceeded.
   */
  private suspend fun waitForReady() = withContext(Dispatchers.IO) {
    val deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline) {
      // Check if the process died
      val proc = process ?: throw IllegalStateException("sd-server process died during startup")
      if (!proc.isAlive) {
        val exit = proc.exitValue()
        throw IllegalStateException("sd-server exited with code $exit during startup")
      }

      try {
        val conn = URL("http://127.0.0.1:$PORT/v1/models").openConnection() as HttpURLConnection
        conn.connectTimeout = 1000
        conn.readTimeout = 1000
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        if (code == 200) return@withContext
      } catch (_: Throwable) {
        // Connection refused / timeout — server not ready yet
      }

      Thread.sleep(HEALTH_POLL_MS)
    }
    throw IllegalStateException("sd-server failed to start within ${HEALTH_TIMEOUT_MS / 1000}s")
  }

  /**
   * Generate an image via the server's OpenAI-compatible endpoint.
   * Returns a base64-encoded PNG string.
   *
   * The sd-server's /v1/images/generations endpoint is synchronous —
   * it blocks until the image is fully generated, then returns the
   * result as a JSON response with `data[0].b64_json`. For progress,
   * we'd need to poll a separate status endpoint or add SSE support.
   * For v1, we accept the synchronous approach and show an
   * indeterminate progress spinner.
   */
  /**
   * Generate an image using the async /sdcpp/v1/img_gen endpoint.
   *
   * This endpoint accepts ALL generation params as direct JSON fields
   * (no prompt-embedding hack needed), returns a job ID immediately,
   * and lets us poll /sdcpp/v1/jobs/{id} for status + result. This
   * means the HTTP request doesn't block for minutes, and we can
   * detect failures quickly.
   *
   * @param onStep called with (currentStep, totalSteps) during polling
   */
  suspend fun generate(
    prompt: String,
    negativePrompt: String,
    width: Int,
    height: Int,
    steps: Int,
    cfgScale: Float,
    seed: Long,
    onStep: (step: Int, total: Int) -> Unit = { _, _ -> },
  ): String = withContext(Dispatchers.IO) {
    val proc = process
    if (proc == null || !proc.isAlive) {
      // Process died while idle — auto-restart from last loaded model
      val path = loadedModelPath
      if (path != null) {
        Log.w(TAG, "sd-server died while idle, auto-restarting from $path")
        startServer(path)
      } else {
        throw IllegalStateException("sd-server is not running")
      }
    }

    Log.i(TAG, "Generating: prompt=\"${prompt.take(60)}\", ${width}x${height}, steps=$steps")

    // Build the request body — sdcpp endpoint parses from_json_str on
    // the entire body, so all params are top-level fields matching the
    // SDGenerationParams struct from common.cpp.
    val jsonBody = buildString {
      append("{")
      append("\"prompt\":\"${escapeJson(prompt)}\",")
      if (negativePrompt.isNotBlank()) {
        append("\"negative_prompt\":\"${escapeJson(negativePrompt)}\",")
      }
      append("\"width\":$width,")
      append("\"height\":$height,")
      // Always include seed — sd.cpp defaults to 42 if omitted
      append("\"seed\":$seed,")
      append("\"sample_params\":{")
      append("\"sample_steps\":$steps,")
      append("\"guidance\":{\"txt_cfg\":$cfgScale}")
      append("},")
      append("\"output_format\":\"png\"")
      append("}")
    }

    Log.d(TAG, "Request body: $jsonBody")

    // Step 1: Submit the job
    val submitConn = URL("http://127.0.0.1:$PORT/sdcpp/v1/img_gen")
      .openConnection() as HttpURLConnection
    submitConn.requestMethod = "POST"
    submitConn.setRequestProperty("Content-Type", "application/json")
    submitConn.doOutput = true
    submitConn.connectTimeout = 10_000
    submitConn.readTimeout = 30_000

    submitConn.outputStream.use { it.write(jsonBody.toByteArray()) }

    val submitCode = submitConn.responseCode
    val submitBody = (if (submitCode in 200..299) submitConn.inputStream else submitConn.errorStream)
      ?.bufferedReader()?.readText() ?: ""
    submitConn.disconnect()

    if (submitCode !in 200..299) {
      throw RuntimeException("sd-server returned HTTP $submitCode: $submitBody")
    }

    // Parse the job ID from: {"id":"abc123","status":"queued","poll_url":"/sdcpp/v1/jobs/abc123"}
    val jobIdMatch = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(submitBody)
      ?: throw RuntimeException("No job ID in response: ${submitBody.take(200)}")
    val jobId = jobIdMatch.groupValues[1]
    Log.i(TAG, "Job submitted: id=$jobId")

    // Step 2: Poll for completion
    val pollUrl = "http://127.0.0.1:$PORT/sdcpp/v1/jobs/$jobId"
    val pollIntervalMs = 2000L
    // The old fixed 600s (10 min) cap was tuned for SD1.5 at 256x256, where
    // each step takes ~20s on CPU. Larger architectures we now let users
    // download (SDXL, SD3, Flux — see gguf-detect.ts's IMAGE_GEN_ARCHS) run
    // several times more pixels and heavier attention blocks per step, so a
    // fixed cap throws a spurious "timed out" failure on a job that's still
    // legitimately running. Scale the cap off (pixels x steps), keep the old
    // 10-min value as a floor so SD1.5/256px behavior is unchanged, and cap
    // at 45 min so a truly stuck job still eventually fails.
    val baselineSecPerStepAt256 = 20.0
    val pixelScale = (width.toDouble() * height.toDouble()) / (256.0 * 256.0)
    val estimatedTotalSec = baselineSecPerStepAt256 * pixelScale * steps
    // 3x the estimate as a safety buffer — attention-heavy architectures
    // (SDXL/SD3/Flux) scale worse than the linear pixel-count approximation.
    val maxPollTimeMs = (estimatedTotalSec * 3 * 1000).toLong()
      .coerceIn(600_000L, 45 * 60_000L)
    val deadline = System.currentTimeMillis() + maxPollTimeMs
    var lastStep = 0

    while (System.currentTimeMillis() < deadline) {
      Thread.sleep(pollIntervalMs)

      // Check if the server process died
      if (process?.isAlive != true) {
        throw IllegalStateException("sd-server process died during generation")
      }

      val pollConn = URL(pollUrl).openConnection() as HttpURLConnection
      pollConn.requestMethod = "GET"
      pollConn.connectTimeout = 5_000
      pollConn.readTimeout = 5_000

      val pollCode = pollConn.responseCode
      val pollBody = (if (pollCode in 200..299) pollConn.inputStream else pollConn.errorStream)
        ?.bufferedReader()?.readText() ?: ""
      pollConn.disconnect()

      if (pollCode != 200) {
        Log.w(TAG, "Poll returned HTTP $pollCode: $pollBody")
        continue
      }

      // Parse status
      val statusMatch = Regex("\"status\"\\s*:\\s*\"([^\"]+)\"").find(pollBody)
      val status = statusMatch?.groupValues?.get(1) ?: "unknown"

      when (status) {
        "queued", "running", "generating" -> {
          // Estimate progress based on elapsed time. We don't get real step
          // counts from the server, so we estimate from wall clock, scaled
          // by the same per-step cost model used for maxPollTimeMs above —
          // at higher resolutions each step genuinely takes longer, so the
          // estimate needs the same pixelScale factor or it reports
          // progress much faster than the job is actually completing.
          val elapsedSec = (System.currentTimeMillis() - deadline + maxPollTimeMs) / 1000
          val estSecPerStep = (baselineSecPerStepAt256 * pixelScale).coerceAtLeast(1.0)
          // Subtract ~2s for condition encoding at the start
          val stepEstimate = ((elapsedSec - 2) / estSecPerStep).toInt().coerceIn(0, steps - 1)
          try { onStep(stepEstimate, steps) } catch (_: Throwable) {}
          Log.d(TAG, "Job $jobId: $status (estimated step ~$stepEstimate/$steps, ${elapsedSec}s elapsed)")
        }
        "completed" -> {
          Log.i(TAG, "Job $jobId: completed!")
          try { onStep(steps, steps) } catch (_: Throwable) {}
          // Extract base64 image from result.images[0].b64_json
          val b64Start = pollBody.indexOf("\"b64_json\":\"")
          if (b64Start < 0) {
            throw RuntimeException("No b64_json in completed job: ${pollBody.take(300)}")
          }
          val dataStart = b64Start + "\"b64_json\":\"".length
          val dataEnd = pollBody.indexOf('"', dataStart)
          if (dataEnd < 0) {
            throw RuntimeException("Malformed b64_json in job response")
          }
          return@withContext pollBody.substring(dataStart, dataEnd)
        }
        "failed", "cancelled" -> {
          val errMsg = Regex("\"message\"\\s*:\\s*\"([^\"]+)\"").find(pollBody)
            ?.groupValues?.get(1) ?: "unknown error"
          throw RuntimeException("Generation $status: $errMsg")
        }
        else -> {
          Log.w(TAG, "Job $jobId: unknown status '$status'")
        }
      }
    }

    throw RuntimeException("Generation timed out after ${maxPollTimeMs / 1000}s")
  }

  fun stopServer() {
    val proc = process ?: return
    Log.i(TAG, "Stopping sd-server")
    try {
      proc.destroy()
      // Give it 5 seconds, then force-kill
      Thread {
        try {
          Thread.sleep(5000)
          if (proc.isAlive) {
            Log.w(TAG, "sd-server didn't stop gracefully, force-killing")
            proc.destroyForcibly()
          }
        } catch (_: Throwable) {}
      }.apply { isDaemon = true; start() }
    } catch (_: Throwable) {}
    process = null
    loadedModelPath = null
  }

  /**
   * Extract `libsd-server.so` from the APK into the app's private
   * files directory. Modern Android (API 23+) doesn't extract native
   * libs to nativeLibraryDir by default — it mmap's them from the
   * APK, which works for System.loadLibrary() but NOT for
   * ProcessBuilder (you can't exec a file inside a ZIP).
   *
   * We extract once and re-extract if the APK was updated (checked
   * via lastModified comparison).
   */
  fun isBinaryInApk(): Boolean {
    return BinaryResolver.existsInApk(context, BINARY_NAME)
  }

  private fun escapeJson(s: String): String =
    s.replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t")
}
