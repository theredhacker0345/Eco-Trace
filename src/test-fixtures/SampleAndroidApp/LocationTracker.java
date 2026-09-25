package com.example.sampleapp;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;

/**
 * EcoTrace test fixture — LocationTracker.
 *
 * Planted anti-patterns:
 *   L01 (Critical) — GPS update interval of 5 000 ms (< 30 000 ms minimum).
 *                    High-frequency GPS is the single largest battery drain on mobile.
 *   L03 (Critical) — SensorManager.registerListener() called with no matching
 *                    unregisterListener() anywhere in the file; the accelerometer
 *                    stays active when the app is backgrounded.
 *   L04 (High)     — TYPE_ACCELEROMETER used together with step-counting logic.
 *                    The dedicated TYPE_STEP_COUNTER sensor is hardware-assisted
 *                    and runs at a fraction of the power.
 */
public class LocationTracker {

    private final LocationManager locationManager;
    private final SensorManager sensorManager;
    private SensorEventListener stepListener;

    public LocationTracker(Context context) {
        locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        sensorManager   = (SensorManager)   context.getSystemService(Context.SENSOR_SERVICE);
    }

    /**
     * Starts GPS location updates and accelerometer-based step counting.
     * <p>
     * Both registrations are permanent — there is no corresponding stop/unregister
     * call anywhere in this class, matching the L03 anti-pattern.
     */
    public void startTracking() {
        // L01: requestLocationUpdates with 5 000 ms interval — far below the 30 s minimum.
        // GPS hardware is kept powered continuously at this frequency.
        locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                5000,   // minTimeMs — 5 seconds is far too frequent
                0f,     // minDistanceM — no distance filter
                new LocationListener() {
                    @Override
                    public void onLocationChanged(Location location) {
                        // consume location update
                    }

                    @Override
                    public void onStatusChanged(String provider, int status, Bundle extras) { }

                    @Override
                    public void onProviderEnabled(String provider) { }

                    @Override
                    public void onProviderDisabled(String provider) { }
                });

        // L04: Using TYPE_ACCELEROMETER for step counting instead of TYPE_STEP_COUNTER.
        // The full-rate accelerometer wakes the CPU on every sample; TYPE_STEP_COUNTER
        // delivers pre-counted steps from a dedicated low-power hardware sensor.
        Sensor accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        stepListener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                // Manual step detection from raw accelerometer data
                float x = event.values[0];
                float y = event.values[1];
                float z = event.values[2];
                double magnitude = Math.sqrt(x * x + y * y + z * z);
                // Threshold-based step detection (simplified)
                if (magnitude > 12.0) {
                    // count a step
                }
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) { }
        };

        // L03: registerListener with no corresponding unregisterListener anywhere in file.
        // The accelerometer stays active even when the app moves to background,
        // continuously waking the CPU for every sensor sample.
        sensorManager.registerListener(
                stepListener,
                accelerometer,
                SensorManager.SENSOR_DELAY_NORMAL);

        // Missing: sensorManager.unregisterListener(stepListener) in onPause/onStop
    }
}
