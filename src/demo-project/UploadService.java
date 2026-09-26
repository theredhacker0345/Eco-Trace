package com.northwind.tracker;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;

/**
 * EcoTrace demo fixture -- UploadService.
 *
 * Planted anti-patterns:
 *   W06 (High)     -- nested wake locks: the service holds its own partial lock
 *                     and then calls into a helper that acquires a second one
 *                     for the same work. Two locks for one job means the inner
 *                     release can unbalance the outer count.
 *   A06 (High)     -- AlarmManager ELAPSED_REALTIME_WAKEUP for upload retries,
 *                     which should be a constrained WorkManager job.
 *   N06 (High)     -- a polling retry loop where the platform already offers
 *                     WorkManager's network constraint for free.
 */
public class UploadService extends Service {

    private PowerManager.WakeLock uploadWakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private static final long RETRY_MS = 15000;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);

        // W06: first of two locks for a single upload.
        uploadWakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, "UploadService:OuterLock");
        uploadWakeLock.acquire();

        Runnable retry = new Runnable() {
            @Override
            public void run() {
                // N06: polling, when WorkManager's network constraint would let
                // the platform decide when the radio can stay down.
                UploadQueue.drainPending();
                handler.postDelayed(this, RETRY_MS);
            }
        };
        handler.post(retry);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
