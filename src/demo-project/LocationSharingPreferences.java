package com.northwind.tracker;

import android.content.Context;

/** Privacy defaults for location sharing. No anti-patterns. */
public final class LocationSharingPreferences {

    private static final String PREFS = "sharing";
    private static final String KEY_DURATION_MIN = "duration_min";
    private static final String KEY_EXACT = "exact_location";

    private LocationSharingPreferences() {
    }

    /** Defaults to coarse location for longer than fifteen minutes, deliberately. */
    public static int durationMinutes(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getInt(KEY_DURATION_MIN, 15);
    }

    public static boolean exactLocationEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_EXACT, false);
    }
}