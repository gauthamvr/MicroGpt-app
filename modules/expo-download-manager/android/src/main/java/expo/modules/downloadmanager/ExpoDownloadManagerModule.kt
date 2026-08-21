package expo.modules.downloadmanager

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * ExpoDownloadManagerModule
 *
 * Pure-OkHttp downloader. Runs the HTTP transfer itself (no Android
 * DownloadManager, no foreground service), in a coroutine tied to a
 * SupervisorJob. Downloads run as long as the app process is alive;
 * when the OS kills the process the .part file is preserved so the
 * next start resumes via HTTP Range.
 *
 * Key features:
 *   - HTTP Range header for automatic resume from any .part file
 *   - Honest bytes-transferred counting
 *   - Clean cancellation via coroutine job cancel
 *   - Stuck detection: if no bytes flow for STUCK_THRESHOLD_MS while
 *     the call is active, we assume the connection is dead and abort
 *   - Progress events emitted at ~2 Hz (every 500 ms) to JS
 */
class ExpoDownloadManagerModule : Module() {

    companion object {
        private const val TAG = "ExpoDownloadManager"

        // Static handle so the notification's Cancel BroadcastReceiver
        // can reach the live module without going through the RN bridge.
        // Cleared in OnDestroy to avoid leaking the context.
        @Volatile
        private var instance: ExpoDownloadManagerModule? = null

        /**
         * Called from [CancelDownloadReceiver] when the user taps the
         * Cancel action on a download notification.
         */
        fun handleNotificationCancel(modelName: String) {
            instance?.cancelByModelName(modelName)
        }

        // Socket-level timeouts. The overall call timeout is disabled
        // (0) because a multi-GB download can legitimately take hours.
        private const val CONNECT_TIMEOUT_SEC = 30L
        private const val READ_TIMEOUT_SEC = 60L
        private const val WRITE_TIMEOUT_SEC = 60L

        private const val IO_BUFFER_SIZE = 64 * 1024
        private const val PROGRESS_EMIT_INTERVAL_MS = 500L

        // If no bytes flow for this long while a download is actively
        // streaming, we treat the socket as dead and abort. The OkHttp
        // read timeout would catch this eventually but STUCK_THRESHOLD
        // gives us a tighter bound with a clearer error message.
        private const val STUCK_THRESHOLD_MS = 60_000L

        // Exponential-weighted moving average smoothing factor for
        // download speed. Matches pocketpal-ai's value.
        private const val EWMA_ALPHA = 0.3

        // DownloadManager-compatible status codes so the JS side
        // doesn't need to switch on a different enum.
        private const val STATUS_PENDING = 1
        private const val STATUS_RUNNING = 2
        private const val STATUS_PAUSED = 4
        private const val STATUS_SUCCESSFUL = 8
        private const val STATUS_FAILED = 16
    }

    // ----- Per-download state -----
    private data class Tracked(
        val downloadId: Long,
        val url: String,
        val destPath: String,
        val modelName: String,
        val title: String,
        val startedAtMs: Long,
        // Mutable counters updated from the download coroutine
        val bytesDownloaded: AtomicLong = AtomicLong(0),
        val bytesTotal: AtomicLong = AtomicLong(0),
        // Speed EWMA state
        @Volatile var lastEmitMs: Long = 0,
        @Volatile var lastEmitBytes: Long = 0,
        @Volatile var smoothedBps: Double = 0.0,
        // Stuck-watchdog state
        @Volatile var lastByteAdvanceMs: Long = 0,
        @Volatile var lastByteAdvanceValue: Long = 0,
        // Coroutine job so we can cancel cleanly
        @Volatile var job: Job? = null,
    )

