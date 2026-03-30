import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  SafeAreaView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

const BACKEND_URL = 'https://live-tracker-zz5c.onrender.com';
const BACKGROUND_TASK = 'background-location-task';
const STORAGE_KEY = 'activeUserId';

// ───────── GPS CONFIG ─────────
const GPS = {
  MAX_ACCURACY: 30,          // Reject GPS readings with accuracy > 30m
  MAX_JUMP: 100,             // Reject teleport jumps > 100m
  MAX_SPEED: 50,             // Reject speeds > 50 m/s (~180 km/h)
  MIN_MOVEMENT: 3,           // Ignore drift < 3m (stationary noise)
  MIN_SPEED: 0.5,            // Clamp speeds below 0.5 m/s to zero
  SMOOTH: 0.3,               // Weighted average: 30% previous + 70% current
  MIN_TIME_MS: 500,          // Ignore updates < 500ms apart
};

// ───────── HAVERSINE DISTANCE (meters) ─────────
const getDistance = (a, b) => {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

// ═══════════════════════════════════════════════════════════
//  2D KALMAN FILTER (with velocity prediction)
//  Matches backend gps.js — predicts next position using
//  constant-velocity model, then corrects with GPS measurement.
//  R adapts to GPS accuracy: noisier fix → trust prediction more.
// ═══════════════════════════════════════════════════════════
class KalmanFilter2D {
  constructor() {
    this.x = null;        // estimated position [lat, lng]
    this.v = [0, 0];      // estimated velocity [dlat/s, dlng/s]
    this.P = 1;           // error covariance
    this.Q = 0.00001;     // process noise (how much we expect movement to vary)
    this.R = 0.0001;      // base measurement noise
  }

  update(measurement, dt, accuracy) {
    if (!this.x) {
      this.x = [...measurement];
      return this.x;
    }

    // ── PREDICT: constant-velocity model ──
    const predicted = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];
    const predictedP = this.P + this.Q;

    // ── Adaptive R: scale measurement noise by GPS accuracy ──
    // accuracy=5m → trust GPS more (low R), accuracy=30m → trust prediction more (high R)
    const adaptiveR = this.R * Math.max(1, accuracy / 5);

    // ── UPDATE: Kalman gain ──
    const K = predictedP / (predictedP + adaptiveR);

    // Correct position with measurement
    this.x = [
      predicted[0] + K * (measurement[0] - predicted[0]),
      predicted[1] + K * (measurement[1] - predicted[1]),
    ];

    // Update velocity estimate
    if (dt > 0) {
      this.v = [
        (this.x[0] - predicted[0] + this.v[0] * dt) / dt,
        (this.x[1] - predicted[1] + this.v[1] * dt) / dt,
      ];
    }

    // Update error covariance
    this.P = (1 - K) * predictedP;

    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
  }
}

