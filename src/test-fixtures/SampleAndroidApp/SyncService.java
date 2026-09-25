package com.example.sampleapp;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * EcoTrace test fixture — SyncService.
 *
 * Planted anti-patterns:
 *   W01 (Critical) — WakeLock.acquire() present but release() is not in a
 *                    finally block; the lock is leaked on every exception.
 *   W04 (Critical) — PARTIAL_WAKE_LOCK used inside a background Service.
 *                    Services have no built-in wake constraint handling;
 *                    WorkManager should be used instead.
 *   N02 (High)     — OkHttpClient constructed with no connectTimeout().
 *                    Threads can block indefinitely on slow or unreachable servers.
 *   A01 (High)     — onStartCommand() returns START_STICKY with no stopSelf()
 *                    call anywhere in the class; the Service runs forever.
 */
public class SyncService extends Service {

    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // W01 + W04: PARTIAL_WAKE_LOCK acquired in a background Service, but
        // release() is absent from the error path (catch block below).
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,   // W04: PARTIAL_WAKE_LOCK in Service
                "SyncService:WakeLock");
        wakeLock.acquire();   // W01: acquire without guaranteed release

        // N02: OkHttpClient with no connection timeout — threads block indefinitely.
        OkHttpClient client = new OkHttpClient();   // no connectTimeout()
        Request request = new Request.Builder()
                .url("https://api.example.com/sync")
                .build();

        try {
            Response response = client.newCall(request).execute();
            if (response.body() != null) {
                response.body().close();
            }
            wakeLock.release();
        } catch (Exception e) {
            // W01: wakeLock.release() is missing here.
            // Any network exception leaves the WakeLock permanently held.
            android.util.Log.e("SyncService", "Sync failed", e);
        }

        // A01: No stopSelf() — Service keeps running after work completes.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
