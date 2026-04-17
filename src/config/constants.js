export const BACKEND_URL = 'https://rewp2-production.up.railway.app';
export const BACKGROUND_TASK = 'background-location-task';
export const STORAGE_KEY = 'activeUserId';
export const TRACKING_ACTIVE_KEY = 'tracking_active';
export const APP_STATE_KEY = 'tracking_app_state';
export const TRACKING_TOTAL_DISTANCE_KEY = 'tracking_total_distance_m';
export const NAV_DESTINATION_KEY = 'nav_destination';
export const NAV_ROUTE_KEY = 'nav_route';

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
  GPS_INTERVAL_MOVING: 5000,
  GPS_INTERVAL_STATIONARY: 15000,
  GPS_INTERVAL_BACKGROUND: 10000,
};

// Three-tier GPS model (PDF Section 5)
// Tier 1: Passive — cell tower / WiFi. Minimal battery (~1-2%/hr)
// Tier 2: Active GPS balanced. Moderate battery (~4-6%/hr)
// Tier 3: Full GPS max accuracy. High battery (~10-15%/hr) — emergency only
export const GPS_TIERS = {
  1: {
    accuracy: 'Balanced',            // Expo: Location.Accuracy.Balanced (cell+WiFi)
    foregroundInterval: 30000,        // 30s — passive, just checking in
    backgroundInterval: 60000,        // 60s
    label: 'Passive',
  },
  2: {
    accuracy: 'High',                // Expo: Location.Accuracy.High (GPS, battery-aware)
    foregroundInterval: 15000,        // 15s — active monitoring
    backgroundInterval: 20000,        // 20s
    label: 'Active GPS',
  },
  3: {
    accuracy: 'BestForNavigation',   // Expo: Location.Accuracy.BestForNavigation (max GPS)
    foregroundInterval: 5000,         // 5s — emergency, full power
    backgroundInterval: 5000,         // 5s
    label: 'Emergency GPS',
  },
};

export const TRACKING = {
  APP_STATE_FOREGROUND: 'foreground',
  APP_STATE_BACKGROUND: 'background',
  SESSION_KEY: 'tracking_session_id',
  TRAIL_LIMIT: 40,
  PING_INTERVAL_MS: 3000,
  STATIONARY_PING_COOLDOWN_MS: 30000,
};
