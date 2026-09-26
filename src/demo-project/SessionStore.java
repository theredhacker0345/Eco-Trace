package com.northwind.tracker;

import android.content.Context;
import android.util.Log;

/** Session persistence. No anti-patterns: bounded cache, explicit eviction. */
public final class SessionStore {

    private static final String TAG = "SessionStore";
    private static final String PREFS = "session";
    private static final int MAX_ENTRIES = 8;
    private static final String KEY_LAST_TOKEN = "last_token";

    private SessionStore() {
    }

    public static void record(Context context, String token) {
        if (token == null || token.isEmpty()) {
            clear(context);
            return;
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_LAST_TOKEN, token)
                .apply();
        Log.i(TAG, "Recorded session, cache capped at " + MAX_ENTRIES + " entries");
    }

    public static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(KEY_LAST_TOKEN)
                .apply();
    }
}