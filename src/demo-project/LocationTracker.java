package com.northwind.tracker;

import android.annotation.SuppressLint;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * EcoTrace demo fixture -- LocationTracker.
 *
 * Planted anti-patterns:
 *   L01 (Critical) -- GPS_PROVIDER registered at a 5000 ms interval. Sub-30s GPS
 *                     is the single largest battery drain on a mobile device:
 *                     the radio cannot sleep and the CPU cannot idle while a fix
 *                     is pending. PRIORITY_BALANCED_POWER_ACCURACY exists for
 *                     exactly this case and is not used.
 *   L02 (High)     -- FINE_LOCATION requested, where COARSE would satisfy a
 *                     share-a-location feature. FINE costs roughly three times
 *                     the power of COARSE for no benefit at city-block accuracy.
 *   L03 (Critical) -- Sensor/location listener registered in onCreate with no
 *                     matching removeUpdates() anywhere in the class, so the
 *                     provider keeps the callback alive after the service is gone.
 */
public class LocationTracker extends Service {

    private static final long UPDATE_INTERVAL_MS = 5000;
    private static final float MIN_DISTANCE_M = 0f;

    private LocationManager locationManager;
    private LocationListener listener;
    private PowerManager.WakeLock trackingWakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        trackingWakeLock = getSystemService(PowerManager.class)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LocationTracker:WakeLock");
        trackingWakeLock.acquire();

        // L02: FINE_LOCATION for a feature that only needs neighbourhood accuracy.
        requestLocationUpdates();
    }

    @SuppressLint("MissingPermission")
    private void requestLocationUpdates() {
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        listener = new LocationListener() {
            @Override
            public void onLocationChanged(android.location.Location location) {
                UploadQueue.enqueue(location.getLatitude(), location.getLongitude());
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
            }

            @Override
            public void onProviderEnabled(String provider) {
            }

            @Override
            public void onProviderDisabled(String provider) {
            }
        };

        // L01: GPS at 5 seconds, zero metres of displacement required, and no
        // power priority. Every one of those four choices is the wrong default
        // for a background tracker.
        locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                UPDATE_INTERVAL_MS,
                MIN_DISTANCE_M,
                listener,
                getMainLooper());
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
