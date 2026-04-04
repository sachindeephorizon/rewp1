import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { BACKGROUND_TASK, STORAGE_KEY, BACKEND_URL, GPS } from '../config/constants';

const APP_STATE_KEY = 'tracking_app_state';

let bgPrev = null;

export const resetBackgroundState = () => {
  bgPrev = null;
};

// ── Light filtering only ─────────────────────────────────────────────
// Drops bad GPS readings only. Heavy smoothing done on backend.
const getDistance = (a, b) => {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
};

const lightFilter = (loc, prev) => {
  const { latitude, longitude, accuracy } = loc.coords;
  const ts = loc.timestamp;

  if (!accuracy || accuracy > GPS.MAX_ACCURACY) return null;
  if (!latitude || !longitude) return null;

  if (prev) {
    const timeDiff = ts - prev.timestamp;
    if (timeDiff < GPS.MIN_TIME_MS) return null;

    const distance = getDistance(prev, { latitude, longitude });
    const dt = timeDiff / 1000;
    const speed = distance / dt;

    if (distance > GPS.MAX_JUMP) return null;
    if (speed > GPS.MAX_SPEED) return null;

    return { latitude, longitude, accuracy, timestamp: ts, speed, distance };
  }

  return { latitude, longitude, accuracy, timestamp: ts, speed: 0, distance: 0 };
};

TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;

  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const appState = await SecureStore.getItemAsync(APP_STATE_KEY);
    const loc = data.locations?.[0];

    // Skip if no user, no location, or foreground is already handling it
    if (!userId || !loc || appState === 'foreground') return;

    const result = lightFilter(loc, bgPrev);
    if (!result) return;

    bgPrev = {
      latitude: result.latitude,
      longitude: result.longitude,
      timestamp: result.timestamp,
    };

    // Abort fetch if it hangs — prevents OS from killing the task
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      await fetch(`${BACKEND_URL}/${userId}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: result.latitude,
          lng: result.longitude,
          speed: result.speed,
          accuracy: result.accuracy,
          timestamp: result.timestamp,
        }),
        signal: controller.signal,
      });
    } catch {
      // Network error or aborted — next task run will retry
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
});