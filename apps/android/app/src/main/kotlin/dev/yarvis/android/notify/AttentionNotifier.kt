package dev.yarvis.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.yarvis.android.MainActivity
import dev.yarvis.android.R
import dev.yarvis.android.data.Arrival
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * Posts a local notification for each new attention item while the app is
 * open or was closed recently (the attention streams stop a while after that).
 * In the foreground the list itself updates, so it notifies only when
 * the attention tab isn't on screen.
 */
class AttentionNotifier(private val context: Context) {
    @Volatile
    var foreground: Boolean = false

    /** Set by the attention screen while it's visible. */
    @Volatile
    var attentionVisible: Boolean = false

    private var job: Job? = null

    fun follow(scope: CoroutineScope, arrivals: Flow<Arrival>) {
        job?.cancel()
        ensureChannel()
        job = scope.launch { arrivals.collect { if (!(foreground && attentionVisible)) post(it) } }
    }

    fun stopFollowing() {
        job?.cancel()
        job = null
        NotificationManagerCompat.from(context).cancelAll()
    }

    private fun ensureChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.attention_channel),
            NotificationManager.IMPORTANCE_HIGH,
        )
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun post(arrival: Arrival) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_ATTENTION, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(arrival.title)
            .setContentText(arrival.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(arrival.body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Prompts can hold commands and paths, so a locked phone shows only that something is waiting.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("Yarvis needs you")
                    .build(),
            )
            .build()
        NotificationManagerCompat.from(context).notify(arrival.key.hashCode(), notification)
    }

    private companion object {
        const val CHANNEL_ID = "attention"
    }
}
