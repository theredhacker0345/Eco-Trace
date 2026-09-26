package com.northwind.tracker;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.io.IOException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * EcoTrace demo fixture -- UploadService.
 *
 * Planted anti-patterns:
 *   W06 (High)     -- nested wake locks: the service holds its own partial lock
 *                     and then calls into a helper that acquires a second one
 *                     for the same work. Two locks for one job means the inner
 *                     release can unbalance the outer count.
 *   N06 (High)     -- a polling retry loop where the platform already offers
 *                     WorkManager's network constraint for free.
 *   N02 (High)     -- a client with no timeout pinned, inside that loop.
 *   N01 (Critical) -- the request inside the retry callback, so every re-post
 *                     drags the radio up with it.
 */
public class UploadService extends Service {

    private final OkHttpClient client = new OkHttpClient();
    private PowerManager.WakeLock uploadWakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private static final long RETRY_MS = 15000;
    private static final String UPLOAD_ENDPOINT = "https://api.northwind.example/v1/uploads";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);

        // W06: first of two locks for a single upload.
        uploadWakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, "UploadService:OuterLock");
        uploadWakeLock.acquire();

        // W06: the second acquisition, on the same lock, for the same job.
        beginUpload();

        Runnable retry = new Runnable() {
            @Override
            public void run() {
                // N01 + N06: the request is inside the loop body, so every
                // re-post pulls the radio up with it -- and WorkManager's
                // network constraint would have let the platform decide when
                // the radio could stay down.
                Request request = new Request.Builder().url(UPLOAD_ENDPOINT).build();
                try (Response response = client.newCall(request).execute()) {
                    UploadQueue.drainPending();
                } catch (IOException e) {
                    // The handler below retries the whole attempt.
                }
                handler.postDelayed(this, RETRY_MS);
            }
        };
        handler.post(retry);
        return START_NOT_STICKY;
    }

    /**
     * Takes the upload lock a second time. The caller already holds it, so one
     * release cannot balance two acquires.
     */
    private void beginUpload() {
        uploadWakeLock.acquire();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
