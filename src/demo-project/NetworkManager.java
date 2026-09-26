package com.northwind.tracker;

import android.content.Context;
import android.os.PowerManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import java.io.IOException;

/**
 * EcoTrace demo fixture -- NetworkManager.
 *
 * This file holds the demo's deepest finding. Reached from
 * SyncService.onStartCommand -> SyncEngine.startSyncCycle ->
 * UserRepository.syncUserProfile -> fetchUserProfile, it is the symptom of the
 * WAKEUP alarm registered in MainActivity, four hops upstream.
 *
 * Planted anti-patterns:
 *   W01 (Critical) -- WakeLock.acquire() present, and the release() that should
 *                     balance it is on the success path only. Any exception
 *                     between here and the response leaks the lock for its full
 *                     10-minute timeout. At 96 sync triggers a day that is
 *                     32.6 seconds of unnecessary screen-off CPU daily, and the
 *                     radio never gets to idle.
 *   N02 (High)     -- OkHttpClient with no connectTimeout(). A thread blocks
 *                     indefinitely against an unreachable host, holding the
 *                     wake lock open for the whole default socket timeout.
 *   N03 (High)     -- no readTimeout(), same failure mode on the response leg.
 */
public final class NetworkManager {

    private static final String PROFILE_ENDPOINT = "https://api.northwind.example/v1/profile";

    private NetworkManager() {
    }

    /**
     * Fetches the user profile over the network.
     */
    public static String fetchUserProfile(Context context) {
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock networkWakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "NetworkManager:FetchWakeLock");

        // W01: acquired, and the matching release() is below on the success
        // path only. The IOException handler returns without releasing.
        networkWakeLock.acquire(10 * 60 * 1000L);

        // N02 + N03: a client with no timeouts configured at all.
        OkHttpClient client = new OkHttpClient();

        Request request = new Request.Builder().url(PROFILE_ENDPOINT).build();

        try (Response response = client.newCall(request).execute()) {
            String body = response.body() != null ? response.body().string() : null;
            networkWakeLock.release();
            return body;
        } catch (IOException e) {
            // W01: the error path. The lock acquired above is still held, and
            // nothing in the caller's finally block can release it, because the
            // lock never left this method's scope.
            return null;
        }
    }
}
