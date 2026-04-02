import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
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

import { BACKGROUND_TASK, GPS, STORAGE_KEY } from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation } from '../utils/processLocation';
import { sendPing, sendStop } from '../api/location';
import { resetBackgroundState } from '../tasks/backgroundLocation';
import MiniMap from '../components/MiniMap';
import Row from '../components/Row';

const TRACKING_ACTIVE_KEY = 'tracking_active';
const APP_STATE_KEY = 'tracking_app_state';

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
  const kalmanRef = useRef(new KalmanFilter2D());
  const mapRef = useRef(null);

  useEffect(() => {
    const syncAppState = async (state) => {
      try {
        await SecureStore.setItemAsync(APP_STATE_KEY, state === 'active' ? 'foreground' : 'background');
      } catch {}
    };

    syncAppState(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncAppState);

    return () => {
      subscription.remove();
    };
  }, []);

  const updateMap = (lat, lng) => {
    mapRef.current?.postMessage(JSON.stringify({ t: 'loc', a: lat, o: lng }));
  };

  // ── START TRACKING ──
  const startTracking = async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') console.warn('Background permission denied');

    setIsTracking(true);
    await SecureStore.setItemAsync(TRACKING_ACTIVE_KEY, 'true');
    distRef.current = 0;
    setTotalDist(0);
    setServerStatus('--');

    kalmanRef.current.reset();
    prevRef.current = null;

    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
      },
      async (loc) => {
        if (AppState.currentState !== 'active') return;

        const r = processLocation(loc, prevRef.current, kalmanRef.current);
        if (!r) return;

        prevRef.current = { latitude: r.latitude, longitude: r.longitude, timestamp: r.timestamp };

        setLocation({ latitude: r.latitude, longitude: r.longitude });
        updateMap(r.latitude, r.longitude);
        setSpeed(r.speed);
        setGpsAcc(r.accuracy);

        if (r.moving && r.distance > 0) {
          distRef.current += r.distance;
          setTotalDist(distRef.current);
        }

        const result = await sendPing(userId, r);
        if (result.status === 'synced') setServerStatus('Synced');
        else if (result.status === 'filtered') { /* backend filtered it — don't change status */ }
        else if (result.status === 'rate_limited') setServerStatus('Rate Limited');
        else if (result.status === 'server_error') setServerStatus('Server Error');
        else if (result.status === 'offline') setServerStatus('Offline');
        else setServerStatus('Error');
      }
    );
    subRef.current = sub;

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
  };

  // ── STOP TRACKING ──
  const stopTracking = async () => {
    setIsTracking(false);
    await SecureStore.deleteItemAsync(TRACKING_ACTIVE_KEY);
    setServerStatus('Stopped');

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

  // ── INITIAL LOCATION ──
  // ── INITIAL LOCATION + AUTO-RESUME TRACKING ──
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
        prevRef.current = { latitude: c.latitude, longitude: c.longitude, timestamp: loc.timestamp };
      }

      // Auto-resume: if tracking was active when app closed, restart it
      const wasTracking = await SecureStore.getItemAsync(TRACKING_ACTIVE_KEY);
      if (wasTracking === 'true' && !cancelled) {
        startTracking();
      }
    })();

    return () => { cancelled = true; if (subRef.current) subRef.current.remove(); };
  }, []);

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
  const distDisplay = totalDist >= 1000 ? (totalDist / 1000).toFixed(2) + ' km' : Math.round(totalDist) + ' m';
  const accDisplay = gpsAcc ? gpsAcc.toFixed(0) + 'm' : '--';
  const activity = speed === 0 ? 'Stationary' : speed * 3.6 < 5 ? 'Walking' : speed * 3.6 < 20 ? 'Cycling' : 'Driving';

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
        <Row label="Position" value={`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`} />
        <Row
          label="Server"
          value={serverStatus}
          valueColor={serverStatus === 'Synced' ? '#16a34a' : serverStatus === 'Rate Limited' || serverStatus === 'Server Error' || serverStatus === 'Error' || serverStatus === 'Offline' ? '#dc2626' : '#888'}
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
  statCard: {
    flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  statVal: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 2 },
  statLbl: { fontSize: 9, color: '#94A3B8', textTransform: 'uppercase', fontWeight: '600', letterSpacing: 0.5 },

  infoCard: {
    backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },

  actions: { marginTop: 'auto', paddingBottom: 32 },
  btnTrack: { backgroundColor: '#0F172A', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnStop: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnTextWhite: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  btnLogout: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  btnLogoutText: { color: '#64748B', fontSize: 14, fontWeight: '600' },
});
