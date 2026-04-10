import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import {
  APP_STATE_KEY,
  BACKGROUND_TASK,
  GPS,
  STORAGE_KEY,
  TRACKING,
  TRACKING_ACTIVE_KEY,
  TRACKING_TOTAL_DISTANCE_KEY,
} from '../config/constants';
import { postLocationUpdate } from '../api/location';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';
import { buildTrackingPayload } from '../utils/trackingPayload';

// Background state is managed only by the task.
let bgPrev = null;
const bgKalman = new KalmanFilter2D();
const bgWindow = new SlidingWindow();
let bgSequence = 0;

export const resetBackgroundState = () => {
  bgPrev = null;
  bgKalman.reset();
  bgWindow.reset();
  bgSequence = 0;
};

TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;

  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const trackingActive = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
    const appState = await SecureStore.getItemAsync(APP_STATE_KEY);
    const sessionId = await SecureStore.getItemAsync(TRACKING.SESSION_KEY);
    const locations = Array.isArray(data.locations)
      ? [...data.locations].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      : [];

    if (trackingActive !== 'true' || !userId || locations.length === 0) return;

    for (const loc of locations) {
      const result = processLocation(loc, bgPrev, bgKalman, false, bgWindow);
      if (!result) continue;

      bgPrev = {
        latitude: result.latitude,
        longitude: result.longitude,
        timestamp: result.timestamp,
      };

      bgSequence += 1;

      if (result.moving && result.distance > 0) {
        const currentDistanceRaw = await SecureStore.getItemAsync(TRACKING_TOTAL_DISTANCE_KEY);
        const currentDistance = currentDistanceRaw ? Number(currentDistanceRaw) : 0;
        const safeCurrentDistance =
          Number.isFinite(currentDistance) && currentDistance >= 0 ? currentDistance : 0;
        const nextDistance = safeCurrentDistance + result.distance;
        await SecureStore.setItemAsync(TRACKING_TOTAL_DISTANCE_KEY, String(nextDistance));
      }

      const payload = buildTrackingPayload({
        userId,
        result,
        sessionId,
        sequence: bgSequence,
        source: 'background_task',
        appState: appState || TRACKING.APP_STATE_BACKGROUND,
        gpsIntervalMs: GPS.GPS_INTERVAL_BACKGROUND,
      });

      await postLocationUpdate(userId, payload, 8000);
    }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
});