// ═══════════════════════════════════════════════════════════
//  CORE GPS PROCESSOR — shared by foreground & background
//  Identical logic in both paths. Never sends raw GPS.
//  Uses Kalman filter instead of simple weighted average.
// ═══════════════════════════════════════════════════════════
const processLocation = (loc, prev, kalman) => {
  const { latitude, longitude, accuracy } = loc.coords;
  const ts = loc.timestamp; // GPS timestamp — NOT Date.now()

  // REJECT: bad accuracy (>30m)
  if (!accuracy || accuracy > GPS.MAX_ACCURACY) return null;

  // REJECT: invalid coordinates
  if (!latitude || !longitude) return null;

  // REJECT: no valid GPS timestamp
  if (!ts || ts <= 0) return null;

  const point = { latitude, longitude };

  if (prev) {
    const timeDiff = ts - prev.timestamp;

    // REJECT: zero / too-small time gap
    if (!timeDiff || timeDiff < GPS.MIN_TIME_MS) return null;

    const dt = timeDiff / 1000; // seconds
    const distance = getDistance(prev, point);

    // REJECT: unrealistic GPS jump (>100m)
    if (distance > GPS.MAX_JUMP) return null;

    // CALCULATE speed from distance/time — never use coords.speed
    const rawSpeed = distance / dt;

    // REJECT: teleport speed (>50 m/s)
    if (rawSpeed > GPS.MAX_SPEED) return null;

    // STATIONARY: drift < 3m → clamp position, zero speed
    if (distance < GPS.MIN_MOVEMENT) {
      // Feed stationary position to Kalman so it converges, but don't move output
      kalman.update([prev.latitude, prev.longitude], dt, accuracy);
      return {
        latitude: prev.latitude,
        longitude: prev.longitude,
        speed: 0,
        accuracy,
        timestamp: ts,
        distance: 0,
        moving: false,
      };
    }

    // Apply Kalman filter (replaces simple weighted average)
    const filtered = kalman.update([latitude, longitude], dt, accuracy);

    // Speed from Kalman-filtered position for consistency
    const filteredDist = getDistance(prev, { latitude: filtered[0], longitude: filtered[1] });
    const speed = filteredDist / dt;

    return {
      latitude: filtered[0],
      longitude: filtered[1],
      speed: speed < GPS.MIN_SPEED ? 0 : speed,
      accuracy,
      timestamp: ts,
      distance: filteredDist,
      moving: true,
    };
  }

  // First reading — initialize Kalman
  kalman.update([latitude, longitude], 1, accuracy);

  return {
    latitude,
    longitude,
    speed: 0,
    accuracy,
    timestamp: ts,
    distance: 0,
    moving: false,
  };
};

// ───────── BACKGROUND STATE (global — TaskManager runs outside React) ─────────
let bgPrev = null;
const bgKalman = new KalmanFilter2D();

// ═══════════════════════════════════════════════════════════
//  BACKGROUND TASK — same processing logic as foreground
// ═══════════════════════════════════════════════════════════
TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;
  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const loc = data.locations?.[0];
    if (!userId || !loc) return;

    const result = processLocation(loc, bgPrev, bgKalman);
    if (!result) return;

    // Update background previous-location
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

