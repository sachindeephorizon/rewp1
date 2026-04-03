import { GPS } from '../config/constants';
import { getDistance } from './geo';

/**
 * Core GPS processor — shared by foreground & background.
 * Filters noise, applies Kalman, calculates speed from distance/time.
 * Never uses coords.speed. Never sends raw GPS.
 */
export const processLocation = (loc, prev, kalman) => {
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

    // Stationary: drift < threshold → clamp position, zero speed
    if (distance < GPS.MIN_MOVEMENT) {
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
    const filteredDist = getDistance(prev, { latitude: filtered[0], longitude: filtered[1] });
    const speed = filteredDist / dt;

    return {
      latitude: filtered[0],
      longitude: filtered[1],
      speed: speed < GPS.MIN_SPEED ? 0 : speed,
      accuracy,
      timestamp: ts,
      distance: filteredDist,
      moving: true,
    };
  }

  // First reading — initialize Kalman
  kalman.update([latitude, longitude], 1, accuracy);

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
