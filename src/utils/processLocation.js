import { GPS } from '../config/constants';
import { getDistance } from './geo';

const WINDOW_SIZE = 5;

/**
 * Sliding window — kept for export compatibility but NO LONGER USED
 * in processLocation. Removing it from the pipeline eliminated the
 * position lag on turns that caused scattered/looping points.
 */
class SlidingWindow {
  constructor(size = WINDOW_SIZE) {
    this.size = size;
    this.buffer = [];
  }

  push(lat, lng) {
    this.buffer.push({ lat, lng });
    if (this.buffer.length > this.size) this.buffer.shift();
  }

  average() {
    const len = this.buffer.length;
    if (len === 0) return null;
    if (len === 1) return { lat: this.buffer[0].lat, lng: this.buffer[0].lng };
    let totalWeight = 0, latSum = 0, lngSum = 0;
    for (let i = 0; i < len; i++) {
      const weight = i + 1;
      latSum += this.buffer[i].lat * weight;
      lngSum += this.buffer[i].lng * weight;
      totalWeight += weight;
    }
    return { lat: latSum / totalWeight, lng: lngSum / totalWeight };
  }

  reset() { this.buffer = []; }
}

export { SlidingWindow };

/**
 * Core GPS processor — Kalman filter only, no sliding window.
 *
 * Why sliding window was removed:
 * The 5-point weighted average introduced a ~10-15s position lag.
 * On turns and curves this pulled the current position toward the
 * past path, creating the looping/scattered pattern visible on the
 * dashboard map. Kalman alone is smoother and more accurate for
 * vehicle tracking. Road snapping on the backend handles final cleanup.
 *
 * @param {object} loc - GPS location object
 * @param {object|null} prev - previous processed location
 * @param {KalmanFilter2D} kalman - Kalman filter instance
 * @param {boolean} accelStationary - true if accelerometer says still
 * @param {SlidingWindow|null} window - ignored, kept for API compatibility
 */
export const processLocation = (loc, prev, kalman, accelStationary = false, window = null) => {
  const { latitude, longitude, accuracy, heading } = loc.coords;
  const ts = loc.timestamp;

  if (!accuracy || accuracy > GPS.MAX_ACCURACY) return null;
  if (!latitude || !longitude) return null;
  if (!ts || ts <= 0) return null;

  const point = { latitude, longitude };

  if (prev) {
    const timeDiff = ts - prev.timestamp;
    if (!timeDiff || timeDiff < GPS.MIN_TIME_MS) return null;

    const dt = timeDiff / 1000;
    const distance = getDistance(prev, point);

    if (distance > GPS.MAX_JUMP) return null;

    const rawSpeed = distance / dt;
    if (rawSpeed > GPS.MAX_SPEED) return null;

    // Fixed threshold — no accuracy multiplier
    // (accuracy*0.8 was misclassifying vehicle movement as stationary)
    const isStationary = accelStationary || distance < GPS.MIN_MOVEMENT;

    if (isStationary) {
      kalman.update([prev.latitude, prev.longitude], dt, accuracy, true);
      return {
        latitude: prev.latitude,
        longitude: prev.longitude,
        speed: 0,
        accuracy,
        heading: typeof heading === 'number' && heading >= 0 ? heading : null,
        timestamp: ts,
        distance: 0,
        moving: false,
      };
    }

    // Kalman filter only — no sliding window
    const filtered = kalman.update([latitude, longitude], dt, accuracy, false);

    const filteredDist = getDistance(prev, { latitude: filtered[0], longitude: filtered[1] });
    const speed = filteredDist / dt;

    return {
      latitude: filtered[0],
      longitude: filtered[1],
      speed: speed < GPS.MIN_SPEED ? 0 : speed,
      accuracy,
      heading: typeof heading === 'number' && heading >= 0 ? heading : null,
      timestamp: ts,
      distance: filteredDist,
      moving: true,
    };
  }

  // First reading — initialize Kalman only
  kalman.update([latitude, longitude], 1, accuracy);

  return {
    latitude,
    longitude,
    speed: 0,
    accuracy,
    heading: typeof heading === 'number' && heading >= 0 ? heading : null,
    timestamp: ts,
    distance: 0,
    moving: false,
  };
};
