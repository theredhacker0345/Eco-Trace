package com.northwind.tracker;

import android.util.Log;

/** Structured logging helper. No anti-patterns: bounded, level-gated, no I/O in render paths. */
public final class Diagnostics {

    private static final String TAG = "Northwind";
    private static final boolean VERBOSE = false;

    private Diagnostics() {
    }

    public static void event(String name) {
        if (VERBOSE) {
            Log.d(TAG, name);
        }
    }

    public static void failure(String name, Throwable cause) {
        Log.w(TAG, name, cause);
    }
}