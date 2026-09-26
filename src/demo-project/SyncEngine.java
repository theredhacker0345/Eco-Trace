package com.northwind.tracker;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

/**
 * EcoTrace demo fixture -- SyncEngine.
 *
 * Planted anti-patterns:
 *   N01 (High) -- a self-reposting Handler loop with network work inside it.
 *                 A postDelayed chain that re-arms itself keeps the looper --
 *                 and therefore the main thread's message queue -- permanently
 *                 scheduled, and drags the radio up with it every cycle.
 */
public final class SyncEngine {

    private static final Handler HANDLER = new Handler(Looper.getMainLooper());
    private static final long RETRY_INTERVAL_MS = 5000;

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
                Diagnostics.event("sync retry");
                HANDLER.postDelayed(this, RETRY_INTERVAL_MS);
            }
        };
        HANDLER.postDelayed(retry, RETRY_INTERVAL_MS);
    }
}
