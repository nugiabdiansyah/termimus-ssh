package com.termimus.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the app process alive while SSH, SFTP or port-forwarding sessions are open.
 *
 * Android freezes a backgrounded app about a minute after it leaves the screen and
 * tears down its sockets, which kills every live session. A foreground service
 * (with its mandatory ongoing notification) exempts the process from that. The
 * Rust side starts this service when the first session opens and stops it when
 * the last one closes (see `src-tauri/src/android_keepalive.rs`).
 */
class SessionKeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Low importance: no sound or heads-up, just a quiet status entry.
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, getString(R.string.keepalive_channel), NotificationManager.IMPORTANCE_LOW)
      )
    }

    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_termimus)
      .setContentTitle(getString(R.string.keepalive_title))
      .setContentText(getString(R.string.keepalive_text))
      .setContentIntent(openApp)
      .setOngoing(true)
      .setShowWhen(false)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // If the system does kill the process, do not resurrect an empty service:
    // the sessions it was protecting are gone.
    return START_NOT_STICKY
  }

  companion object {
    private const val CHANNEL_ID = "active-sessions"
    private const val NOTIFICATION_ID = 1
  }
}
