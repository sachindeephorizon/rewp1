import { BACKEND_URL } from '../config/constants';

const normalizePingPayload = (payload) => {
  if (!payload) return null;

  if (typeof payload.lat === 'number' && typeof payload.lng === 'number') {
    return payload;
  }

  return {
    lat: payload.latitude,
    lng: payload.longitude,
    speed: payload.speed,
    accuracy: payload.accuracy,
    heading: payload.heading ?? null,
    moving: payload.moving,
    distance: payload.distance,
    activity: payload.activity,
    timestamp: payload.timestamp,
    source: payload.source,
    appState: payload.appState,
    sequence: payload.sequence,
    sessionId: payload.sessionId,
    rideChannel: payload.rideChannel,
    gpsIntervalMs: payload.gpsIntervalMs,
    driverId: payload.driverId,
  };
};

export const postLocationUpdate = async (userId, payload, timeoutMs = 5000) => {
  const requestBody = normalizePingPayload(payload);
  if (!requestBody) {
    return { ok: false, status: 'invalid_payload' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BACKEND_URL}/${userId}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    return { ok: response.ok, response };
  } catch {
    return { ok: false, status: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Send a processed location ping to the backend.
 * Returns { ok: boolean, status: string }.
 * Aborts after 5s to prevent promise pile-up on the ping interval.
 */
export const sendPing = async (userId, payload) => {
  const result = await postLocationUpdate(userId, payload, 5000);
  if (result.status) {
    return { ok: false, status: result.status };
  }

  const res = result.response;
  if (!res.ok) {
    if (res.status === 429) return { ok: false, status: 'rate_limited' };
    if (res.status >= 500) return { ok: false, status: 'server_error' };
    return { ok: false, status: 'error' };
  }

  const data = await res.json();
  return {
    ok: true,
    status: data.filtered ? 'filtered' : 'synced',
    forceRefresh: !!data.forceRefresh,
    deviationAlert: data.deviationAlert || null,
    arrivalDetected: !!data.arrivalDetected,
    inactivityFlag: !!data.inactivityFlag,
  };
};

/**
 * Fetch total distance for the active session from backend.
 */
export const fetchSessionDistance = async (userId) => {
  try {
    const res = await fetch(`${BACKEND_URL}/user/${userId}/session-distance`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data.distance : null;
  } catch {
    return null;
  }
};

/**
 * Set a destination on the backend. Backend computes the OSRM route + H3 corridor.
 * Returns { ok, distance, duration }.
 */
export const setDestination = async (userId, origin, destination, name) => {
  try {
    const res = await fetch(`${BACKEND_URL}/destination/${userId}/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, destination, name }),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
};

/**
 * Clear the destination on the backend.
 */
export const clearDestination = async (userId) => {
  try {
    await fetch(`${BACKEND_URL}/destination/${userId}/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {}
};

/**
 * Get remaining distance to destination from the backend.
 * Returns { ok, active, remaining, destination, name }.
 */
export const getDestinationRemaining = async (userId) => {
  try {
    const res = await fetch(`${BACKEND_URL}/destination/${userId}/remaining`);
    if (!res.ok) return { ok: false, active: false };
    return await res.json();
  } catch {
    return { ok: false, active: false };
  }
};

/**
 * Check if an agent has requested a forced location update for this user.
 * Returns { pending: boolean }.
 */
export const checkForceRequest = async (userId) => {
  try {
    const res = await fetch(`${BACKEND_URL}/user/${userId}/request-location`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return { pending: false };
    const data = await res.json();
    return { pending: !!data.pending };
  } catch {
    return { pending: false };
  }
};

/**
 * Tell backend to flush session from Redis → PostgreSQL.
 * Aborts after 8s — fire-and-forget but shouldn't hang forever.
 */
export const sendStop = async (userId) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    await fetch(`${BACKEND_URL}/${userId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } catch {
    // Network error or timeout — ignore, session will expire naturally
  } finally {
    clearTimeout(timeout);
  }
};
