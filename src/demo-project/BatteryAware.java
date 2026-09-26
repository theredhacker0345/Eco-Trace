package com.northwind.tracker;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;

/**
 * Battery state reader. No anti-patterns.
 *
 * Worth noting for a reader: this is the correct way to ask whether the device
 * is charging, which is exactly the constraint EcoTrace keeps telling people to
 * hand to WorkManager instead of an alarm.
 */
public final class BatteryAware {

    private BatteryAware() {
    }

    public static boolean isCharging(Context context) {
        Intent status = context.registerReceiver(
                null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (status == null) {
            return false;
        }
        int plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
        return plugged != 0;
    }
}