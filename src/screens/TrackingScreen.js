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
import { Accelerometer } from 'expo-sensors';

import { BACKGROUND_TASK, GPS, STORAGE_KEY } from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';
import { sendPing, sendStop } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';

const TRACKING_ACTIVE_KEY = 'tracking_active';
const APP_STATE_KEY = 'tracking_app_state';
const STATIONARY_PING_COOLDOWN = 30_000;
const PING_INTERVAL_MS = 3000;
const MAX_LOGS = 50; // keep last 50 log lines in UI

export default function TrackingScreen({ user, onLogout }) {
  const userId = user.name || user.email || String(user.id);

  const [location, setLocation] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [gpsAcc, setGpsAcc] = useState(null);
  const [totalDist, setTotalDist] = useState(0);
  const [serverStatus, setServerStatus] = useState('--');
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
  const accelStationaryRef = useRef(false);
  const accelSubRef = useRef(null);
  const currentGpsIntervalRef = useRef(GPS.GPS_INTERVAL_MOVING);
  const restartingGpsRef = useRef(false);
  const pingLoopActiveRef = useRef(false);
  const pingCountRef = useRef(0);

  // ── IN-APP LOGGER ──
  const addLog = useCallback((level, message) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = { time, level, message, id: Date.now() + Math.random() };
    console.log(`[${level}] ${message}`); // still log to Metro too
    setDebugLogs((prev) => {
      const updated = [...prev, entry];
      return updated.length > MAX_LOGS ? updated.slice(-MAX_LOGS) : updated;
    });
    // Auto-scroll to bottom
    setTimeout(() => logScrollRef.current?.scrollToEnd({ animated: false }), 50);
  }, []);

  // ── APP STATE SYNC ──
  useEffect(() => {
    const syncAppState = async (state) => {
      try {
        await SecureStore.setItemAsync(
          APP_STATE_KEY,
          state === 'active' ? 'foreground' : 'background'
        );
        addLog('info', `AppState → ${state}`);
      } catch {}
    };

    syncAppState(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncAppState);
    return () => subscription.remove();
  }, [addLog]);

  const updateMap = (lat, lng) => {
    mapRef.current?.postMessage(JSON.stringify({ t: 'loc', a: lat, o: lng }));
  };

  // ── DOZE MODE FIX ──
  const requestBatteryExemption = async () => {
    if (Platform.OS !== 'android') return;
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        { data: 'package:com.sachin2810.location_service' }
      );
    } catch {}
  };

  // ── SEQUENTIAL PING LOOP ──
  const runPingLoop = useCallback(async (userIdArg) => {
    pingLoopActiveRef.current = true;
    pingCountRef.current = 0;
    addLog('info', `Ping loop started for: ${userIdArg}`);

    while (pingLoopActiveRef.current) {
      const r = latestPingRef.current;

      if (r) {
        let shouldSend = true;

        if (!r.moving) {
          const now = Date.now();
          if (now - lastStationaryPingRef.current < STATIONARY_PING_COOLDOWN) {
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

          const result = await sendPing(userIdArg, r);

          if (result.status === 'synced') {
            setServerStatus('Synced');
          } else if (result.status === 'filtered') {
            addLog('info', `#${pingNum} filtered by backend`);
          } else if (result.status === 'rate_limited') {
            addLog('warn', `#${pingNum} rate limited`);
          } else if (result.status === 'server_error') {
            setServerStatus('Server Error');
            addLog('error', `#${pingNum} SERVER ERROR | appState=${appState} | moving=${r.moving}`);
          } else if (result.status === 'offline') {
            setServerStatus('Offline');
            addLog('error', `#${pingNum} OFFLINE | appState=${appState} | moving=${r.moving} | acc=${r.accuracy?.toFixed(0)}m | ts=${new Date(r.timestamp).toLocaleTimeString()}`);
          } else {
            setServerStatus('Error');
            addLog('error', `#${pingNum} UNKNOWN status=${result.status} | appState=${appState}`);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, PING_INTERVAL_MS));
    }

    addLog('info', `Ping loop stopped. Total sent: ${pingCountRef.current}`);
  }, [addLog]);

  // ── START TRACKING ──
  const startTracking = useCallback(async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') addLog('warn', 'Background permission denied');

    await requestBatteryExemption();

    setIsTracking(true);
    await SecureStore.setItemAsync(TRACKING_ACTIVE_KEY, 'true');
    distRef.current = 0;
    setTotalDist(0);
    setServerStatus('--');
    lastStationaryPingRef.current = 0;
    setDebugLogs([]); // clear logs on new session

    kalmanRef.current.reset();
    windowRef.current.reset();
    prevRef.current = null;
    restartingGpsRef.current = false;

    addLog('info', 'Tracking started');

    // ── GPS CALLBACK ──
    const onGpsUpdate = (loc) => {
      const r = processLocation(
        loc,
        prevRef.current,
        kalmanRef.current,
        accelStationaryRef.current,
        windowRef.current
      );

      if (!r) {
        addLog('warn', `GPS filtered | acc=${loc.coords.accuracy?.toFixed(1)}m`);
        return;
      }

      prevRef.current = {
        latitude: r.latitude,
        longitude: r.longitude,
        timestamp: r.timestamp,
      };

      if (AppState.currentState === 'active') {
        setLocation({ latitude: r.latitude, longitude: r.longitude });
        updateMap(r.latitude, r.longitude);
        setSpeed(r.speed);
        setGpsAcc(r.accuracy);
        if (r.moving && r.distance > 0) {
          distRef.current += r.distance;
          setTotalDist(distRef.current);
        }
      }

      latestPingRef.current = r;

      // Adaptive GPS restart
      const desiredInterval = r.moving
        ? GPS.GPS_INTERVAL_MOVING
        : GPS.GPS_INTERVAL_STATIONARY;

      if (
        desiredInterval !== currentGpsIntervalRef.current &&
        !restartingGpsRef.current
      ) {
        restartingGpsRef.current = true;
        currentGpsIntervalRef.current = desiredInterval;
        const oldSub = subRef.current;
        addLog('info', `GPS interval → ${desiredInterval}ms (moving=${r.moving})`);

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

    Accelerometer.setUpdateInterval(1000);
    accelSubRef.current = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      accelStationaryRef.current = Math.abs(magnitude - 1) < 0.05;
    });

    latestPingRef.current = null;
    runPingLoop(userId);

    await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 5000,
      distanceInterval: 10,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Live Tracking Active',
        notificationBody: `Tracking ${userId}`,
        notificationColor: '#2563EB',
      },
    });
    addLog('info', 'Background task started');
  }, [userId, runPingLoop, addLog]);

  // ── STOP TRACKING ──
  const stopTracking = async () => {
    setIsTracking(false);
    await SecureStore.deleteItemAsync(TRACKING_ACTIVE_KEY);
    setServerStatus('Stopped');

    pingLoopActiveRef.current = false;
    addLog('info', `Tracking stopped. Pings: ${pingCountRef.current}`);

    if (accelSubRef.current) {
      accelSubRef.current.remove();
      accelSubRef.current = null;
    }
    accelStationaryRef.current = false;
    latestPingRef.current = null;
    lastStationaryPingRef.current = 0;
    restartingGpsRef.current = false;

    if (subRef.current) {
      subRef.current.remove();
      subRef.current = null;
    }

    await sendStop(userId);

    const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
    if (running) await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    await SecureStore.deleteItemAsync(APP_STATE_KEY);

    resetBackgroundState();
  };

  // ── INITIAL LOCATION + AUTO-RESUME ──
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
        setLocation({ latitude: c.latitude, longitude: c.longitude });
        setGpsAcc(c.accuracy);
        prevRef.current = {
          latitude: c.latitude,
          longitude: c.longitude,
          timestamp: loc.timestamp,
        };
      }

      const wasTracking = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
      if (wasTracking === 'true' && !cancelled) {
        addLog('info', 'Auto-resuming previous session');
        startTracking();
      }
    })();

    return () => {
      cancelled = true;
      pingLoopActiveRef.current = false;
      if (subRef.current) subRef.current.remove();
    };
  }, [startTracking, addLog]);

  // ── LOADING ──
  if (!location) {
    return (
      <SafeAreaView style={s.loadingWrap}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={s.loadingText}>Acquiring GPS Signal...</Text>
        <Text style={s.loadingSub}>Waiting for high-accuracy fix</Text>
      </SafeAreaView>
    );
  }

  // ── COMPUTED VALUES ──
  const speedKmh = speed > 0 ? (speed * 3.6).toFixed(1) : '0.0';
  const distDisplay =
    totalDist >= 1000
      ? (totalDist / 1000).toFixed(2) + ' km'
      : Math.round(totalDist) + ' m';
  const accDisplay = gpsAcc ? gpsAcc.toFixed(0) + 'm' : '--';
  const activity =
    speed === 0
      ? 'Stationary'
      : speed * 3.6 < 5
      ? 'Walking'
      : speed * 3.6 < 20
      ? 'Cycling'
      : 'Driving';

  const logColor = (level) => {
    if (level === 'error') return '#ef4444';
    if (level === 'warn') return '#f59e0b';
    return '#94a3b8';
  };

  return (
    <SafeAreaView style={s.container}>
      {/* HEADER */}
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

      {/* SPEED */}
      <View style={s.speedSection}>
        <Text style={s.speedVal}>{speedKmh}</Text>
        <Text style={s.speedUnit}>km/h</Text>
        <Text style={s.speedLabel}>{activity}</Text>
      </View>

      {/* STATS */}
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

      {/* MINI MAP */}
      <MiniMap ref={mapRef} latitude={location.latitude} longitude={location.longitude} />

      {/* COORDS + SERVER */}
      <View style={s.infoCard}>
        <Row
          label="Position"
          value={`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`}
        />
        <Row
          label="Server"
          value={serverStatus}
          valueColor={
            serverStatus === 'Synced'
              ? '#16a34a'
              : serverStatus === 'Rate Limited' ||
                serverStatus === 'Server Error' ||
                serverStatus === 'Error' ||
                serverStatus === 'Offline'
              ? '#dc2626'
              : '#888'
          }
        />
      </View>

      {/* DEBUG LOG PANEL */}
      <Pressable
        onPress={() => setShowLogs((v) => !v)}
        style={s.logToggle}
      >
        <Text style={s.logToggleText}>
          {showLogs ? '▲ Hide Logs' : '▼ Debug Logs'} ({debugLogs.length})
        </Text>
        {debugLogs.some((l) => l.level === 'error') && (
          <View style={s.errorDot} />
        )}
      </Pressable>

      {showLogs && (
        <View style={s.logPanel}>
          <ScrollView
            ref={logScrollRef}
            style={s.logScroll}
            onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: false })}
          >
            {debugLogs.length === 0 ? (
              <Text style={s.logEmpty}>No logs yet</Text>
            ) : (
              debugLogs.map((entry) => (
                <Text key={entry.id} style={[s.logLine, { color: logColor(entry.level) }]}>
                  {entry.time} {entry.message}
                </Text>
              ))
            )}
          </ScrollView>
          <Pressable onPress={() => setDebugLogs([])} style={s.clearBtn}>
            <Text style={s.clearBtnText}>Clear</Text>
          </Pressable>
        </View>
      )}

      {/* BUTTONS */}
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
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  loadingWrap: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  loadingText: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginTop: 20 },
  loadingSub: { fontSize: 13, color: '#94A3B8', marginTop: 6 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  headerUser: { fontSize: 12, color: '#64748B', marginTop: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
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
  statCard: {
    flex: 1,
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  statVal: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 2 },
  statLbl: {
    fontSize: 9,
    color: '#94A3B8',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  infoCard: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },

  // ── Debug Log Panel ──
  logToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginBottom: 4,
  },
  logToggleText: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  errorDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#ef4444',
    marginLeft: 6,
  },
  logPanel: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    maxHeight: 160,
  },
  logScroll: {
    maxHeight: 130,
  },
  logLine: {
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 16,
  },
  logEmpty: {
    fontSize: 10,
    color: '#475569',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  clearBtn: {
    alignSelf: 'flex-end',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#1E293B',
    borderRadius: 4,
  },
  clearBtnText: {
    fontSize: 10,
    color: '#94A3B8',
    fontWeight: '600',
  },

  actions: { marginTop: 'auto', paddingBottom: 32 },
  btnTrack: {
    backgroundColor: '#0F172A',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnStop: {
    backgroundColor: '#EF4444',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnTextWhite: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  btnLogout: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  btnLogoutText: { color: '#64748B', fontSize: 14, fontWeight: '600' },
});