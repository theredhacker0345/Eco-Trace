package com.northwind.tracker;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import java.util.concurrent.TimeUnit;

/**
 * EcoTrace demo fixture -- SyncScheduler.
 *
 * Planted anti-patterns:
 *   A03 (Medium) -- JobScheduler is imported and configured here, but the
 *                   periodic sync is never actually submitted to it. The
 *                   constraints the author wrote are dead code, so background
 *                   sync runs unconditionally, with no charging or network
 *                   requirement to batch it.
 */
public final class SyncScheduler {

    /** Jobs the author intended to constrain, but never enqueued. */
    private static JobScheduler jobScheduler;

    private SyncScheduler() {
    }

    /**
     * Kicks off an immediate sync. Called from MainActivity.onCreate, so this
     * runs on every cold start.
     */
    public static void scheduleImmediate(Context context) {
        // The intent the author meant to constrain.
        Intent intent = new Intent(context, SyncService.class);
        PendingIntent pendingIntent = PendingIntent.getService(
                context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT);

        // A03: these constraints are the right idea and are never applied.
        // schedule() below does not use them; nothing is ever submitted to
        // JobScheduler, so the device has no reason to defer this work.
        JobInfo.Builder builder = new JobInfo.Builder(1001, pendingIntent)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setRequiresCharging(false)
                .setPeriodic(TimeUnit.HOURS.toMillis(6));
        jobScheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);

        SyncService.enqueue(context);
    }
}
