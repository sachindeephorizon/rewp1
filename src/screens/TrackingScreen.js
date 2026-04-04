import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
  SafeAreaView,
} from 'react-native';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as IntentLauncher from 'expo-intent-launcher';

import { BACKGROUND_TASK, GPS, STORAGE_KEY } from '../config/constants';
import { sendPing, sendStop, fetchSessionDistance } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';

const TRACKING_ACTIVE_KEY = 'tracking_active';
const APP_STATE_KEY = 'tracking_app_state';
const STATIONARY_PING_COOLDOWN = 30_000;

// ── Light filtering only ─────────────────────────────────────────────
// Drops bad GPS readings only (poor accuracy, impossible jumps/speed).
// All heavy smoothing (Kalman, sliding window) is done on the backend.
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

    const moving = distance >= GPS.MIN_MOVEMENT;
    return { latitude, longitude, accuracy, timestamp: ts, speed, distance, moving };
  }

  return { latitude, longitude, accuracy, timestamp: ts, speed: 0, distance: 0, moving: false };
};

export default function TrackingScreen({ user, onLogout }) {
  const userId = user.name || user.email || String(user.id);

  const [location, setLocation] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [gpsAcc, setGpsAcc] = useState(null);
  const [totalDist, setTotalDist] = useState(0);
  const [serverStatus, setServerStatus] = useState('--');

  const prevRef = useRef(null);
  const subRef = useRef(null);
  const distRef = useRef(0);
  const mapRef = useRef(null);
  const latestPingRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const lastStationaryPingRef = useRef(0);

  // ── APP STATE SYNC + DISTANCE RESYNC ──
  useEffect(() => {
    const onAppStateChange = async (state) => {
      try {
        await SecureStore.setItemAsync(
          APP_STATE_KEY,
          state === 'active' ? 'foreground' : 'background'
        );
      } catch {}

      // When app comes back to foreground, sync distance from backend
      if (state === 'active' && isTracking) {
        const dist = await fetchSessionDistance(userId);
        if (dist != null && dist > distRef.current) {
          distRef.current = dist;
          setTotalDist(dist);
        }
      }
    };

    onAppStateChange(AppState.currentState);
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, [isTracking, userId]);

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

  // ── START TRACKING ──
  const startTracking = useCallback(async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') console.warn('Background permission denied');

    await requestBatteryExemption();

    setIsTracking(true);
    await SecureStore.setItemAsync(TRACKING_ACTIVE_KEY, 'true');
    distRef.current = 0;
    setTotalDist(0);
    setServerStatus('--');
    lastStationaryPingRef.current = 0;
    prevRef.current = null;

    // ── GPS CALLBACK ──
    const onGpsUpdate = (loc) => {
      const r = lightFilter(loc, prevRef.current);
      if (!r) return;

      prevRef.current = {
        latitude: r.latitude,
        longitude: r.longitude,
        timestamp: r.timestamp,
      };

      // Only update UI when app is visible
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

      // Always update ping ref regardless of screen state
      latestPingRef.current = r;
    };

    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: GPS.GPS_INTERVAL_MOVING,
        distanceInterval: 0,
      },
      onGpsUpdate
    );
    subRef.current = sub;

    // ── PING INTERVAL ──
    latestPingRef.current = null;
    pingIntervalRef.current = setInterval(async () => {
      const r = latestPingRef.current;
      if (!r) return;

      if (!r.moving) {
        const now = Date.now();
        if (now - lastStationaryPingRef.current < STATIONARY_PING_COOLDOWN) return;
        lastStationaryPingRef.current = now;
      }

      latestPingRef.current = null;

      const result = await sendPing(userId, r);
      if (result.status === 'synced') setServerStatus('Synced');
      else if (result.status === 'filtered') { /* backend filtered */ }
      else if (result.status === 'rate_limited') { /* retry next interval */ }
      else if (result.status === 'server_error') setServerStatus('Server Error');
      else if (result.status === 'offline') setServerStatus('Offline');
      else setServerStatus('Error');
    }, 3000);

    // ── BACKGROUND TASK ──
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
  }, [userId]);

  // ── STOP TRACKING ──
  const stopTracking = async () => {
    setIsTracking(false);
    await SecureStore.deleteItemAsync(TRACKING_ACTIVE_KEY);
    setServerStatus('Stopped');

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    latestPingRef.current = null;
    lastStationaryPingRef.current = 0;

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
        startTracking();
      }
    })();

    return () => {
      cancelled = true;
      if (subRef.current) subRef.current.remove();
    };
  }, [startTracking]);

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
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
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