// ═══════════════════════════════════════════════════════════
//  LOGIN SCREEN
// ═══════════════════════════════════════════════════════════
function LoginScreen({ onLogin }) {
  const [userId, setUserId] = useState('');
  return (
    <SafeAreaView style={styles.loginContainer}>
      <View style={styles.loginCard}>
        <Text style={styles.loginTitle}>Deep Horizon</Text>
        <Text style={styles.loginSub}>Live Location Tracker</Text>
        <TextInput
          style={styles.input}
          placeholder="Enter User ID"
          placeholderTextColor="#999"
          value={userId}
          onChangeText={setUserId}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[styles.btnPrimary, !userId.trim() && styles.btnDisabled]}
          onPress={() => userId.trim() && onLogin(userId.trim())}
          disabled={!userId.trim()}
        >
          <Text style={styles.btnTextWhite}>Login</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════
//  TRACKING SCREEN — no map, just Track Me + stats
// ═══════════════════════════════════════════════════════════
function TrackingScreen({ userId, onLogout }) {
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


  // ── Mini map HTML (Leaflet + OSM, blue dot, no extra lib) ──
  const buildMapHTML = (lat, lng) => `
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>*{margin:0;padding:0}html,body,#m{width:100%;height:100%}</style>
</head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,attributionControl:false}).setView([${lat},${lng}],17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:20}).addTo(map);
var dot=L.divIcon({className:'',html:'<div style="width:16px;height:16px;background:#2563EB;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.25)"></div>',iconSize:[16,16],iconAnchor:[8,8]});
var mk=L.marker([${lat},${lng}],{icon:dot}).addTo(map);
document.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.t==='loc'){mk.setLatLng([d.a,d.o]);map.setView([d.a,d.o],map.getZoom(),{animate:true,duration:0.5})}}catch(x){}});
window.addEventListener('message',function(e){try{var d=JSON.parse(e.data);if(d.t==='loc'){mk.setLatLng([d.a,d.o]);map.setView([d.a,d.o],map.getZoom(),{animate:true,duration:0.5})}}catch(x){}});
<\/script></body></html>`;

  // Push location update to mini map
  const updateMap = (lat, lng) => {
    mapRef.current?.postMessage(JSON.stringify({ t: 'loc', a: lat, o: lng }));
  };

  // ── Send filtered data to backend ──
  const sendToBackend = async (r) => {
    try {
      const res = await fetch(`${BACKEND_URL}/${userId}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: r.latitude,
          lng: r.longitude,
          speed: r.speed,
          accuracy: r.accuracy,
          timestamp: r.timestamp,
        }),
      });
      setServerStatus(res.ok ? 'Synced' : 'Error');
    } catch {
      setServerStatus('Offline');
    }
  };

  // ── START TRACKING ──
  const startTracking = async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, userId);

    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return;
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') console.warn('Background permission denied');

    setIsTracking(true);
    distRef.current = 0;
    setTotalDist(0);
    setServerStatus('--');

    // Reset Kalman filters + prev for fresh session
    kalmanRef.current.reset();
    bgKalman.reset();
    prevRef.current = null;
    bgPrev = null;

    const sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 10000,
        distanceInterval: 0,
      },
      (loc) => {
        // Process BEFORE setting state
        const r = processLocation(loc, prevRef.current, kalmanRef.current);
        if (!r) return;

        // Store previous in ref
        prevRef.current = { latitude: r.latitude, longitude: r.longitude, timestamp: r.timestamp };
        bgPrev = { ...prevRef.current };

        // Update UI state with filtered data only
        setLocation({ latitude: r.latitude, longitude: r.longitude });
        updateMap(r.latitude, r.longitude);
        setSpeed(r.speed);
        setGpsAcc(r.accuracy);


        if (r.moving && r.distance > 0) {
          distRef.current += r.distance;
          setTotalDist(distRef.current);
        }

        // Send every valid processed location to backend
        sendToBackend(r);
      }
    );
    subRef.current = sub;

    // Background — same accuracy
    await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 10000,
      distanceInterval: 5,
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
    setServerStatus('Stopped');

    if (subRef.current) {
      subRef.current.remove();
      subRef.current = null;
    }

    // Call /:id/stop to flush session from Redis → PostgreSQL
    try {
      await fetch(`${BACKEND_URL}/${userId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {}


    const running = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
    if (running) await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  };

  // ── INITIAL LOCATION ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;

      // Try high-accuracy first, fall back to lower accuracy after 5s
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
    })();

    return () => { cancelled = true; if (subRef.current) subRef.current.remove(); };
  }, []);

  // ── LOADING ──
  if (!location) {
    return (
      <SafeAreaView style={styles.loadingWrap}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Acquiring GPS Signal...</Text>
        <Text style={styles.loadingSub}>Waiting for high-accuracy fix</Text>
      </SafeAreaView>
    );
  }

  // ── COMPUTED DISPLAY VALUES ──
  const speedKmh = speed > 0 ? (speed * 3.6).toFixed(1) : '0.0';
  const distDisplay = totalDist >= 1000
    ? (totalDist / 1000).toFixed(2) + ' km'
    : Math.round(totalDist) + ' m';
  const accDisplay = gpsAcc ? gpsAcc.toFixed(0) + 'm' : '--';
const activity = speed === 0 ? 'Stationary' : speed * 3.6 < 5 ? 'Walking' : speed * 3.6 < 20 ? 'Cycling' : 'Driving';

  return (
    <SafeAreaView style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Deep Horizon</Text>
          <Text style={styles.headerUser}>@{userId}</Text>
        </View>
        <View style={[styles.badge, isTracking ? styles.badgeOn : styles.badgeOff]}>
          <View style={[styles.dot, isTracking ? styles.dotOn : styles.dotOff]} />
          <Text style={[styles.badgeText, isTracking ? styles.badgeTextOn : styles.badgeTextOff]}>
            {isTracking ? 'LIVE' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      {/* SPEED */}
      <View style={styles.speedSection}>
        <Text style={styles.speedVal}>{speedKmh}</Text>
        <Text style={styles.speedUnit}>km/h</Text>
        <Text style={styles.speedLabel}>{activity}</Text>
      </View>

      {/* STATS */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statVal}>{accDisplay}</Text>
          <Text style={styles.statLbl}>Accuracy</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statVal}>{distDisplay}</Text>
          <Text style={styles.statLbl}>Distance</Text>
        </View>
      </View>

      {/* MINI MAP */}
      <View style={styles.miniMap}>
        <WebView
          ref={mapRef}
          source={{ html: buildMapHTML(location.latitude, location.longitude) }}
          style={{ flex: 1 }}
          scrollEnabled={false}
          javaScriptEnabled
          originWhitelist={['*']}
        />
      </View>

      {/* COORDS + SERVER */}
      <View style={styles.infoCard}>
        <Row label="Position" value={`${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`} />
        <Row label="Server" value={serverStatus}
          valueColor={serverStatus === 'Synced' ? '#16a34a' : serverStatus === 'Error' || serverStatus === 'Offline' ? '#dc2626' : '#888'} />
      </View>

      {/* BUTTONS */}
      <View style={styles.actions}>
        {!isTracking ? (
          <Pressable style={styles.btnTrack} onPress={startTracking}>
            <Text style={styles.btnTextWhite}>Start Track Me</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.btnStop} onPress={stopTracking}>
            <Text style={styles.btnTextWhite}>Stop Tracking</Text>
          </Pressable>
        )}
        <Pressable style={styles.btnLogout} onPress={onLogout}>
          <Text style={styles.btnLogoutText}>Logout</Text>
        </Pressable>
      </View>

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

// ── Helper row ──
function Row({ label, value, valueColor }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════
//  ROOT
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [userId, setUserId] = useState(null);
  if (!userId) return <LoginScreen onLogin={setUserId} />;
  return <TrackingScreen userId={userId} onLogout={() => setUserId(null)} />;
}

// ═══════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },

  // Loading
  loadingWrap: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  loadingText: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginTop: 20 },
  loadingSub: { fontSize: 13, color: '#94A3B8', marginTop: 6 },

  // Header
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

  // Speed
  speedSection: { alignItems: 'center', paddingVertical: 12 },
  speedVal: { fontSize: 48, fontWeight: '800', color: '#0F172A', lineHeight: 54 },
  speedUnit: { fontSize: 14, fontWeight: '600', color: '#64748B', marginTop: 1 },
  speedLabel: { fontSize: 12, color: '#94A3B8', marginTop: 4, fontWeight: '500' },

  // Stats
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard: {
    flex: 1, backgroundColor: '#FFF', borderRadius: 10, padding: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  statVal: { fontSize: 13, fontWeight: '700', color: '#1E293B', marginBottom: 2 },
  statLbl: { fontSize: 9, color: '#94A3B8', textTransform: 'uppercase', fontWeight: '600', letterSpacing: 0.5 },

  // Mini map
  miniMap: {
    height: 150, borderRadius: 10, overflow: 'hidden', marginBottom: 10,
    borderWidth: 1, borderColor: '#E2E8F0',
  },

  // Info card
  infoCard: {
    backgroundColor: '#FFF', borderRadius: 10, padding: 12, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 12, color: '#64748B', fontWeight: '500' },
  rowValue: { fontSize: 12, fontWeight: '700', color: '#1E293B' },

  // Buttons
  actions: { marginTop: 'auto', paddingBottom: 32 },
  btnTrack: { backgroundColor: '#0F172A', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnStop: { backgroundColor: '#EF4444', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  btnTextWhite: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  btnLogout: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  btnLogoutText: { color: '#64748B', fontSize: 14, fontWeight: '600' },
  btnDisabled: { opacity: 0.5 },

  // Login
  loginContainer: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  loginCard: {
    backgroundColor: '#FFF', marginHorizontal: 24, padding: 32, borderRadius: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 5,
  },
  loginTitle: { fontSize: 28, fontWeight: '800', color: '#0F172A', textAlign: 'center' },
  loginSub: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 4, marginBottom: 28 },
  input: { borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, padding: 15, fontSize: 16, color: '#1E293B', backgroundColor: '#F8FAFC', marginBottom: 20 },
  btnPrimary: { backgroundColor: '#0F172A', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  btnTextPrimary: { color: '#FFF', fontSize: 16, fontWeight: '700' },
});
