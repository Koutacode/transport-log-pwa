/*
 * geo.ts
 *
 * Utilities for working with geographic information. This module
 * computes distances between coordinates using the haversine formula
 * and manages geolocation tracking. Consumers provide callback
 * functions to receive coordinate updates.
 */

export interface Coordinate {
  lat: number;
  lng: number;
  timestamp: number;
}

// Earth's radius in kilometres.
const EARTH_RADIUS_KM = 6371;

/**
 * Convert degrees to radians.
 */
function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Compute the great-circle distance between two geographic points using
 * the haversine formula. The result is returned in kilometres.
 */
export function haversineDistance(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * Start watching the device's location. Returns the watch ID so that
 * the caller can later stop the watch. The callback is invoked each
 * time a new position is available.
 */
export function watchPosition(
  callback: (coord: Coordinate) => void,
  errorCallback?: (error: GeolocationPositionError) => void
): number {
  if (!('geolocation' in navigator)) {
    throw new Error('Geolocation is not supported by this browser');
  }
  const watchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      callback({ lat: latitude, lng: longitude, timestamp: pos.timestamp });
    },
    error => {
      if (errorCallback) errorCallback(error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 60_000
    }
  );
  return watchId;
}

/**
 * Stop a previously started geolocation watch.
 */
export function clearWatch(watchId: number): void {
  if ('geolocation' in navigator) {
    navigator.geolocation.clearWatch(watchId);
  }
}
