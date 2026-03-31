import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { BACKGROUND_TASK, STORAGE_KEY, BACKEND_URL } from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation } from '../utils/processLocation';

// Background state — managed exclusively by the background task.
// Foreground must NEVER overwrite these.
let bgPrev = null;
const bgKalman = new KalmanFilter2D();

export const resetBackgroundState = () => {
  bgPrev = null;
  bgKalman.reset();
};

TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;
  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const loc = data.locations?.[0];
    if (!userId || !loc) return;

    const result = processLocation(loc, bgPrev, bgKalman);
    if (!result) return;

    bgPrev = { latitude: result.latitude, longitude: result.longitude, timestamp: result.timestamp };

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
    });
  } catch (err) {
    console.error('Background sync failed:', err);
  }
});
