package com.northwind.tracker

import android.content.Context
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * EcoTrace demo fixture -- SensorBridge (Kotlin).
 *
 * Present so the demo exercises the Kotlin detectors too: the analyzer runs
 * most patterns as one combined regex, and the class-declaration detectors
 * (W03, W04, W05, N05, A01, A02, A03) carry Kotlin-specific variants.
 *
 * Planted anti-patterns:
 *   W04 (Critical) -- PARTIAL_WAKE_LOCK inside a coroutine scope that is never
 *                     cancelled, so the lock outlives the work it was for.
 *   N01 (High)     -- network call inside a delay() loop with no exit
 *                     condition and no backoff.
 */
class SensorBridge(private val context: Context) {

    private val client = OkHttpClient()
    private val scope = CoroutineScope(Dispatchers.IO)

    fun startStreaming() {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager

        // W04: partial wake lock in Kotlin, held for the life of the scope.
        val sensorLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "SensorBridge:StreamingLock"
        )
        sensorLock.acquire(5 * 60 * 1000L)

        scope.launch {
            // N01: an unbounded retry loop. `while (true)` with no cancellation
            // check means this keeps the radio up for as long as the process
            // lives, which for a foreground service is until the user swipes it
            // away.
            while (true) {
                val request = Request.Builder()
                    .url("https://telemetry.northwind.example/v1/stream")
                    .build()
                client.newCall(request).execute().close()
                delay(5000)
            }
        }
    }
}
