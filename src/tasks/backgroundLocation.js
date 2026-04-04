import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { BACKGROUND_TASK, STORAGE_KEY, BACKEND_URL } from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';

const APP_STATE_KEY = 'tracking_app_state';

// Background state — managed exclusively by the background task.
// Foreground must NEVER overwrite these.
let bgPrev = null;
const bgKalman = new KalmanFilter2D();
const bgWindow = new SlidingWindow();

export const resetBackgroundState = () => {
  bgPrev = null;
  bgKalman.reset();
  bgWindow.reset();
};

TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;

  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const appState = await SecureStore.getItemAsync(APP_STATE_KEY);
    const loc = data.locations?.[0];

    // Skip if no user, no location, or foreground is already handling it
    if (!userId || !loc || appState === 'foreground') return;

    const result = processLocation(loc, bgPrev, bgKalman, false, bgWindow);
    if (!result) return;

    bgPrev = {
      latitude: result.latitude,
      longitude: result.longitude,
      timestamp: result.timestamp,
    };

    // FIX: abort fetch if it hangs — prevents the OS from killing the task
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
      // Network error or aborted — safe to ignore, next task run will retry
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
});