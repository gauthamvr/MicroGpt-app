package expo.modules.downloadmanager

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Posts a plain progress notification for each active download.
 *
 * No foreground service — these are ordinary user-visible notifications
 * via NotificationManagerCompat. POST_NOTIFICATIONS is the only
 * permission needed (no FOREGROUND_SERVICE_DATA_SYNC, so no Play Store
 * policy declaration required).
 *
 * One notification per download id so concurrent downloads each show
 * their own row with their own Cancel action. The cancel action goes
 * to a BroadcastReceiver, which calls back into the module.
 */
internal object DownloadNotificationHelper {

    private const val CHANNEL_ID = "microgpt_downloads"
    private const val CHANNEL_NAME = "Model Downloads"

    private var channelEnsured = false

    private fun ensureChannel(context: Context) {
        if (channelEnsured) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW, // no heads-up, no sound
            ).apply {
                description = "Progress for MicroGPT model downloads"
                setShowBadge(false)
                enableVibration(false)
                enableLights(false)
            }
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
        channelEnsured = true
    }

    /**
     * Show or refresh the notification for [downloadId].
     *
     * @param progress 0..100 for a determinate bar, any other value
     *                 (e.g. -1) for indeterminate.
     */
    fun showOrUpdate(
        context: Context,
        downloadId: Long,
        modelName: String,
        title: String,
        text: String,
        progress: Int,
    ) {
        ensureChannel(context)

        val cancelIntent = Intent(context, CancelDownloadReceiver::class.java).apply {
            action = CancelDownloadReceiver.ACTION_CANCEL
            setPackage(context.packageName)
            putExtra(CancelDownloadReceiver.EXTRA_MODEL_NAME, modelName)
        }
        val cancelPi = PendingIntent.getBroadcast(
            context,
            // requestCode unique per download so PendingIntents don't collide
            downloadId.toInt(),
            cancelIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Cancel",
                cancelPi,
            )

        if (progress in 0..100) {
            builder.setProgress(100, progress, false)
        } else {
            builder.setProgress(0, 0, true)
        }

        try {
            NotificationManagerCompat.from(context).notify(downloadId.toInt(), builder.build())
        } catch (_: SecurityException) {
            // Notifications denied (Android 13+). Silently no-op — the
            // download still runs, just without a tray entry.
        } catch (_: Throwable) {}
    }

    fun cancel(context: Context, downloadId: Long) {
        try {
            NotificationManagerCompat.from(context).cancel(downloadId.toInt())
        } catch (_: Throwable) {}
    }
}
