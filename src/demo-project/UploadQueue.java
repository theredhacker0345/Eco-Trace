package com.northwind.tracker;

import android.util.Log;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * EcoTrace demo fixture -- UploadQueue.
 *
 * A small in-memory queue. It contains no anti-patterns: its presence in the
 * demo is to prove that the coverage matrix distinguishes "checked and clean"
 * from "never looked at", which the exported report renders as an explicit zero.
 */
public final class UploadQueue {

    private static final int MAX_PENDING = 128;
    private static final Deque<double[]> PENDING = new ArrayDeque<>();

    private UploadQueue() {
    }

    public static synchronized void enqueue(double latitude, double longitude) {
        if (PENDING.size() >= MAX_PENDING) {
            PENDING.pollFirst();
        }
        PENDING.addLast(new double[] { latitude, longitude });
    }

    public static synchronized void drainPending() {
        Log.i("UploadQueue", "Draining " + PENDING.size() + " pending uploads");
        PENDING.clear();
    }

    public static synchronized int pendingCount() {
        return PENDING.size();
    }
}
