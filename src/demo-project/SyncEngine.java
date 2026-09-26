package com.northwind.tracker;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.io.IOException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * EcoTrace demo fixture -- SyncEngine.
 *
 * Planted anti-patterns:
 *   N01 (Critical) -- a self-reposting Handler loop with the network call inside
 *                     it. A postDelayed chain that re-arms itself keeps the
 *                     looper -- and therefore the main thread's message queue --
 *                     permanently scheduled, and drags the radio up with it
 *                     every cycle.
 *   N06 (High)     -- that loop is a polling pattern, where WorkManager's
 *                     network constraint would let the platform batch it.
 *   N02 (High)     -- a client with no timeout pinned, so a slow endpoint holds
 *                     a wake lock open for the library default.
 */
public final class SyncEngine {

    private static final Handler HANDLER = new Handler(Looper.getMainLooper());
    private static final long RETRY_INTERVAL_MS = 5000;
    private static final String DELTA_ENDPOINT = "https://api.northwind.example/v1/delta";
    private static final OkHttpClient CLIENT = new OkHttpClient();

    private SyncEngine() {
    }

    /**
     * Entry point for one sync cycle. Called from SyncService.onStartCommand.
     */
    public static void startSyncCycle(final Context context) {
        // The actual work, called directly. This call edge is what lets EcoTrace
        // walk the chain from the WakeLock leak in NetworkManager back to the
        // lifecycle entry point that started it.
        UserRepository.syncUserProfile(context);

        // N01: a self-reposting Handler loop, on top of the direct call. The
        // loop re-arms itself unconditionally, with no backoff and no exit
        // condition, and five seconds is shorter than the Doze maintenance
        // window, so on a doze-restricted device it retries in a band the
        // platform has no opportunity to batch.
        Runnable retry = new Runnable() {
            @Override
            public void run() {
                // N01: the request is inside the loop body, so every re-post
                // pulls the radio up with it.
                Request request = new Request.Builder().url(DELTA_ENDPOINT).build();
                try (Response response = CLIENT.newCall(request).execute()) {
                    Diagnostics.event("sync retry: " + response.code());
                } catch (IOException e) {
                    Diagnostics.event("sync retry failed");
                }
                HANDLER.postDelayed(this, RETRY_INTERVAL_MS);
            }
        };
        HANDLER.postDelayed(retry, RETRY_INTERVAL_MS);
    }
}