    private val tracked = ConcurrentHashMap<Long, Tracked>()
    private var nextDownloadId: Long = 1L
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SEC, TimeUnit.SECONDS)
            .writeTimeout(WRITE_TIMEOUT_SEC, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS) // no overall cap — downloads can take hours
            .retryOnConnectionFailure(true)
            .build()
    }

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    // ----- Module definition -----
    override fun definition() = ModuleDefinition {
        // Publish ourselves so the notification's Cancel receiver can
        // route back into us. Cleared in OnDestroy below.
        instance = this@ExpoDownloadManagerModule

        Name("ExpoDownloadManager")

        Events("onDownloadProgress", "onDownloadComplete", "onDownloadError")

        // Sanity probe — still here so JS can verify the module linked.
        Function("hello") { "world" }

        /**
         * Start a new download, or automatically resume an existing
         * partial `.part` file if one is present at `${destPath}.part`.
         * Returns a synthetic downloadId that JS stores alongside the
         * model name to correlate future events and cancellation calls.
         */
        AsyncFunction("startDownload") {
            url: String, destPath: String, modelName: String, title: String ->
            synchronized(this@ExpoDownloadManagerModule) {
                val id = nextDownloadId++
                val t = Tracked(
                    downloadId = id,
                    url = url,
                    destPath = destPath,
                    modelName = modelName,
                    title = title,
                    startedAtMs = System.currentTimeMillis(),
                )
                tracked[id] = t
                DownloadNotificationHelper.showOrUpdate(
                    context,
                    downloadId = id,
                    modelName = modelName,
                    title = title,
                    text = "Starting download…",
                    progress = -1,
                )
                val job = scope.launch { runDownload(t) }
                t.job = job
                id.toDouble()
            }
        }

        /**
         * Cancel a download by id. Cancels the coroutine (which closes
         * the OkHttp response body and frees the socket) and deletes
         * the partial file so a subsequent startDownload() call starts
         * fresh instead of resuming.
         */
        AsyncFunction("cancelDownload") { downloadId: Double ->
            val id = downloadId.toLong()
            cancelTrackedInternal(id, deletePartial = true)
        }

        /**
         * Pause a download by id. Cancels the coroutine but PRESERVES
         * the .part file so a subsequent startDownload() resumes from
         * the same byte offset via HTTP Range. The caller is responsible
         * for surfacing the partial as "resumable" in its own UI.
         */
        AsyncFunction("pauseDownload") { downloadId: Double ->
            val id = downloadId.toLong()
            cancelTrackedInternal(id, deletePartial = false)
        }

        /**
         * Return the list of in-flight downloads. JS calls this on app
         * open to reconcile UI state: any downloads still running in
         * the native module need their progress re-routed to the
         * freshly-loaded React tree.
         */
        AsyncFunction("getActiveDownloads") {
            tracked.values.map { t ->
                mapOf(
                    "downloadId" to t.downloadId.toDouble(),
                    "modelName" to t.modelName,
                    "title" to t.title,
                    "destPath" to t.destPath,
                    "bytesDownloaded" to t.bytesDownloaded.get(),
                    "bytesTotal" to t.bytesTotal.get(),
                    "bytesPerSec" to t.smoothedBps,
                    "status" to STATUS_RUNNING,
                    "localUri" to "file://${t.destPath}",
                )
            }
        }

        /**
         * Check available disk space on the filesystem containing the
         * given path. Returns bytes available. Used by JS to abort a
         * download before it starts if there isn't enough room.
         */
        AsyncFunction("getAvailableDiskSpace") { path: String ->
            try {
                val dir = java.io.File(path).let { if (it.isDirectory) it else it.parentFile }
                if (dir != null && dir.exists()) {
                    val stat = StatFs(dir.absolutePath)
                    stat.availableBytes.toDouble()
                } else {
                    -1.0
                }
            } catch (_: Throwable) {
                -1.0
            }
        }

        /**
         * Returns true if the app is already excluded from battery
         * optimization (i.e. unrestricted battery usage). On API < 23
         * this always returns true (no doze).
         */
        Function("isBatteryOptimizationIgnored") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                return@Function true
            }
            try {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                pm.isIgnoringBatteryOptimizations(context.packageName)
            } catch (_: Throwable) {
                true // fail open — never block a download
            }
        }

        /**
         * Open the system dialog asking the user to exclude this app
         * from battery optimization. This is a direct intent so it
         * opens the OS dialog — NOT the battery settings page.
         */
        Function("requestBatteryOptimizationExemption") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(intent)
                } catch (_: Throwable) {
                    // Some OEM ROMs don't support this intent — fail silently
                }
            }
            true // Expo Function blocks must return a value
        }

        OnDestroy {
            // Cancel everything and free resources when the module is
            // torn down (app being killed, Expo bridge reset, etc.).
            for (id in tracked.keys.toList()) {
                cancelTrackedInternal(id, deletePartial = false)
            }
            scope.cancel()
            if (instance === this@ExpoDownloadManagerModule) instance = null
        }
    }

    // ----- Download coroutine -----

    private suspend fun runDownload(t: Tracked, attempt: Int = 0): Unit = withContext(Dispatchers.IO) {
        val maxRetries = 3
        val partFile = File("${t.destPath}.part")
        val finalFile = File(t.destPath)

        try {
            // If the final file already exists and is non-empty, don't
            // re-download — just emit complete with its known size.
            if (finalFile.exists() && finalFile.length() > 1024) {
                val size = finalFile.length()
                t.bytesDownloaded.set(size)
                t.bytesTotal.set(size)
                emitComplete(t, size)
                untrack(t.downloadId)
                return@withContext
            }

            // Inspect any existing partial to decide whether to resume
            val resumeFrom: Long = if (partFile.exists()) partFile.length() else 0L

            val requestBuilder = Request.Builder()
                .url(t.url)
                .header("User-Agent", "MicroGPT/1.0")
                .header("Accept-Encoding", "identity") // disable gzip so byte counts align with file size
            if (resumeFrom > 0) {
                requestBuilder.header("Range", "bytes=$resumeFrom-")
                Log.d(TAG, "[${t.modelName}] resuming from $resumeFrom bytes")
            }

            client.newCall(requestBuilder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    throw Exception("HTTP ${response.code} ${response.message}")
                }

                val body = response.body
                    ?: throw Exception("Empty response body")

                // Figure out the total file size and whether the server
                // honored our Range request.
                val isPartialContent = response.code == 206
                val contentLength = body.contentLength() // bytes remaining to download
                val totalBytes: Long = if (isPartialContent) {
                    // 206 Partial Content. Prefer Content-Range's total
                    // (format: "bytes 100-199/1000") — Content-Length
                    // here is only the remaining bytes.
                    val cr = response.header("Content-Range")
                    val fullFromHeader = cr?.substringAfterLast('/', "")?.toLongOrNull()
                    fullFromHeader
                        ?: if (contentLength > 0) resumeFrom + contentLength else 0L
                } else {
                    // 200 OK — either we didn't ask for a range or the
                    // server doesn't support it. Either way, we're
                    // downloading from byte 0.
                    contentLength
                }
                t.bytesTotal.set(totalBytes)

                // Decide where to start writing. If we asked for a
                // range but got 200, the server doesn't support ranges
                // and we must start over from 0 (blow away the partial).
                val startOffset: Long
                if (resumeFrom > 0 && !isPartialContent) {
                    Log.w(TAG, "[${t.modelName}] server ignored Range — starting from 0")
                    try { partFile.delete() } catch (_: Throwable) {}
                    startOffset = 0L
                } else {
                    startOffset = resumeFrom
                }

                // Ensure the destination directory exists
                partFile.parentFile?.mkdirs()

                // Stream bytes directly into .part using RandomAccessFile
                // so we can resume from an arbitrary offset cleanly.
                val raf = RandomAccessFile(partFile, "rw")
                try {
                    if (startOffset > 0) raf.seek(startOffset) else raf.setLength(0)

                    val source = body.byteStream()
                    val buffer = ByteArray(IO_BUFFER_SIZE)

                    var totalSoFar = startOffset
                    t.bytesDownloaded.set(totalSoFar)
                    t.lastByteAdvanceMs = System.currentTimeMillis()
                    t.lastByteAdvanceValue = totalSoFar
                    t.lastEmitMs = 0 // force an immediate emit on first read
                    t.lastEmitBytes = totalSoFar

                    // Emit a synthetic first progress event immediately
                    // so the UI renders the resume-from baseline instead
                    // of flashing 0%.
                    emitProgressThrottled(t, totalSoFar, totalBytes, force = true)

                    while (isActive) {
                        val read = source.read(buffer)
                        if (read == -1) break
                        raf.write(buffer, 0, read)
                        totalSoFar += read
                        t.bytesDownloaded.set(totalSoFar)

                        // Stuck-watchdog: record the timestamp of the
                        // last byte advance. We check it in emit below.
                        t.lastByteAdvanceMs = System.currentTimeMillis()
                        t.lastByteAdvanceValue = totalSoFar

                        emitProgressThrottled(t, totalSoFar, totalBytes, force = false)
                    }
                } finally {
                    try { raf.close() } catch (_: Throwable) {}
                }

                // If the coroutine was cancelled mid-read, don't finalize.
                // The partial file is preserved for a future resume.
                if (!isActive) {
                    Log.d(TAG, "[${t.modelName}] coroutine cancelled, preserving partial")
                    return@use
                }

                // Size verification. If the server gave us a known
                // Content-Length (totalBytes > 0) but we only read a
                // subset of it, that's a truncated / silent-close and
                // we must NOT promote .part → .gguf. Throwing here
                // sends us into the catch block below, which preserves
                // the partial so a retry can resume via HTTP Range.
                //
                // OkHttp often raises EOFException itself for truncated
                // Content-Length responses, but not for every server
                // configuration (chunked encoding, proxy quirks), so
                // this check is our belt-and-suspenders.
                val finalSize = partFile.length()
                if (totalBytes > 0 && finalSize < totalBytes) {
                    throw Exception(
                        "Download truncated: expected ${formatBytes(totalBytes)}, " +
                            "got ${formatBytes(finalSize)}. Will resume on retry."
                    )
                }

                // Rename .part → final atomically. If the rename fails
                // (different filesystem, etc.) fall back to copy+delete.
                if (finalFile.exists()) {
                    try { finalFile.delete() } catch (_: Throwable) {}
                }
                val renamed = try { partFile.renameTo(finalFile) } catch (_: Throwable) { false }
                if (!renamed) {
                    partFile.copyTo(finalFile, overwrite = true)
                    try { partFile.delete() } catch (_: Throwable) {}
                }

                // Double-check the final file is actually the expected
                // size. If the rename somehow produced a corrupt result,
                // delete it and error out so the UI never shows a broken
                // "Use Model" button for a truncated file.
                val actualFinalSize = finalFile.length()
                if (totalBytes > 0 && actualFinalSize < totalBytes) {
                    try { finalFile.delete() } catch (_: Throwable) {}
                    throw Exception(
                        "Post-rename size mismatch: expected ${formatBytes(totalBytes)}, " +
                            "got ${formatBytes(actualFinalSize)}"
                    )
                }

                t.bytesDownloaded.set(finalSize)
                emitProgressThrottled(t, finalSize, finalSize, force = true)
                emitComplete(t, finalSize)
                untrack(t.downloadId)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Cancellation is expected (user tapped cancel) — no error emit
            Log.d(TAG, "[${t.modelName}] download cancelled")
            untrack(t.downloadId, stopService = tracked.size <= 1)
            throw e
        } catch (e: Throwable) {
            val msg = e.message ?: e.javaClass.simpleName
            val isTransient = msg.contains("timeout", true) ||
                msg.contains("reset", true) ||
                msg.contains("truncated", true) ||
                msg.contains("closed", true) ||
                msg.contains("broken pipe", true) ||
                msg.contains("eof", true) ||
                e is java.net.SocketException ||
                e is java.net.SocketTimeoutException ||
                e is java.io.EOFException

            if (isTransient && attempt < maxRetries && isActive) {
                // Retry with exponential backoff — .part file is preserved
                // so the next attempt resumes via HTTP Range.
                val delay = (2000L * (1L shl attempt)).coerceAtMost(30_000L)
                Log.w(TAG, "[${t.modelName}] transient error (attempt ${attempt + 1}/$maxRetries), retrying in ${delay}ms: $msg")
                kotlinx.coroutines.delay(delay)
                runDownload(t, attempt + 1)
            } else {
                Log.e(TAG, "[${t.modelName}] download failed (attempt ${attempt + 1})", e)
                // IMPORTANT: don't delete the partial file on error. The
                // user can retry and we'll resume from where we left off
                // via HTTP Range. This is the whole point.
                emitError(t, msg)
                untrack(t.downloadId)
            }
        }
    }

    // ----- Event helpers -----

    private fun emitProgressThrottled(
        t: Tracked,
        bytesDownloaded: Long,
        bytesTotal: Long,
        force: Boolean,
    ) {
        val now = System.currentTimeMillis()
        if (!force && now - t.lastEmitMs < PROGRESS_EMIT_INTERVAL_MS) {
            // Still perform the stuck check even when we throttle emits,
            // so a download with very slow bursts doesn't go undetected.
            checkStuck(t, now)
            return
        }

        // Speed calculation (EWMA) between emits.
        val dt = (now - t.lastEmitMs) / 1000.0
        val dBytes = (bytesDownloaded - t.lastEmitBytes).coerceAtLeast(0)
        if (dt > 0 && t.lastEmitMs != 0L) {
            val instant = dBytes.toDouble() / dt
            t.smoothedBps = if (t.smoothedBps == 0.0) instant
            else EWMA_ALPHA * instant + (1 - EWMA_ALPHA) * t.smoothedBps
        }
        t.lastEmitMs = now
        t.lastEmitBytes = bytesDownloaded

        // ETA in seconds, null if speed isn't meaningful yet.
        var eta: Long? = null
        if (bytesTotal > 0 && t.smoothedBps > 50 * 1024) {
            val remaining = (bytesTotal - bytesDownloaded).coerceAtLeast(0)
            val rawEta = remaining / t.smoothedBps
            if (rawEta in 0.0..(24 * 3600).toDouble()) {
                eta = rawEta.toLong()
            }
        }

        try {
            sendEvent(
                "onDownloadProgress",
                mapOf(
                    "downloadId" to t.downloadId.toDouble(),
                    "modelName" to t.modelName,
                    "bytesDownloaded" to bytesDownloaded,
                    "bytesTotal" to bytesTotal,
                    "bytesPerSec" to t.smoothedBps,
                    "etaSeconds" to eta,
                    "status" to STATUS_RUNNING,
                ),
            )
        } catch (_: Throwable) {}

        // Refresh the notification at the same throttled cadence as the
        // JS event so the tray entry mirrors the in-app progress.
        try {
            val pct: Int = if (bytesTotal > 0) {
                ((bytesDownloaded * 100L) / bytesTotal).toInt().coerceIn(0, 100)
            } else -1
            val speedText = if (t.smoothedBps > 1024) {
                " · ${formatBytes(t.smoothedBps.toLong())}/s"
            } else ""
            val notifText = if (bytesTotal > 0) {
                "${formatBytes(bytesDownloaded)} / ${formatBytes(bytesTotal)} ($pct%)$speedText"
            } else {
                "${formatBytes(bytesDownloaded)}$speedText"
            }
            DownloadNotificationHelper.showOrUpdate(
                context,
                downloadId = t.downloadId,
                modelName = t.modelName,
                title = t.modelName,
                text = notifText,
                progress = pct,
            )
        } catch (_: Throwable) {}

        checkStuck(t, now)
    }

    private fun checkStuck(t: Tracked, nowMs: Long) {
        // Only kill a download if it has been alive long enough that we
        // actually expected progress — don't fire on the very first tick.
        if (t.lastByteAdvanceMs == 0L) return
        if (nowMs - t.lastByteAdvanceMs >= STUCK_THRESHOLD_MS) {
            Log.w(TAG, "[${t.modelName}] stuck — no bytes for ${STUCK_THRESHOLD_MS / 1000}s")
            // Cancel the job — the catch block in runDownload will
            // preserve the partial file and emit an error.
            t.job?.cancel()
        }
    }

    private fun emitComplete(t: Tracked, totalBytes: Long) {
        try {
            sendEvent(
                "onDownloadComplete",
                mapOf(
                    "downloadId" to t.downloadId.toDouble(),
                    "modelName" to t.modelName,
                    "destPath" to t.destPath,
                    "bytesTotal" to totalBytes,
                ),
            )
        } catch (_: Throwable) {}
    }

    private fun emitError(t: Tracked, reason: String) {
        try {
            sendEvent(
                "onDownloadError",
                mapOf(
                    "downloadId" to t.downloadId.toDouble(),
                    "modelName" to t.modelName,
                    "reason" to reason,
                ),
            )
        } catch (_: Throwable) {}
    }

    // ----- Tracking / cancellation helpers -----

    private fun cancelTrackedInternal(id: Long, deletePartial: Boolean) {
        val t = tracked.remove(id) ?: return
        try { t.job?.cancel() } catch (_: Throwable) {}
        if (deletePartial) {
            try { File("${t.destPath}.part").delete() } catch (_: Throwable) {}
        }
        try { DownloadNotificationHelper.cancel(context, id) } catch (_: Throwable) {}
    }

    private fun untrack(id: Long, @Suppress("UNUSED_PARAMETER") stopService: Boolean = true) {
        tracked.remove(id)
        try { DownloadNotificationHelper.cancel(context, id) } catch (_: Throwable) {}
    }

    /** Invoked from [CancelDownloadReceiver] when the user taps Cancel. */
    internal fun cancelByModelName(modelName: String) {
        val toCancel = tracked.values.filter { it.modelName == modelName }.toList()
        for (t in toCancel) {
            // Emit error first so the JS side unwinds its activeDownloads
            // set before we drop the tracked entry.
            emitError(t, "Cancelled from notification")
            cancelTrackedInternal(t.downloadId, deletePartial = true)
        }
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024 * 1024 -> String.format("%.1f GB", bytes / 1024.0 / 1024 / 1024)
        bytes >= 1024L * 1024 -> String.format("%.0f MB", bytes / 1024.0 / 1024)
        bytes >= 1024L -> String.format("%.0f KB", bytes / 1024.0)
        else -> "$bytes B"
    }
}
