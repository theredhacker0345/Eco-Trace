package com.northwind.tracker;

/** Build-time configuration. No anti-patterns: reads from resources, caches once. */
public final class AppConfig {

    private static final String PREFS = "config";
    private static final String KEY_SYNC_INTERVAL_MIN = "sync_interval_min";
    private static final int DEFAULT_SYNC_INTERVAL_MIN = 360;

    private AppConfig() {
    }

    public static int syncIntervalMinutes(android.content.Context context) {
        return context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .getInt(KEY_SYNC_INTERVAL_MIN, DEFAULT_SYNC_INTERVAL_MIN);
    }
}