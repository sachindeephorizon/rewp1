export const BACKEND_URL = 'http://192.168.0.187:9001';
export const BACKGROUND_TASK = 'background-location-task';
export const STORAGE_KEY = 'activeUserId';
export const TRACKING_ACTIVE_KEY = 'tracking_active';
export const APP_STATE_KEY = 'tracking_app_state';

export const GPS = {
  MAX_ACCURACY: 35,
  MAX_JUMP: 300,
  MAX_SPEED: 80,
  MIN_MOVEMENT: 4,
  MIN_SPEED: 0.3,
  SMOOTH: 0.3,
  MIN_TIME_MS: 1000,
  MAX_GAP_MS: 60000,
  STATIONARY_COUNT: 3,
  GPS_INTERVAL_MOVING: 2000,
  GPS_INTERVAL_STATIONARY: 15000,
  GPS_INTERVAL_BACKGROUND: 5000,
};

export const TRACKING = {
  APP_STATE_FOREGROUND: 'foreground',
  APP_STATE_BACKGROUND: 'background',
  SESSION_KEY: 'tracking_session_id',
  TRAIL_LIMIT: 40,
  PING_INTERVAL_MS: 3000,
  STATIONARY_PING_COOLDOWN_MS: 30000,
};
