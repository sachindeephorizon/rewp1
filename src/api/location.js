import { BACKEND_URL } from '../config/constants';

/**
 * Send a processed location ping to the backend.
 * Returns { ok: boolean, status: string }.
 * Aborts after 5s to prevent promise pile-up on the ping interval.
 */
export const sendPing = async (userId, r) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

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
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 429) return { ok: false, status: 'rate_limited' };
      if (res.status >= 500) return { ok: false, status: 'server_error' };
      return { ok: false, status: 'error' };
    }

    const data = await res.json();
    return { ok: true, status: data.filtered ? 'filtered' : 'synced' };
  } catch {
    return { ok: false, status: 'offline' };
  } finally {
    clearTimeout(timeout);
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