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
  GPS_TIERS,
  NAV_DESTINATION_KEY,
  STORAGE_KEY,
  TRACKING,
  TRACKING_ACTIVE_KEY,
} from '../config/constants';
import { TierSignalService, TIERS } from '../services/tierSignal';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';
import { checkForceRequest, clearDestination, getDestinationRemaining, sendPing, sendStop, setDestination as apiSetDestination } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import {
  buildTrackingPayload,
  createTrackingSession,
} from '../utils/trackingPayload';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';
import RouteScreen from './RouteScreen';

const MAX_LOGS = 50;
const STATIONARY_SWITCH_THRESHOLD = 4;

export default function TrackingScreen({ user, onLogout }) {
  const userId = user.name || user.email || String(user.id);

  const [location, setLocation] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [gpsAcc, setGpsAcc] = useState(null);
  const [serverStatus, setServerStatus] = useState('--');
  const [sessionId, setSessionId] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [trail, setTrail] = useState([]);
  const [debugLogs, setDebugLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showRoute, setShowRoute] = useState(false);
  const [destination, setDestination] = useState(null);   // { lat, lng, name }
  const [remainingDist, setRemainingDist] = useState(null); // metres, from backend
  const [deviationAlert, setDeviationAlert] = useState(null); // { distanceFromRoute, consecutive, detectedAt }
  const [currentTier, setCurrentTier] = useState(1);
  const tierServiceRef = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const logScrollRef = useRef(null);

  const prevRef = useRef(null);
  const subRef = useRef(null);
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


  // Force-location request refs
  const forceRefreshingRef = useRef(false);

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


  // Persist only the destination metadata locally (route + corridor live on the backend).
  const persistDest = useCallback(async (dest) => {
    try {
      if (dest) {
        await SecureStore.setItemAsync(NAV_DESTINATION_KEY, JSON.stringify(dest));
      } else {
        await SecureStore.deleteItemAsync(NAV_DESTINATION_KEY);
      }
    } catch {}
  }, []);

  const clearDest = useCallback(async () => {
    setDestination(null);
    setRemainingDist(null);
    await persistDest(null);
    void clearDestination(userId);
  }, [persistDest, userId]);

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
  }, [addLog]);

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

  // Force-refresh: grabs a fresh GPS fix and sends it with source "force_request"
  // so the backend clears the pending locreq flag.
  const doForceRefresh = useCallback(async (userIdArg) => {
    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const c = loc?.coords;
      if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;

      const speedVal = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : 0;
      setLocation({ latitude: c.latitude, longitude: c.longitude });
      setGpsAcc(c.accuracy);

      sequenceRef.current += 1;
      const payload = buildTrackingPayload({
        userId: userIdArg,
        result: {
          latitude: c.latitude,
          longitude: c.longitude,
          accuracy: c.accuracy,
          speed: speedVal,
          heading: c.heading,
          moving: speedVal > 0.5,
          distance: 0,
          timestamp: loc.timestamp || Date.now(),
        },
        sessionId,
        sequence: sequenceRef.current,
        source: 'force_request',
        appState:
          AppState.currentState === 'active'
            ? TRACKING.APP_STATE_FOREGROUND
            : TRACKING.APP_STATE_BACKGROUND,
        gpsIntervalMs: currentGpsIntervalRef.current,
      });

      const result = await sendPing(userIdArg, payload);
      if (result.status === 'synced') {
        setServerStatus('Synced');
        setLastSyncAt(Date.now());
      }
      addLog('info', `Force refresh sent | acc=${c.accuracy?.toFixed(0)}m`);
    } catch (e) {
      addLog('error', `Force refresh failed: ${e.message}`);
    }
  }, [addLog, sessionId]);

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

          // Server-side arrival detection
          if (result.arrivalDetected) {
            addLog('info', 'Arrived at destination (server-confirmed)');
            setDestination(null);
            setRemainingDist(null);
            setDeviationAlert(null);
            await persistDest(null);
          }

          // Deviation alert from backend
          if (result.deviationAlert) {
            setDeviationAlert(result.deviationAlert);
            addLog('warn', `DEVIATION: ${result.deviationAlert.distanceFromRoute || '?'}m from route | streak=${result.deviationAlert.consecutive}`);
          } else if (result.status === 'synced') {
            setDeviationAlert(null);
          }

          // Inactivity flag
          if (result.inactivityFlag) {
            addLog('warn', 'INACTIVITY: stationary >15min — check on user');
          }

          // ── Tier signal: push backend signals into the tier service ──
          const ts = tierServiceRef.current;
          if (ts) {
            if (result.deviationAlert) {
              // consecutive >= 6 = long deviation, otherwise short
              const isLong = result.deviationAlert.consecutive >= 6;
              ts.pushSignal({ type: isLong ? 'long_deviation' : 'short_deviation' });
            } else if (result.status === 'synced' && !result.deviationAlert) {
              ts.clearSignal('short_deviation');
              ts.clearSignal('long_deviation');
            }
          }

          // If the backend signals a pending force-location request from an
          // agent, trigger an immediate fresh GPS fix + ping.
          if (result.forceRefresh && !forceRefreshingRef.current) {
            forceRefreshingRef.current = true;
            addLog('info', 'Agent requested force location — refreshing');
            doForceRefresh(userIdArg).finally(() => {
              forceRefreshingRef.current = false;
            });
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, TRACKING.PING_INTERVAL_MS));
    }

    addLog('info', `Ping loop stopped. Total: ${pingCountRef.current}`);
  }, [addLog]);

  const startTracking = useCallback(async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);
    const existingSessionId = await SecureStore.getItemAsync(TRACKING.SESSION_KEY);
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

    // ── Initialize Tier Signal Service ──────────────────────────────
    if (tierServiceRef.current) tierServiceRef.current.destroy();
    const tierService = new TierSignalService();
    tierServiceRef.current = tierService;
    setCurrentTier(TIERS.TIER_1);

    // When tier changes, restart GPS watcher with new accuracy + interval
    tierService.onTierChange((newTier, reason, prevTier) => {
      setCurrentTier(newTier);
      addLog('info', `TIER ${prevTier} → ${newTier} (${reason}) | ${GPS_TIERS[newTier].label}`);

      if (restartingGpsRef.current) return;
      restartingGpsRef.current = true;

      const tierConfig = GPS_TIERS[newTier];
      const accuracyMap = {
        Balanced: Location.Accuracy.Balanced,
        High: Location.Accuracy.High,
        BestForNavigation: Location.Accuracy.BestForNavigation,
      };
      const newAccuracy = accuracyMap[tierConfig.accuracy] || Location.Accuracy.Balanced;
      const newInterval = tierConfig.foregroundInterval;
      currentGpsIntervalRef.current = newInterval;

      const oldSub = subRef.current;
      Location.watchPositionAsync(
        {
          accuracy: newAccuracy,
          timeInterval: newInterval,
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
          addLog('error', `Tier GPS switch failed: ${err.message}`);
          restartingGpsRef.current = false;
        });
    });

    addLog('info', `Tracking started | session=${activeSessionId} | Tier 1 (Passive)`);

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
        setGpsAcc(processed.accuracy);
        pushTrailPoint({
          lat: processed.latitude,
          lng: processed.longitude,
          accuracy: processed.accuracy,
        });
      }

      // Feed position to tier service for inactivity detection
      // (<30m distance covered in 10min + not near destination)
      if (tierServiceRef.current) {
        const nearDest = false; // remaining-distance poll will update this
        tierServiceRef.current.reportPosition(
          processed.latitude,
          processed.longitude,
          nearDest
        );
      }

      sequenceRef.current += 1;
      const pingPayload = buildTrackingPayload({
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
      // Attach current GPS tier to the payload
      pingPayload.tier = tierServiceRef.current?.currentTier || 1;
      pingPayload.tierReason = tierServiceRef.current?.currentReason || 'default';
      latestPingRef.current = pingPayload;

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

    // Start at Tier 1: passive, cell tower / WiFi, minimal battery
    const startTier = GPS_TIERS[TIERS.TIER_1];
    currentGpsIntervalRef.current = startTier.foregroundInterval;
    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced, // Tier 1: cell+WiFi
        timeInterval: startTier.foregroundInterval,
        distanceInterval: 0,
      },
      onGpsUpdate
    );
    subRef.current = sub;
    addLog('info', `GPS watcher started | Tier 1 (${startTier.label}) @ ${startTier.foregroundInterval}ms`);

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
  }, [addLog, pushTrailPoint, runPingLoop, userId]);

  const stopNativeTracking = useCallback(async () => {
    pingLoopActiveRef.current = false;
    latestPingRef.current = null;
    lastStationaryPingRef.current = 0;
    stationaryCountRef.current = 0;
    justRestartedGpsRef.current = false;
    restartingGpsRef.current = false;
    sequenceRef.current = 0;
    backgroundSinceRef.current = null;

    // Destroy tier service
    if (tierServiceRef.current) {
      tierServiceRef.current.destroy();
      tierServiceRef.current = null;
    }
    setCurrentTier(1);

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
      // 1. Force a fresh, high-accuracy GPS fix for the display.
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
  }, [addLog, isTracking, sessionId, userId]);

  // ────────────────────────────────────────────────────────────────────────
  // Remaining-distance poll: every 10s ask the backend for the remaining
  // distance along the stored route. All routing, H3, and arrival logic
  // now lives server-side — the phone just shows the number.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isTracking || !destination) return;
    let active = true;

    const poll = async () => {
      try {
        const res = await getDestinationRemaining(userId);
        if (!active) return;
        if (res.ok && res.active) {
          setRemainingDist(res.remaining);
        } else if (res.ok && !res.active) {
          // Backend cleared the destination (arrival or manual)
          setDestination(null);
          setRemainingDist(null);
          await persistDest(null);
        }
      } catch {}
    };

    poll(); // immediate first check
    const interval = setInterval(poll, 10000);
    return () => { active = false; clearInterval(interval); };
  }, [isTracking, destination, userId, persistDest]);

  // ────────────────────────────────────────────────────────────────────────
  // Fallback poll: every 30s, check for a pending force-location request
  // from an agent. Covers the case when pings aren't flowing (GPS stuck,
  // stationary cooldown active, etc.) so the phone still responds.
  // ────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isTracking) return;
    const interval = setInterval(async () => {
      if (forceRefreshingRef.current) return;
      try {
        const { pending } = await checkForceRequest(userId);
        if (pending && !forceRefreshingRef.current) {
          forceRefreshingRef.current = true;
          addLog('info', 'Agent force-request detected via poll — refreshing');
          doForceRefresh(userId).finally(() => {
            forceRefreshingRef.current = false;
          });
        }
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [isTracking, userId, addLog, doForceRefresh]);

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

      // Re-hydrate destination metadata. Route + corridor live on the backend;
      // the remaining-distance poll will pick up automatically once tracking starts.
      try {
        const destRaw = await SecureStore.getItemAsync(NAV_DESTINATION_KEY);
        if (!cancelled && destRaw) {
          const savedDest = JSON.parse(destRaw);
          setDestination(savedDest);
          addLog('info', `Restored destination: ${savedDest.name || 'unnamed'}`);
        }
      } catch (e) {
        addLog('warn', `Failed to restore destination: ${e.message}`);
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

  const accDisplay = gpsAcc ? gpsAcc.toFixed(0) + 'm' : '--';
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

      <View style={s.statsRow}>
        <View style={s.statCard}>
          <Text style={s.statVal}>{accDisplay}</Text>
          <Text style={s.statLbl}>Accuracy</Text>
        </View>
        <View style={[s.statCard, currentTier === 3 && s.statCardAlert]}>
          <Text style={[s.statVal, currentTier === 3 && { color: '#DC2626' }]}>
            {GPS_TIERS[currentTier]?.label || 'Tier ' + currentTier}
          </Text>
          <Text style={s.statLbl}>GPS Mode</Text>
        </View>
      </View>

      <MiniMap
        ref={mapRef}
        latitude={location.latitude}
        longitude={location.longitude}
      />

      {deviationAlert && (
        <View style={s.deviationBanner}>
          <Text style={s.deviationIcon}>⚠️</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.deviationTitle}>ROUTE DEVIATION</Text>
            <Text style={s.deviationText}>
              {deviationAlert.distanceFromRoute
                ? `${deviationAlert.distanceFromRoute}m from route`
                : 'Outside corridor'}
              {`  •  Streak: ${deviationAlert.consecutive}`}
            </Text>
          </View>
        </View>
      )}

      {destination && (
        <View style={s.destBanner}>
          <View style={{ flex: 1 }}>
            <Text style={s.destBannerLabel}>
              {isTracking ? 'Following Route' : 'Destination'}
            </Text>
            <Text style={s.destBannerText} numberOfLines={1}>
              {destination.name || `${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)}`}
            </Text>
            {remainingDist != null && (
              <Text style={s.destBannerMeta}>
                {remainingDist >= 1000
                  ? `${(remainingDist / 1000).toFixed(1)} km remaining`
                  : `${Math.round(remainingDist)} m remaining`}
              </Text>
            )}
          </View>
          <Pressable onPress={clearDest} style={s.destBannerClear}>
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
          onConfirm={async ({ destination: dest }) => {
            const origin = { lat: location.latitude, lng: location.longitude };
            // Tell the backend to compute OSRM route + H3 corridor
            const res = await apiSetDestination(userId, origin, dest, dest.name);
            setDestination(dest);
            if (res.ok) {
              setRemainingDist(res.distance);
            }
            void persistDest(dest);
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
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard: { flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 10, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  statCardAlert: { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' },
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
  deviationBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  deviationIcon: { fontSize: 18, marginRight: 10 },
  deviationTitle: { fontSize: 10, fontWeight: '800', color: '#DC2626', textTransform: 'uppercase', letterSpacing: 0.5 },
  deviationText: { fontSize: 11, fontWeight: '600', color: '#991B1B', marginTop: 2 },
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
