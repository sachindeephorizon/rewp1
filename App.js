import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LogBox,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import MapLibreGL, { MapView, Camera, PointAnnotation } from '@maplibre/maplibre-react-native';

LogBox.ignoreLogs(['MapLibre', 'Request failed']);
MapLibreGL.setConnected(true);
MapLibreGL.Logger.setLogLevel('error');

const apiKey = '6924832d-2b20-4606-bed6-186d248b40e8';
const styleUrl = `https://tiles.stadiamaps.com/styles/outdoors.json?api_key=${apiKey}`;

const BACKEND_URL = 'https://live-tracker-zz5c.onrender.com';
const BACKGROUND_TASK = 'background-location-task';

const STORAGE_KEY = 'activeUserId';

// Background task — runs even when app is closed/killed.
// Reads userId from AsyncStorage (persists across app restarts).
TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;
  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!userId) return;
    const loc = data.locations?.[0];
    if (loc) {
      await fetch(`${BACKEND_URL}/${userId}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          speed: loc.coords.speed ?? null,
        }),
      });
    }
  } catch {}
});

// ── Pulsing blue dot on map ─────────────────────────────────────────
function BlueDot() {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.8, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  return (
    <View style={styles.dotContainer}>
      <Animated.View style={[styles.pulse, { transform: [{ scale: pulseAnim }] }]} />
      <View style={styles.dot} />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SCREENS
// ═══════════════════════════════════════════════════════════════════

// ── 1. Login Screen ─────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [userId, setUserId] = useState('');

  const handleLogin = () => {
    const trimmed = userId.trim();
    if (!trimmed) return;
    onLogin(trimmed);
  };

  return (
    <View style={styles.loginContainer}>
      <View style={styles.loginCard}>
        <Text style={styles.loginTitle}>Deep Horizon</Text>
        <Text style={styles.loginSubtitle}>Location Service</Text>

        <Text style={styles.inputLabel}>Your User ID</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. user_4ic9h4"
          placeholderTextColor="#999"
          value={userId}
          onChangeText={setUserId}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          style={[styles.btn, styles.btnPrimary, !userId.trim() && styles.btnDisabled]}
          onPress={handleLogin}
          disabled={!userId.trim()}
        >
          <Text style={styles.btnText}>Login</Text>
        </Pressable>
      </View>
      <StatusBar style="dark" />
    </View>
  );
}

// ── 2. Tracking Screen (Map + Controls) ─────────────────────────────
function TrackingScreen({ userId, onLogout, onStopAndLogout }) {
  const [location, setLocation] = useState(null);
  const [displayCoords, setDisplayCoords] = useState(null);
  const [sendStatus, setSendStatus] = useState('waiting');
  const [bgRunning, setBgRunning] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const cameraRef = useRef(null);
  const locationRef = useRef(null);
  const locationSubRef = useRef(null);
  const intervalRef = useRef(null);

  // Send location to backend via /:id/ping
  const sendLocationToServer = useCallback(
    async (coords) => {
      try {
        const res = await fetch(`${BACKEND_URL}/${userId}/ping`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: coords.latitude, lng: coords.longitude, speed: coords.speed ?? null }),
        });
        setSendStatus(res.ok ? 'sent' : 'error');
      } catch {
        setSendStatus('offline');
      }
    },
    [userId]
  );

  // Get initial location on mount (just to show the map)
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Location permission denied');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setLocation(loc.coords);
      locationRef.current = loc.coords;
      setDisplayCoords({ lat: loc.coords.latitude, lng: loc.coords.longitude, speed: loc.coords.speed });
    })();
  }, []);

  // ── Start Tracking ──────────────────────────────────────────────
  const startTracking = useCallback(async () => {
    setTracking(true);
    setSendStatus('waiting');
    await SecureStore.setItemAsync(STORAGE_KEY, userId);

    // Foreground watcher
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 3000, distanceInterval: 2 },
      (loc) => {
        setLocation(loc.coords);
        locationRef.current = loc.coords;
      }
    );
    locationSubRef.current = sub;

    // Send every 10s
    const iv = setInterval(() => {
      const coords = locationRef.current;
      if (coords) {
        setDisplayCoords({ lat: coords.latitude, lng: coords.longitude, speed: coords.speed });
        sendLocationToServer(coords);
      }
    }, 10000);
    intervalRef.current = iv;

    // Send immediately
    if (locationRef.current) sendLocationToServer(locationRef.current);

    // Background tracking
    const { status } = await Location.getBackgroundPermissionsAsync();
    let bgGranted = status === 'granted';
    if (!bgGranted) {
      const { status: s } = await Location.requestBackgroundPermissionsAsync();
      bgGranted = s === 'granted';
    }
    if (bgGranted) {
      const isRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
      if (!isRunning) {
        await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 10000,
          distanceInterval: 5,
          foregroundService: {
            notificationTitle: 'Deep Horizon — Tracking',
            notificationBody: `Tracking ${userId}`,
            notificationColor: '#007AFF',
          },
          pausesUpdatesAutomatically: false,
        });
      }
      setBgRunning(true);
    }

  }, [userId, sendLocationToServer]);

  // ── Stop Tracking ───────────────────────────────────────────────
  const stopTracking = useCallback(async () => {
    // Tell backend to remove this user from active list
    try {
      await fetch(`${BACKEND_URL}/${userId}/stop`, { method: 'POST' });
    } catch {}

    await SecureStore.deleteItemAsync(STORAGE_KEY);

    if (locationSubRef.current) {
      locationSubRef.current.remove();
      locationSubRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const isRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
    }

    setTracking(false);
    setBgRunning(false);
    setSendStatus('waiting');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTracking();
    };
  }, [stopTracking]);

  const onMapReady = () => {
    if (location && cameraRef.current) {
      cameraRef.current.setCamera({
        centerCoordinate: [location.longitude, location.latitude],
        zoomLevel: 16,
        animationDuration: 1000,
      });
    }
  };

  // ── Error state ─────────────────────────────────────────────────
  if (errorMsg) {
    return (
      <View style={styles.center}>
        <Text style={{ color: '#FF3B30', fontSize: 16 }}>{errorMsg}</Text>
      </View>
    );
  }

  // ── Loading state ───────────────────────────────────────────────
  if (!location) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={{ color: '#666', marginTop: 10 }}>Getting your location...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Map */}
      <MapView style={styles.map} mapStyle={styleUrl} onDidFinishLoadingMap={onMapReady}>
        <Camera
          ref={cameraRef}
          centerCoordinate={[location.longitude, location.latitude]}
          zoomLevel={16}
          animationMode="easeTo"
          animationDuration={500}
        />
        <PointAnnotation
          id="userLocation"
          coordinate={[location.longitude, location.latitude]}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <BlueDot />
        </PointAnnotation>
      </MapView>

      {/* Info Card */}
      <View style={styles.infoCard}>
        {/* User header */}
        <View style={styles.userRow}>
          <View>
            <Text style={styles.userIdText}>{userId}</Text>
            <Text style={styles.labelSmall}>Logged in</Text>
          </View>
          <Pressable
            style={[styles.btn, styles.btnSmall, styles.btnOutline]}
            onPress={async () => {
              if (tracking) {
                await stopTracking(); // flush to postgres first
              }
              onLogout();
            }}
          >
            <Text style={styles.btnOutlineText}>Logout</Text>
          </Pressable>
        </View>

        {/* Coordinates + Speed */}
        {displayCoords && (
          <View style={styles.coordsRow}>
            <Text style={styles.coordsText}>Lat: {displayCoords.lat.toFixed(6)}</Text>
            <Text style={styles.coordsText}>Lng: {displayCoords.lng.toFixed(6)}</Text>
            <Text style={styles.speedText}>
              {displayCoords.speed != null && displayCoords.speed >= 0
                ? `${(displayCoords.speed * 3.6).toFixed(1)} km/h`
                : '0.0 km/h'}
            </Text>
          </View>
        )}

        {/* Status indicators (only when tracking) */}
        {tracking && (
          <View style={styles.statusSection}>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor:
                      sendStatus === 'sent' ? '#34C759' : sendStatus === 'offline' ? '#FF3B30' : '#FF9500',
                  },
                ]}
              />
              <Text style={styles.statusText}>
                {sendStatus === 'sent'
                  ? 'Synced to server'
                  : sendStatus === 'offline'
                  ? 'Server offline'
                  : sendStatus === 'error'
                  ? 'Send failed'
                  : 'Waiting...'}
              </Text>
            </View>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: bgRunning ? '#34C759' : '#FF9500' }]} />
              <Text style={styles.statusText}>
                {bgRunning ? 'Background tracking active' : 'Foreground only'}
              </Text>
            </View>
          </View>
        )}

        {/* Track Me / Stop button */}
        {!tracking ? (
          <Pressable style={[styles.btn, styles.btnTrack]} onPress={startTracking}>
            <Text style={styles.btnText}>Track Me</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.btn, styles.btnStop]} onPress={stopTracking}>
            <Text style={styles.btnText}>Stop Tracking</Text>
          </Pressable>
        )}
      </View>

      <StatusBar style="auto" />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  ROOT — switches between Login and Tracking
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const [userId, setUserId] = useState(null);

  const handleLogout = async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    // Stop any running background task
    const isRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK).catch(() => false);
    if (isRunning) await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
    setUserId(null);
  };

  if (!userId) {
    return <LoginScreen onLogin={setUserId} />;
  }

  return <TrackingScreen userId={userId} onLogout={handleLogout} />;
}

// ═══════════════════════════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  // ── Layout ────────────────────────────────────────────────────
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },

  // ── Login ─────────────────────────────────────────────────────
  loginContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loginCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 28,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  loginTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111',
    textAlign: 'center',
  },
  loginSubtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    marginBottom: 28,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    fontFamily: 'monospace',
    color: '#111',
    backgroundColor: '#fafafa',
    marginBottom: 8,
  },

  // ── Buttons ───────────────────────────────────────────────────
  btn: {
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  btnPrimary: { backgroundColor: '#007AFF' },
  btnDisabled: { opacity: 0.4 },
  btnTrack: { backgroundColor: '#34C759' },
  btnStop: { backgroundColor: '#FF3B30' },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 16, marginTop: 0, borderRadius: 8 },
  btnOutline: { borderWidth: 1, borderColor: '#ddd', backgroundColor: 'transparent' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  btnOutlineText: { color: '#888', fontSize: 13, fontWeight: '600' },

  // ── Map ────────────────────────────────────────────────────────
  map: { height: '55%', alignSelf: 'stretch' },

  // ── Info Card ──────────────────────────────────────────────────
  infoCard: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  userRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  userIdText: { fontSize: 16, fontWeight: '700', color: '#111', fontFamily: 'monospace' },
  labelSmall: { fontSize: 11, color: '#aaa', marginTop: 2 },

  coordsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f5f7fa',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  coordsText: { fontSize: 14, color: '#007AFF', fontFamily: 'monospace' },
  speedText: { fontSize: 16, color: '#34C759', fontWeight: '700', fontFamily: 'monospace' },

  // ── Status ─────────────────────────────────────────────────────
  statusSection: { marginBottom: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, color: '#666' },

  // ── BlueDot ────────────────────────────────────────────────────
  dotContainer: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pulse: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0, 122, 255, 0.2)',
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    borderWidth: 3,
    borderColor: '#fff',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
});
