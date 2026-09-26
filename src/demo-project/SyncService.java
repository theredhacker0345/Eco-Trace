package com.northwind.tracker;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * EcoTrace demo fixture -- SyncService.
 *
 * Planted anti-patterns:
 *   A01 (High) -- onStartCommand() returns START_STICKY and the class never
 *                 calls stopSelf(). Android restarts the service after every
 *                 kill, so a sync that has nothing to do keeps being rescheduled.
 *   W04 (Critical) -- PARTIAL_WAKE_LOCK acquired inside a background Service.
 *                 Services carry no built-in wake handling; the lock is the
 *                 only thing keeping the CPU alive, which is exactly why the
 *                 leak in NetworkManager matters.
 */
public class SyncService extends Service {

    private PowerManager.WakeLock serviceWakeLock;

    public static void enqueue(Context context) {
        context.startService(new Intent(context, SyncService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // W04: a partial wake lock inside a Service. This is the intended
        // design -- it holds the CPU across the sync so the radio can sleep --
        // but it also means every failure downstream leaks it, because nothing
        // in this class can release a lock it does not own.
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        serviceWakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "SyncService:ServiceWakeLock");
        serviceWakeLock.acquire(10 * 60 * 1000L);

        // The hop that makes this a chain rather than an isolated finding.
        SyncEngine.startSyncCycle(getApplicationContext());

        // A01: START_STICKY with no stopSelf() anywhere in the class. The
        // service is rescheduled after every low-memory kill regardless of
        // whether there was any work to do.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
