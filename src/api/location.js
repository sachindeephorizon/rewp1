import { BACKEND_URL } from '../config/constants';

/**
 * Send a processed location ping to the backend.
 * Returns { ok: boolean }.
 */
export const sendPing = async (userId, r) => {
  try {
    const res = await fetch(`${BACKEND_URL}/${userId}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: r.latitude,
        lng: r.longitude,
        speed: r.speed,
        accuracy: r.accuracy,
        timestamp: r.timestamp,
      }),
    });
    if (!res.ok) return { ok: false, status: 'error' };
    const data = await res.json();
    return { ok: true, status: data.filtered ? 'filtered' : 'synced' };
  } catch {
    return { ok: false, status: 'offline' };
  }
};

/**
 * Tell backend to flush session from Redis → PostgreSQL.
 */
export const sendStop = async (userId) => {
  try {
    await fetch(`${BACKEND_URL}/${userId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {}
};
