import { GPS } from '../config/constants';
import { getDistance } from './geo';

const WINDOW_SIZE = 5;

/**
 * Sliding window buffer for multi-point smoothing.
 * Keeps last N points and returns weighted average (recent points weighted more).
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

    // Weighted average — more recent points get higher weight
    let totalWeight = 0;
    let latSum = 0;
    let lngSum = 0;
    for (let i = 0; i < len; i++) {
      const weight = i + 1; // 1, 2, 3, 4, 5
      latSum += this.buffer[i].lat * weight;
      lngSum += this.buffer[i].lng * weight;
      totalWeight += weight;
    }
    return { lat: latSum / totalWeight, lng: lngSum / totalWeight };
  }

  reset() {
    this.buffer = [];
  }
}

// Export so TrackingScreen and background task can create instances
export { SlidingWindow };

/**
 * Core GPS processor — shared by foreground & background.
 * Filters noise, applies Kalman + sliding window, calculates speed.
 * Never uses coords.speed. Never sends raw GPS.
 *
 * @param {object} loc - GPS location object
 * @param {object|null} prev - previous processed location
 * @param {KalmanFilter2D} kalman - Kalman filter instance
 * @param {boolean} accelStationary - true if accelerometer says device is still
 * @param {SlidingWindow|null} window - sliding window buffer for multi-point smoothing
 */
export const processLocation = (loc, prev, kalman, accelStationary = false, window = null) => {
  const { latitude, longitude, accuracy } = loc.coords;
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

    // Scale stationary threshold by accuracy — worse GPS = higher bar to count as movement
    const dynamicMinMovement = Math.max(GPS.MIN_MOVEMENT, accuracy * 0.8);

    // If accelerometer says still, treat as stationary regardless of GPS
    if (accelStationary || distance < dynamicMinMovement) {
      kalman.update([prev.latitude, prev.longitude], dt, accuracy, true);
      return {
        latitude: prev.latitude,
        longitude: prev.longitude,
        speed: 0,
        accuracy,
        timestamp: ts,
        distance: 0,
        moving: false,
      };
    }

    // Apply Kalman filter (not stationary)
    const filtered = kalman.update([latitude, longitude], dt, accuracy, false);

    // Multi-point smoothing — push Kalman output into sliding window
    let smoothLat = filtered[0];
    let smoothLng = filtered[1];
    if (window) {
      window.push(filtered[0], filtered[1]);
      const avg = window.average();
      smoothLat = avg.lat;
      smoothLng = avg.lng;
    }

    const smoothedDist = getDistance(prev, { latitude: smoothLat, longitude: smoothLng });
    const speed = smoothedDist / dt;

    return {
      latitude: smoothLat,
      longitude: smoothLng,
      speed: speed < GPS.MIN_SPEED ? 0 : speed,
      accuracy,
      timestamp: ts,
      distance: smoothedDist,
      moving: true,
    };
  }

  // First reading — initialize Kalman + window
  kalman.update([latitude, longitude], 1, accuracy);
  if (window) {
    window.reset();
    window.push(latitude, longitude);
  }

  return {
    latitude,
    longitude,
    speed: 0,
    accuracy,
    timestamp: ts,
    distance: 0,
    moving: false,
  };
};
