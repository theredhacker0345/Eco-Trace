package com.northwind.tracker;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * EcoTrace demo fixture -- MainActivity.
 *
 * This is the architectural root of the demo's headline causal chain. The
 * chain EcoTrace reports is:
 *
 *   MainActivity.onCreate()          <- registers a WAKEUP alarm on every launch
 *     -> SyncScheduler.scheduleImmediate()
 *       -> SyncService.enqueue()
 *         -> SyncService.onStartCommand()   <- lifecycle root, wakes the device
 *           -> SyncEngine.startSyncCycle()
 *             -> UserRepository.syncUserProfile()
 *               -> NetworkManager.fetchUserProfile()  <- W01: WakeLock never released
 *
 * Planted anti-patterns:
 *   A06 (High) -- AlarmManager.RTC_WAKEUP for non-critical periodic sync. Wakeup
 *                 alarms force the device out of Doze, defeating Android 6+
 *                 battery optimisation entirely. This is the root cause; the
 *                 WakeLock leak three files downstream is the symptom.
 */
public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // A06: WAKEUP alarm for work that can tolerate deferral.
        // 96 triggers per day at a 15-minute interval, each one pulling the CPU
        // out of Doze, for a background sync that WorkManager would batch.
        AlarmManager alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        Intent syncIntent = new Intent(this, SyncService.class);
        PendingIntent pendingIntent = PendingIntent.getService(
                this, 0, syncIntent, PendingIntent.FLAG_UPDATE_CURRENT);
        alarmManager.setRepeating(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis(),
                15 * 60 * 1000,
                pendingIntent);

        // The scheduling call that anchors the traced chain. AutoTrack chose an
        // alarm instead of a constrained WorkManager job, so nothing batches
        // these requests when the device is idle on battery.
        SyncScheduler.scheduleImmediate(this);
    }
}
