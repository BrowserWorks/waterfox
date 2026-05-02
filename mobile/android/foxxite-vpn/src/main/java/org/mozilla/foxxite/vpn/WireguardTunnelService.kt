package org.mozilla.foxxite.vpn

import android.app.Service
import android.content.Intent
import android.os.IBinder

class WireguardTunnelService : Service() {
    override fun onBind(intent: Intent?): IBinder? {
        return null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Wireguard logic here
        return START_STICKY
    }
}
