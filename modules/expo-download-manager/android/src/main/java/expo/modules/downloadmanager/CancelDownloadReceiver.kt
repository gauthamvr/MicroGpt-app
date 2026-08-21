package expo.modules.downloadmanager

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the "Cancel" action tapped on a download notification.
 *
 * Receivers are cheap and don't need any permissions or service
 * declarations — this is the simple replacement for the old foreground
 * service's PendingIntent-to-self pattern. We just route the model
 * name back into [ExpoDownloadManagerModule] which owns the live
 * coroutine and tracking state.
 */
class CancelDownloadReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_CANCEL) return
        val modelName = intent.getStringExtra(EXTRA_MODEL_NAME) ?: return
        ExpoDownloadManagerModule.handleNotificationCancel(modelName)
    }

    companion object {
        const val ACTION_CANCEL = "expo.modules.downloadmanager.ACTION_CANCEL"
        const val EXTRA_MODEL_NAME = "modelName"
    }
}
