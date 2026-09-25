package com.example.sampleapp;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * EcoTrace test fixture — MainActivity.
 *
 * Planted anti-patterns:
 *   A06 (High) — AlarmManager RTC_WAKEUP used for non-critical periodic sync.
 *                Wakeup alarms force the device out of Doze mode, defeating
 *                Android 6+ battery optimisation. Should use WorkManager instead.
 */
public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // A06: AlarmManager WAKEUP for non-critical sync work.
        // RTC_WAKEUP wakes the device from Doze every 15 minutes — entirely
        // unnecessary for background data sync that can tolerate deferral.
        AlarmManager alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        Intent syncIntent = new Intent(this, SyncService.class);
        PendingIntent pendingIntent = PendingIntent.getService(
                this, 0, syncIntent, PendingIntent.FLAG_UPDATE_CURRENT);
        alarmManager.setRepeating(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis(),
                15 * 60 * 1000,   // 15-minute interval
                pendingIntent);
    }
}
