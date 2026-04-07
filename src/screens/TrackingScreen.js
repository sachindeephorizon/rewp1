import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
  STORAGE_KEY,
  TRACKING,
  TRACKING_ACTIVE_KEY,
} from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';
import { sendPing, sendStop } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import {
  buildTrackingPayload,
  createTrackingSession,
  getActivityLabel,
} from '../utils/trackingPayload';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';

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
    const existingSessionId = await SecureStore.getItemAsync(TRACKING.SESSION_KEY);
    const activeSessionId = existingSessionId || createTrackingSession(userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') addLog('warn', 'Background permission denied');

    await requestBatteryExemption();

    setIsTracking(true);
    await SecureStore.setItemAsync(TRACKING_ACTIVE_KEY, 'true');
    await SecureStore.setItemAsync(TRACKING.SESSION_KEY, activeSessionId);
    distRef.current = 0;
    setTotalDist(0);
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
          distRef.current += processed.distance;
          setTotalDist(distRef.current);
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
    ]);

    resetBackgroundState();
  }, []);

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

    await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: GPS.GPS_INTERVAL_BACKGROUND,
      distanceInterval: 10,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Live Tracking Active',
        notificationBody: `Tracking ${userId}`,
        notificationColor: '#2563EB',
      },
    });
    addLog('info', 'Background task started');
  }, [addLog, pushTrailPoint, runPingLoop, userId]);

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
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>{user.name || 'Deep Horizon'}</Text>
          <Text style={s.headerUser}>{user.email}</Text>
        </View>
        <View style={[s.badge, isTracking ? s.badgeOn : s.badgeOff]}>
          <View style={[s.dot, isTracking ? s.dotOn : s.dotOff]} />
          <Text style={[s.badgeText, isTracking ? s.badgeTextOn : s.badgeTextOff]}>
            {isTracking ? 'LIVE' : 'OFFLINE'}
          </Text>
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

      <MiniMap ref={mapRef} latitude={location.latitude} longitude={location.longitude} />

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

      <Pressable onPress={() => setShowLogs((v) => !v)} style={s.logToggle}>
        <Text style={s.logToggleText}>
          {showLogs ? 'Hide Logs' : 'Debug Logs'} ({debugLogs.length})
        </Text>
        {debugLogs.some((entry) => entry.level === 'error') && <View style={s.errorDot} />}
      </Pressable>

      {showLogs && (
        <View style={s.logPanel}>
          <ScrollView
            ref={logScrollRef}
            style={s.logScroll}
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
        <Pressable style={s.btnLogout} onPress={onLogout}>
          <Text style={s.btnLogoutText}>Logout</Text>
        </Pressable>
      </View>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  loadingWrap: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  loadingText: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginTop: 20 },
  loadingSub: { fontSize: 13, color: '#94A3B8', marginTop: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, paddingBottom: 6 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  headerUser: { fontSize: 12, color: '#64748B', marginTop: 1 },
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
  btnTextWhite: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  btnLogout: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  btnLogoutText: { color: '#64748B', fontSize: 14, fontWeight: '600' },
});
