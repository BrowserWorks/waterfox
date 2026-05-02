package org.mozilla.foxxite.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * A Foreground Service to manage the Wireguard tunnel for the Foxxite browser.
 * This service ensures that the VPN connection remains active in the background.
 */
class WireguardTunnelService : Service() {

    override fun onBind(intent: Intent?): IBinder? {
        return null // Not binding to activities, just running as a foreground service.
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Foxxite Secure Tunnel")
            .setContentText("Wireguard VPN is active.")
            // .setSmallIcon(R.drawable.ic_vpn_key) // Placeholder for actual icon
            .build()

        // Start as a foreground service so Android doesn't kill it easily
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Here we would initialize the Wireguard backend (e.g., using wireguard-android library)
        // val config = intent?.getStringExtra("wg_config")
        // WireguardBackend.connect(config)

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // WireguardBackend.disconnect()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = NotificationChannel(
                CHANNEL_ID,
                "Foxxite VPN Service Channel",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager: NotificationManager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(serviceChannel)
        }
    }

    companion object {
        const val CHANNEL_ID = "FoxxiteVpnChannel"
        const val NOTIFICATION_ID = 1
    }
}
