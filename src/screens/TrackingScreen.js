import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
  SafeAreaView,
} from 'react-native';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as IntentLauncher from 'expo-intent-launcher';

import {
  APP_STATE_KEY,
  BACKGROUND_TASK,
  GPS,
  NAV_DESTINATION_KEY,
  NAV_ROUTE_KEY,
  STORAGE_KEY,
  TRACKING,
  TRACKING_ACTIVE_KEY,
  TRACKING_TOTAL_DISTANCE_KEY,
} from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';
import { fetchSessionDistance, sendPing, sendStop } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import {
  buildTrackingPayload,
  createTrackingSession,
  getActivityLabel,
} from '../utils/trackingPayload';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';
import RouteScreen from './RouteScreen';
import {
  haversineMeters,
  snapToRoute,
  sliceRouteFrom,
  routeLengthMeters,
  formatDistanceMeters,
} from '../utils/geo';
import { fetchOsrmRoute } from '../api/routing';

const MAX_LOGS = 50;
const STATIONARY_SWITCH_THRESHOLD = 4;

export default function TrackingScreen({ user, onLogout }) {
  const userId = user.name || user.email || String(user.id);

  const [location, setLocation] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [gpsAcc, setGpsAcc] = useState(null);
  const [totalDist, setTotalDist] = useState(0);
  const [serverStatus, setServerStatus] = useState('--');
  const [sessionId, setSessionId] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [trail, setTrail] = useState([]);
  const [debugLogs, setDebugLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showRoute, setShowRoute] = useState(false);
  const [destination, setDestination] = useState(null);   // { lat, lng, name }
  const [routePath, setRoutePath] = useState(null);       // full original route
  const [remainingRoute, setRemainingRoute] = useState(null); // shrinks as user moves
  const [rerouting, setRerouting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const logScrollRef = useRef(null);

  const prevRef = useRef(null);
  const subRef = useRef(null);
  const distRef = useRef(0);
  const kalmanRef = useRef(new KalmanFilter2D());
  const windowRef = useRef(new SlidingWindow());
  const mapRef = useRef(null);
  const latestPingRef = useRef(null);
  const lastStationaryPingRef = useRef(0);
  const currentGpsIntervalRef = useRef(GPS.GPS_INTERVAL_MOVING);
  const restartingGpsRef = useRef(false);
  const pingLoopActiveRef = useRef(false);
  const pingCountRef = useRef(0);
  const sequenceRef = useRef(0);
  const stationaryCountRef = useRef(0);
  const justRestartedGpsRef = useRef(false);
  const isStoppingRef = useRef(false);

  // Navigation refs (only used when a destination is set)
  const lastSegmentIndexRef = useRef(0);
  const offRouteCountRef = useRef(0);
  const arrivalCountRef = useRef(0);
  const reroutingRef = useRef(false);

  const backgroundSinceRef = useRef(null);

  const addLog = useCallback((level, message) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = { time, level, message, id: Date.now() + Math.random() };
    console.log(`[${level}] ${message}`);
    setDebugLogs((prev) => {
      const updated = [...prev, entry];
      return updated.length > MAX_LOGS ? updated.slice(-MAX_LOGS) : updated;
    });
    setTimeout(() => logScrollRef.current?.scrollToEnd({ animated: false }), 50);
  }, []);

  const loadPersistedDistance = useCallback(async () => {
    try {
      const raw = await SecureStore.getItemAsync(TRACKING_TOTAL_DISTANCE_KEY);
      const parsed = raw ? Number(raw) : 0;
      const safeDistance = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      distRef.current = safeDistance;
      setTotalDist(safeDistance);
      return safeDistance;
    } catch {
      distRef.current = 0;
      setTotalDist(0);
      return 0;
    }
  }, []);

  const persistDistance = useCallback(async (value) => {
    try {
      await SecureStore.setItemAsync(TRACKING_TOTAL_DISTANCE_KEY, String(value));
    } catch {}
  }, []);

  const reconcileDistanceFromBackend = useCallback(async () => {
    const backendDistance = await fetchSessionDistance(userId);
    if (!Number.isFinite(backendDistance) || backendDistance < 0) return null;

    distRef.current = backendDistance;
    setTotalDist(backendDistance);
    await persistDistance(backendDistance);
    return backendDistance;
  }, [persistDistance, userId]);

  // Persist destination + route so navigation state survives a process kill.
  // Reading them back happens in the bootstrap effect below.
  const persistNavState = useCallback(async (dest, routeArr) => {
    try {
      if (dest) {
        await SecureStore.setItemAsync(NAV_DESTINATION_KEY, JSON.stringify(dest));
      } else {
        await SecureStore.deleteItemAsync(NAV_DESTINATION_KEY);
      }
      if (routeArr && routeArr.length) {
        await SecureStore.setItemAsync(NAV_ROUTE_KEY, JSON.stringify(routeArr));
      } else {
        await SecureStore.deleteItemAsync(NAV_ROUTE_KEY);
      }
    } catch {}
  }, []);

  const clearPersistedNavState = useCallback(async () => {
    try {
      await SecureStore.deleteItemAsync(NAV_DESTINATION_KEY);
      await SecureStore.deleteItemAsync(NAV_ROUTE_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    const syncAppState = async (state) => {
      try {
        await SecureStore.setItemAsync(
          APP_STATE_KEY,
          state === 'active'
            ? TRACKING.APP_STATE_FOREGROUND
            : TRACKING.APP_STATE_BACKGROUND
        );
      } catch {}

      if (state === 'active') {
        const bgSince = backgroundSinceRef.current;
        const gapMs = bgSince ? Date.now() - bgSince : 0;
        backgroundSinceRef.current = null;

        const trackingActive = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
        if (trackingActive === 'true') {
          await loadPersistedDistance();
          await reconcileDistanceFromBackend();
        }

        if (gapMs > GPS.MAX_GAP_MS) {
          addLog('info', `AppState -> active (gap=${(gapMs / 1000).toFixed(0)}s) -> resetting GPS state`);
          prevRef.current = null;
          kalmanRef.current.reset();
          windowRef.current.reset();
          stationaryCountRef.current = 0;
          justRestartedGpsRef.current = false;
        } else {
          addLog('info', `AppState -> active (gap=${(gapMs / 1000).toFixed(0)}s)`);
        }
      } else {
        backgroundSinceRef.current = Date.now();
        addLog('info', `AppState -> ${state}`);
      }
    };

    syncAppState(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncAppState);
    return () => subscription.remove();
  }, [addLog, loadPersistedDistance, reconcileDistanceFromBackend]);

  const updateMap = useCallback((lat, lng, accuracy, nextTrail) => {
    mapRef.current?.postMessage(JSON.stringify({
      t: 'state',
      a: lat,
      o: lng,
      accuracy,
      trail: nextTrail,
    }));
  }, []);

  const pushTrailPoint = useCallback((point) => {
    setTrail((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.lat === point.lat && last.lng === point.lng) {
        return prev;
      }

      const next = [...prev, point].slice(-TRACKING.TRAIL_LIMIT);
      updateMap(point.lat, point.lng, point.accuracy, next);
      return next;
    });
  }, [updateMap]);

  const requestBatteryExemption = async () => {
    if (Platform.OS !== 'android') return;
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        { data: 'package:com.sachin2810.location_service' }
      );
    } catch {}
  };

  const runPingLoop = useCallback(async (userIdArg) => {
    pingLoopActiveRef.current = true;
    pingCountRef.current = 0;
    addLog('info', `Ping loop started for: ${userIdArg}`);

    while (pingLoopActiveRef.current) {
      const payload = latestPingRef.current;

      if (payload) {
        let shouldSend = true;

        if (!payload.moving) {
          const now = Date.now();
          if (now - lastStationaryPingRef.current < TRACKING.STATIONARY_PING_COOLDOWN_MS) {
            shouldSend = false;
          } else {
            lastStationaryPingRef.current = now;
          }
        }

        if (shouldSend) {
          latestPingRef.current = null;
          pingCountRef.current += 1;
          const pingNum = pingCountRef.current;
          const appState = AppState.currentState;

          const result = await sendPing(userIdArg, payload);

          if (result.status === 'synced') {
            setServerStatus('Synced');
            setLastSyncAt(Date.now());
          } else if (result.status === 'filtered') {
            setServerStatus('Filtered');
            setLastSyncAt(Date.now());
            addLog('info', `#${pingNum} filtered by backend`);
          } else if (result.status === 'rate_limited') {
            addLog('warn', `#${pingNum} rate limited`);
          } else if (result.status === 'server_error') {
            setServerStatus('Server Error');
            addLog('error', `#${pingNum} SERVER ERROR | appState=${appState} | moving=${payload.moving}`);
          } else if (result.status === 'offline') {
            setServerStatus('Offline');
            addLog(
              'error',
              `#${pingNum} OFFLINE | appState=${appState} | moving=${payload.moving} | acc=${payload.accuracy?.toFixed(0)}m | ts=${new Date(payload.timestamp).toLocaleTimeString()}`
            );
          } else {
            setServerStatus('Error');
            addLog('error', `#${pingNum} UNKNOWN status=${result.status} | appState=${appState}`);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, TRACKING.PING_INTERVAL_MS));
    }

    addLog('info', `Ping loop stopped. Total: ${pingCountRef.current}`);
  }, [addLog]);

  const startTracking = useCallback(async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);
    const wasTrackingBefore = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
    const existingSessionId = await SecureStore.getItemAsync(TRACKING.SESSION_KEY);
    const isResume = wasTrackingBefore === 'true' && Boolean(existingSessionId);
    const activeSessionId = existingSessionId || createTrackingSession(userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      addLog('error', 'Foreground location permission denied');
      return;
    }

    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') {
      addLog('warn', 'Background permission denied. Enable "Allow all the time" in app settings.');
    }

    await requestBatteryExemption();

    setIsTracking(true);
    await SecureStore.setItemAsync(TRACKING_ACTIVE_KEY, 'true');
    await SecureStore.setItemAsync(TRACKING.SESSION_KEY, activeSessionId);
    if (isResume) {
      await loadPersistedDistance();
      await reconcileDistanceFromBackend();
    } else {
      distRef.current = 0;
      setTotalDist(0);
      await persistDistance(0);
    }
    setServerStatus('--');
    setSessionId(activeSessionId);
    setLastSyncAt(null);
    setTrail([]);
    lastStationaryPingRef.current = 0;
    setDebugLogs([]);

    kalmanRef.current.reset();
    windowRef.current.reset();
    prevRef.current = null;
    restartingGpsRef.current = false;
    stationaryCountRef.current = 0;
    justRestartedGpsRef.current = false;
    sequenceRef.current = 0;
    backgroundSinceRef.current = null;

    addLog('info', `Tracking started | session=${activeSessionId}`);

    const onGpsUpdate = (loc) => {
      if (justRestartedGpsRef.current) {
        justRestartedGpsRef.current = false;
        prevRef.current = null;
        kalmanRef.current.reset();
        windowRef.current.reset();
      }

      const processed = processLocation(
        loc,
        prevRef.current,
        kalmanRef.current,
        false,
        windowRef.current
      );

      if (!processed) {
        addLog('warn', `GPS filtered locally | acc=${loc.coords.accuracy?.toFixed(1)}m`);
        return;
      }

      prevRef.current = {
        latitude: processed.latitude,
        longitude: processed.longitude,
        timestamp: processed.timestamp,
      };

      if (AppState.currentState === 'active') {
        setLocation({ latitude: processed.latitude, longitude: processed.longitude });
        setSpeed(processed.speed);
        setGpsAcc(processed.accuracy);
        if (processed.moving && processed.distance > 0) {
          const nextDistance = distRef.current + processed.distance;
          distRef.current = nextDistance;
          setTotalDist(nextDistance);
          void persistDistance(nextDistance);
        }
        pushTrailPoint({
          lat: processed.latitude,
          lng: processed.longitude,
          accuracy: processed.accuracy,
        });
      }

      sequenceRef.current += 1;
      latestPingRef.current = buildTrackingPayload({
        userId,
        result: processed,
        sessionId: activeSessionId,
        sequence: sequenceRef.current,
        source: 'foreground_watch',
        appState:
          AppState.currentState === 'active'
            ? TRACKING.APP_STATE_FOREGROUND
            : TRACKING.APP_STATE_BACKGROUND,
        gpsIntervalMs: currentGpsIntervalRef.current,
      });

      if (processed.moving) {
        stationaryCountRef.current = 0;
      } else {
        stationaryCountRef.current += 1;
      }

      const desiredInterval =
        stationaryCountRef.current >= STATIONARY_SWITCH_THRESHOLD
          ? GPS.GPS_INTERVAL_STATIONARY
          : GPS.GPS_INTERVAL_MOVING;

      if (
        desiredInterval !== currentGpsIntervalRef.current &&
        !restartingGpsRef.current
      ) {
        restartingGpsRef.current = true;
        currentGpsIntervalRef.current = desiredInterval;
        const oldSub = subRef.current;
        addLog('info', `GPS interval -> ${desiredInterval}ms (streak=${stationaryCountRef.current})`);

        Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: desiredInterval,
            distanceInterval: 0,
          },
          onGpsUpdate
        )
          .then((newSub) => {
            subRef.current = newSub;
            if (oldSub) oldSub.remove();
            restartingGpsRef.current = false;
            justRestartedGpsRef.current = true;
          })
          .catch((err) => {
            addLog('error', `GPS restart failed: ${err.message}`);
            restartingGpsRef.current = false;
          });
      }
    };

    currentGpsIntervalRef.current = GPS.GPS_INTERVAL_MOVING;
    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: GPS.GPS_INTERVAL_MOVING,
        distanceInterval: 0,
      },
      onGpsUpdate
    );
    subRef.current = sub;
    addLog('info', 'GPS watcher started');

    latestPingRef.current = null;
    runPingLoop(userId);

    if (bg.status === 'granted') {
      try {
        await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: GPS.GPS_INTERVAL_BACKGROUND,
          distanceInterval: 0,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Live Tracking Active',
            notificationBody: `Tracking ${userId}`,
            notificationColor: '#2563EB',
          },
        });
        addLog('info', 'Background task started');
      } catch (err) {
        addLog('error', `Background task failed: ${err.message}`);
      }
    }
  }, [addLog, loadPersistedDistance, persistDistance, pushTrailPoint, reconcileDistanceFromBackend, runPingLoop, userId]);

  const stopNativeTracking = useCallback(async () => {
    pingLoopActiveRef.current = false;
    latestPingRef.current = null;
    lastStationaryPingRef.current = 0;
    stationaryCountRef.current = 0;
    justRestartedGpsRef.current = false;
    restartingGpsRef.current = false;
    sequenceRef.current = 0;
    backgroundSinceRef.current = null;

    if (subRef.current) {
      subRef.current.remove();
      subRef.current = null;
    }

    try {
      const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
      if (running) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
      }
    } catch {}

    await Promise.allSettled([
      SecureStore.deleteItemAsync(TRACKING_ACTIVE_KEY),
      SecureStore.deleteItemAsync(TRACKING.SESSION_KEY),
      SecureStore.deleteItemAsync(STORAGE_KEY),
      SecureStore.deleteItemAsync(APP_STATE_KEY),
      SecureStore.deleteItemAsync(TRACKING_TOTAL_DISTANCE_KEY),
    ]);

    resetBackgroundState();
  }, []);

  const stopTracking = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    setIsTracking(false);
    setServerStatus('Stopping...');
    setSessionId(null);
    addLog('info', `Stopping tracking. Pings sent: ${pingCountRef.current}`);

    try {
      await stopNativeTracking();
      setServerStatus('Stopped');
      await sendStop(userId);
      addLog('info', 'Tracking fully stopped');
    } finally {
      isStoppingRef.current = false;
    }
  }, [addLog, stopNativeTracking, userId]);

  // ────────────────────────────────────────────────────────────────────────
  // Manual refresh: pulls a fresh GPS fix, refreshes the persisted distance,
  // and (if tracking) immediately pushes the current position to the backend
  // — bypassing the ping loop's normal cadence. Does NOT touch the GPS
  // watcher, Kalman filter, or background task.
  // ────────────────────────────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    addLog('info', 'Manual refresh requested');

    try {
      // 1. Re-read persisted total distance from secure storage.
      await loadPersistedDistance();

      // 2. Force a fresh, high-accuracy GPS fix for the display.
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const c = loc?.coords;
      if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) {
        addLog('warn', 'Refresh: no valid GPS coords returned');
        return;
      }

      const speedVal = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : 0;
      setLocation({ latitude: c.latitude, longitude: c.longitude });
      setGpsAcc(c.accuracy);
      setSpeed(speedVal);

      addLog(
        'info',
        `Refresh GPS: ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)} | acc=${c.accuracy?.toFixed(0)}m`
      );

      // 3. If currently tracking, send this fix to the backend right now.
      if (isTracking) {
        sequenceRef.current += 1;
        const payload = buildTrackingPayload({
          userId,
          result: {
            latitude: c.latitude,
            longitude: c.longitude,
            accuracy: c.accuracy,
            speed: speedVal,
            heading: c.heading,
            moving: speedVal > 0.5,
            distance: 0, // refresh doesn't add to total distance
            timestamp: loc.timestamp || Date.now(),
          },
          sessionId,
          sequence: sequenceRef.current,
          source: 'manual_refresh',
          appState:
            AppState.currentState === 'active'
              ? TRACKING.APP_STATE_FOREGROUND
              : TRACKING.APP_STATE_BACKGROUND,
          gpsIntervalMs: currentGpsIntervalRef.current,
        });

        const result = await sendPing(userId, payload);
        if (result.status === 'synced') {
          setServerStatus('Synced');
          setLastSyncAt(Date.now());
          addLog('info', 'Refresh ping synced');
        } else if (result.status === 'filtered') {
          setServerStatus('Filtered');
          setLastSyncAt(Date.now());
          addLog('info', 'Refresh ping filtered by backend');
        } else {
          addLog('warn', `Refresh ping status: ${result.status}`);
        }
      }
    } catch (e) {
      addLog('error', `Refresh failed: ${e.message}`);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [addLog, isTracking, loadPersistedDistance, sessionId, userId]);

  // ────────────────────────────────────────────────────────────────────────
  // Navigation effect: snap-to-route, shrinking polyline, off-route reroute,
  // and auto-stop on arrival. Inert when no destination is set, so the rest
  // of the tracking flow is unaffected.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isTracking || !destination || !routePath || !location) return;

    const cur = { lat: location.latitude, lng: location.longitude };

    // 1. Arrival check (with 2-reading hysteresis to swallow GPS spikes)
    const distToDest = haversineMeters(cur, destination);
    if (distToDest < 100) {
      arrivalCountRef.current += 1;
      if (arrivalCountRef.current >= 2) {
        addLog('info', `Arrived at destination (${distToDest.toFixed(0)}m). Auto-stopping.`);
        arrivalCountRef.current = 0;
        offRouteCountRef.current = 0;
        lastSegmentIndexRef.current = 0;
        setDestination(null);
        setRoutePath(null);
        setRemainingRoute(null);
        void clearPersistedNavState();
        void stopTracking();
      }
      return;
    }
    arrivalCountRef.current = 0;

    // 2. Snap current location onto the route. Allow a tiny look-back so GPS
    //    jitter near a segment boundary doesn't get pinned to the wrong side,
    //    but never search the whole route from the start (prevents the line
    //    from "growing back" if the user briefly zig-zags).
    const fromIdx = Math.max(0, lastSegmentIndexRef.current - 2);
    const snap = snapToRoute(cur, routePath, fromIdx);
    if (!snap) return;

    // 3. Off-route detection — 3 consecutive readings >50m from the polyline
    //    triggers a re-route from the current location.
    if (snap.distance > 50) {
      offRouteCountRef.current += 1;
      if (offRouteCountRef.current >= 3 && !reroutingRef.current) {
        reroutingRef.current = true;
        setRerouting(true);
        addLog('warn', `Off-route by ${snap.distance.toFixed(0)}m — re-routing…`);
        fetchOsrmRoute(cur, destination)
          .then(({ route: newRoute }) => {
            lastSegmentIndexRef.current = 0;
            offRouteCountRef.current = 0;
            setRoutePath(newRoute);
            setRemainingRoute(newRoute);
            void persistNavState(destination, newRoute);
            addLog('info', `Re-routed (${newRoute.length} pts)`);
          })
          .catch((err) => {
            addLog('error', `Re-route failed: ${err.message}`);
          })
          .finally(() => {
            reroutingRef.current = false;
            setRerouting(false);
          });
      }
      return;
    }

    // 4. On-route — advance the segment index and shrink the displayed line.
    offRouteCountRef.current = 0;
    lastSegmentIndexRef.current = snap.segmentIndex;
    setRemainingRoute(sliceRouteFrom(routePath, snap.segmentIndex, snap.point));
  }, [location, destination, routePath, isTracking, addLog, stopTracking]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      let loc;
      try {
        loc = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
      } catch {
        if (cancelled) return;
        loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      }

      if (cancelled) return;
      const c = loc.coords;
      if (c.latitude && c.longitude) {
        const initialTrail = [{ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy }];
        setLocation({ latitude: c.latitude, longitude: c.longitude });
        setGpsAcc(c.accuracy);
        setTrail(initialTrail);
        prevRef.current = {
          latitude: c.latitude,
          longitude: c.longitude,
          timestamp: loc.timestamp,
        };
      }

      // Re-hydrate any previously persisted destination + route, so navigation
      // state survives a process kill. The navigation effect will then catch
      // up against the user's current location on the next GPS tick.
      try {
        const [destRaw, routeRaw] = await Promise.all([
          SecureStore.getItemAsync(NAV_DESTINATION_KEY),
          SecureStore.getItemAsync(NAV_ROUTE_KEY),
        ]);
        if (!cancelled && destRaw) {
          const savedDest = JSON.parse(destRaw);
          const savedRoute = routeRaw ? JSON.parse(routeRaw) : null;
          setDestination(savedDest);
          if (savedRoute && Array.isArray(savedRoute) && savedRoute.length > 1) {
            setRoutePath(savedRoute);
            setRemainingRoute(savedRoute);
          }
          lastSegmentIndexRef.current = 0;
          offRouteCountRef.current = 0;
          arrivalCountRef.current = 0;
          addLog('info', `Restored destination: ${savedDest.name || 'unnamed'}`);
        }
      } catch (e) {
        addLog('warn', `Failed to restore nav state: ${e.message}`);
      }

      const wasTracking = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
      if (wasTracking === 'true' && !cancelled) {
        const savedSessionId = await SecureStore.getItemAsync(TRACKING.SESSION_KEY);
        if (savedSessionId) setSessionId(savedSessionId);
        addLog('info', 'Auto-resuming previous session');
        startTracking();
      }
    })();

    return () => {
      cancelled = true;
      pingLoopActiveRef.current = false;
      if (subRef.current) subRef.current.remove();
      if (isTracking) {
        void stopNativeTracking();
      }
    };
  }, [addLog, isTracking, startTracking, stopNativeTracking]);

  if (!location) {
    return (
      <SafeAreaView style={s.loadingWrap}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={s.loadingText}>Acquiring GPS Signal...</Text>
        <Text style={s.loadingSub}>Waiting for high-accuracy fix</Text>
      </SafeAreaView>
    );
  }

  const speedKmh = speed > 0 ? (speed * 3.6).toFixed(1) : '0.0';
  const distDisplay =
    totalDist >= 1000
      ? (totalDist / 1000).toFixed(2) + ' km'
      : Math.round(totalDist) + ' m';
  const accDisplay = gpsAcc ? gpsAcc.toFixed(0) + 'm' : '--';
  const activity = getActivityLabel(speed);
  const cadenceDisplay =
    currentGpsIntervalRef.current >= GPS.GPS_INTERVAL_STATIONARY ? 'Idle cadence' : 'Live cadence';
  const lastSyncDisplay = lastSyncAt
    ? new Date(lastSyncAt).toLocaleTimeString('en-US', { hour12: false })
    : '--';

  const logColor = (level) => {
    if (level === 'error') return '#ef4444';
    if (level === 'warn') return '#f59e0b';
    return '#94a3b8';
  };

  return (
    <SafeAreaView style={s.container}>
      <ScrollView
        style={s.screenScroll}
        contentContainerStyle={s.screenContent}
        showsVerticalScrollIndicator={false}
      >
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>{user.name || 'Deep Horizon'}</Text>
          <Text style={s.headerUser}>{user.email}</Text>
        </View>
        <View style={s.headerRight}>
          <Pressable
            onPress={handleRefresh}
            disabled={refreshing}
            style={[s.refreshBtn, refreshing && s.refreshBtnDisabled]}
            hitSlop={8}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color="#2563EB" />
            ) : (
              <Text style={s.refreshBtnText}>↻</Text>
            )}
          </Pressable>
          <View style={[s.badge, isTracking ? s.badgeOn : s.badgeOff]}>
            <View style={[s.dot, isTracking ? s.dotOn : s.dotOff]} />
            <Text style={[s.badgeText, isTracking ? s.badgeTextOn : s.badgeTextOff]}>
              {isTracking ? 'LIVE' : 'OFFLINE'}
            </Text>
          </View>
        </View>
      </View>

      <View style={s.speedSection}>
        <Text style={s.speedVal}>{speedKmh}</Text>
        <Text style={s.speedUnit}>km/h</Text>
        <Text style={s.speedLabel}>{activity}</Text>
      </View>

      <View style={s.statsRow}>
        <View style={s.statCard}>
          <Text style={s.statVal}>{accDisplay}</Text>
          <Text style={s.statLbl}>Accuracy</Text>
        </View>
        <View style={s.statCard}>
          <Text style={s.statVal}>{distDisplay}</Text>
          <Text style={s.statLbl}>Distance</Text>
        </View>
      </View>

      <MiniMap
        ref={mapRef}
        latitude={location.latitude}
        longitude={location.longitude}
        destination={destination}
        route={remainingRoute || routePath}
      />

      {destination && (
        <View style={s.destBanner}>
          <View style={{ flex: 1 }}>
            <Text style={s.destBannerLabel}>
              {rerouting ? 'Re-routing…' : isTracking ? 'Following Route' : 'Destination'}
            </Text>
            <Text style={s.destBannerText} numberOfLines={1}>
              {destination.name || `${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}`}
            </Text>
            {remainingRoute && remainingRoute.length > 1 && (
              <Text style={s.destBannerMeta}>
                {formatDistanceMeters(routeLengthMeters(remainingRoute))} remaining
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              setDestination(null);
              setRoutePath(null);
              setRemainingRoute(null);
              lastSegmentIndexRef.current = 0;
              offRouteCountRef.current = 0;
              arrivalCountRef.current = 0;
              void clearPersistedNavState();
            }}
            style={s.destBannerClear}
          >
            <Text style={s.destBannerClearText}>Clear</Text>
          </Pressable>
        </View>
      )}
    {user.email === 'sachin@gmail.com' && (

      <View style={s.infoCard}>
        <Row label="Position" value={`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`} />
        <Row
          label="Server"
          value={serverStatus}
          valueColor={
            serverStatus === 'Synced'
              ? '#16a34a'
              : serverStatus === 'Filtered'
                ? '#d97706'
              : serverStatus === 'Rate Limited' || serverStatus === 'Server Error'
                || serverStatus === 'Error' || serverStatus === 'Offline'
                ? '#dc2626'
                : '#888'
          }
        />
        <Row label="Last Sync" value={lastSyncDisplay} />
        <Row label="Mode" value={cadenceDisplay} />
        <Row label="Trail Points" value={String(trail.length)} />
        <Row label="Session" value={sessionId ? sessionId.slice(0, 18) : '--'} />
      </View>

    )}
      

      {user.email === 'sachin@gmail.com' && (
        <Pressable onPress={() => setShowLogs((v) => !v)} style={s.logToggle}>
          <Text style={s.logToggleText}>
            {showLogs ? 'Hide Logs' : 'Debug Logs'} ({debugLogs.length})
          </Text>
          {debugLogs.some((entry) => entry.level === 'error') && <View style={s.errorDot} />}
        </Pressable>
      )}

      {showLogs && (
        <View style={s.logPanel}>
          <ScrollView
            ref={logScrollRef}
            style={s.logScroll}
            nestedScrollEnabled
            onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: false })}
          >
            {debugLogs.length === 0
              ? <Text style={s.logEmpty}>No logs yet</Text>
              : debugLogs.map((entry) => (
                  <Text key={entry.id} style={[s.logLine, { color: logColor(entry.level) }]}>
                    {entry.time} {entry.message}
                  </Text>
                ))}
          </ScrollView>
          <Pressable onPress={() => setDebugLogs([])} style={s.clearBtn}>
            <Text style={s.clearBtnText}>Clear</Text>
          </Pressable>
        </View>
      )}

      <View style={s.actions}>
        {!isTracking ? (
          <Pressable style={s.btnTrack} onPress={startTracking}>
            <Text style={s.btnTextWhite}>Start Track Me</Text>
          </Pressable>
        ) : (
          <Pressable style={s.btnStop} onPress={stopTracking}>
            <Text style={s.btnTextWhite}>Stop Tracking</Text>
          </Pressable>
        )}
        {!isTracking && (
          <Pressable style={s.btnDestination} onPress={() => setShowRoute(true)}>
            <Text style={s.btnDestinationText}>Add Destination</Text>
          </Pressable>
        )}
        <Pressable style={s.btnLogout} onPress={onLogout}>
          <Text style={s.btnLogoutText}>Logout</Text>
        </Pressable>
      </View>
      </ScrollView>

      <Modal
        visible={showRoute}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowRoute(false)}
      >
        <RouteScreen
          origin={{ lat: location.latitude, lng: location.longitude }}
          initialDestination={destination}
          onClose={() => setShowRoute(false)}
          onConfirm={({ destination: dest, route: rt }) => {
            setDestination(dest);
            setRoutePath(rt);
            setRemainingRoute(rt);
            lastSegmentIndexRef.current = 0;
            offRouteCountRef.current = 0;
            arrivalCountRef.current = 0;
            void persistNavState(dest, rt);
          }}
        />
      </Modal>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  screenScroll: { flex: 1 },
  screenContent: { flexGrow: 1, paddingBottom: 20 },
  loadingWrap: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  loadingText: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginTop: 20 },
  loadingSub: { fontSize: 13, color: '#94A3B8', marginTop: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  headerUser: { fontSize: 12, color: '#64748B', marginTop: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  refreshBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', alignItems: 'center', justifyContent: 'center' },
  refreshBtnDisabled: { opacity: 0.5 },
  refreshBtnText: { fontSize: 18, color: '#2563EB', fontWeight: '700', lineHeight: 20 },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  badgeOn: { backgroundColor: 'rgba(22,163,74,0.1)' },
  badgeOff: { backgroundColor: 'rgba(239,68,68,0.1)' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  dotOn: { backgroundColor: '#16A34A' },
  dotOff: { backgroundColor: '#EF4444' },
  badgeText: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  badgeTextOn: { color: '#16A34A' },
  badgeTextOff: { color: '#EF4444' },
  speedSection: { alignItems: 'center', paddingVertical: 12 },
  speedVal: { fontSize: 48, fontWeight: '800', color: '#0F172A', lineHeight: 54 },
  speedUnit: { fontSize: 14, fontWeight: '600', color: '#64748B', marginTop: 1 },
  speedLabel: { fontSize: 12, color: '#94A3B8', marginTop: 4, fontWeight: '500' },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard: { flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 10, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  statVal: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 2 },
  statLbl: { fontSize: 9, color: '#94A3B8', textTransform: 'uppercase', fontWeight: '600', letterSpacing: 0.5 },
  infoCard: { backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  logToggle: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 4, marginBottom: 4 },
  logToggleText: { fontSize: 11, color: '#64748B', fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  errorDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#ef4444', marginLeft: 6 },
  logPanel: { backgroundColor: '#0F172A', borderRadius: 8, padding: 8, marginBottom: 8, maxHeight: 160 },
  logScroll: { maxHeight: 130 },
  logLine: { fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 16 },
  logEmpty: { fontSize: 10, color: '#475569', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  clearBtn: { alignSelf: 'flex-end', marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: '#1E293B', borderRadius: 4 },
  clearBtnText: { fontSize: 10, color: '#94A3B8', fontWeight: '600' },
  actions: { marginTop: 'auto', paddingBottom: 32 },
  btnTrack: { backgroundColor: '#0F172A', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnStop: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnDestination: { marginTop: 8, backgroundColor: '#2563EB', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnDestinationText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  destBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#BFDBFE', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  destBannerLabel: { fontSize: 9, fontWeight: '700', color: '#2563EB', textTransform: 'uppercase', letterSpacing: 0.5 },
  destBannerText: { fontSize: 12, fontWeight: '700', color: '#0F172A', marginTop: 1 },
  destBannerMeta: { fontSize: 11, fontWeight: '600', color: '#2563EB', marginTop: 2 },
  destBannerClear: { backgroundColor: '#FEE2E2', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  destBannerClearText: { fontSize: 11, fontWeight: '700', color: '#DC2626' },
  btnTextWhite: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  btnLogout: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  btnLogoutText: { color: '#64748B', fontSize: 14, fontWeight: '600' },
});
