package com.northwind.tracker;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * EcoTrace demo fixture -- UserRepository.
 *
 * A pass-through layer with no anti-patterns of its own. It exists so the demo's
 * causal chain has genuine depth: the defect is four hops from the lifecycle
 * entry point, across three files, and a single-file analyser cannot see that.
 */
public final class UserRepository {

    private static final String PREFS = "user_profile";

    private UserRepository() {
    }

    /**
     * Reconciles the local profile with the server. Called from the sync cycle.
     */
    public static void syncUserProfile(Context context) {
        SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        String cachedJson = prefs.getString("last_response", null);
        if (cachedJson == null) {
            // First run: no cache, so go to the network. This is the branch
            // that reaches the WakeLock leak in NetworkManager.
            String fresh = NetworkManager.fetchUserProfile(context);
            if (fresh != null) {
                prefs.edit().putString("last_response", fresh).apply();
            }
        }
    }
}
