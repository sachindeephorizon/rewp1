import { TRACKING } from '../config/constants';

const cleanUserId = (userId) =>
  String(userId ?? 'driver')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 24) || 'driver';

export const createTrackingSession = (userId) => {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${cleanUserId(userId)}-${Date.now().toString(36)}-${entropy}`;
};

export const getActivityLabel = (speedMps = 0) => {
  if (speedMps <= 0) return 'Stationary';
  if (speedMps * 3.6 < 5) return 'Walking';
  if (speedMps * 3.6 < 20) return 'Cycling';
  return 'Driving';
};

const normalizeHeading = (heading) => {
  if (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0) {
    return null;
  }
  return Math.round(heading * 10) / 10;
};

export const buildTrackingPayload = ({
  userId,
  result,
  sessionId,
  sequence,
  source,
  appState = TRACKING.APP_STATE_FOREGROUND,
  gpsIntervalMs,
}) => ({
  lat: result.latitude,
  lng: result.longitude,
  speed: result.speed,
  accuracy: result.accuracy,
  heading: normalizeHeading(result.heading),
  moving: result.moving,
  distance: result.distance,
  activity: getActivityLabel(result.speed),
  timestamp: result.timestamp,
  source,
  appState,
  sequence,
  sessionId,
  rideChannel: sessionId ? `ride_${sessionId}` : null,
  gpsIntervalMs,
  driverId: cleanUserId(userId),
});
