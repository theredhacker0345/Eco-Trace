package com.northwind.tracker;

/**
 * An immutable user profile. No anti-patterns.
 *
 * Present in the demo to show the coverage matrix distinguishing "checked and
 * clean" from "never looked at", which the report renders as an explicit zero.
 */
public final class UserProfile {

    private final long id;
    private final String displayName;
    private final long lastSeenEpochMillis;

    public UserProfile(long id, String displayName, long lastSeenEpochMillis) {
        this.id = id;
        this.displayName = displayName;
        this.lastSeenEpochMillis = lastSeenEpochMillis;
    }

    public long id() {
        return id;
    }

    public String displayName() {
        return displayName;
    }

    public long lastSeenEpochMillis() {
        return lastSeenEpochMillis;
    }

    public boolean isStale(long nowEpochMillis, long maxAgeMillis) {
        return nowEpochMillis - lastSeenEpochMillis > maxAgeMillis;
    }
}