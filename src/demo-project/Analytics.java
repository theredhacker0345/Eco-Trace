package com.northwind.tracker;

import java.util.concurrent.atomic.AtomicLong;

/** In-memory counters. No anti-patterns: allocation-free counters, no polling. */
public final class Analytics {

    private static final AtomicLong SYNC_SUCCESSES = new AtomicLong();
    private static final AtomicLong SYNC_FAILURES = new AtomicLong();

    private Analytics() {
    }

    static void recordSuccess() {
        SYNC_SUCCESSES.incrementAndGet();
    }

    static void recordFailure() {
        SYNC_FAILURES.incrementAndGet();
    }

    public static long successCount() {
        return SYNC_SUCCESSES.get();
    }

    public static long failureCount() {
        return SYNC_FAILURES.get();
    }
}