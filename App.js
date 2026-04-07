import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import LoginScreen from './src/screens/LoginScreen';
import TrackingScreen from './src/screens/TrackingScreen';
import { getMe } from './src/api/auth';
import { STORAGE_KEY, TRACKING, TRACKING_ACTIVE_KEY } from './src/config/constants';

const AUTH_TOKEN_KEY = 'auth_token';
const AUTH_USER_KEY = 'auth_user';

export default function App() {
  const [user, setUser] = useState(null);     // { id, name, email }
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // Restore auth + tracking state on app open
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
        const savedUser = await SecureStore.getItemAsync(AUTH_USER_KEY);

        if (savedToken && savedUser) {
          // Verify token is still valid
          const data = await getMe(savedToken);
          if (data.ok && data.user) {
            setToken(savedToken);
            setUser(data.user);
          } else {
            // Token expired — clear stored auth
            await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
            await SecureStore.deleteItemAsync(AUTH_USER_KEY);
          }
        }
      } catch {
        // Network error — still use cached user so tracking continues offline
        try {
          const savedToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
          const savedUser = await SecureStore.getItemAsync(AUTH_USER_KEY);
          if (savedToken && savedUser) {
            setToken(savedToken);
            setUser(JSON.parse(savedUser));
          }
        } catch {}
      }
      setLoading(false);
    })();
  }, []);

  // Handle login/register success
  const handleAuth = async (newToken, newUser) => {
    setToken(newToken);
    setUser(newUser);
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, newToken);
    await SecureStore.setItemAsync(AUTH_USER_KEY, JSON.stringify(newUser));
  };

  // Handle logout
  const handleLogout = async () => {
    setUser(null);
    setToken(null);
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(AUTH_USER_KEY);
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    await SecureStore.deleteItemAsync(TRACKING_ACTIVE_KEY);
    await SecureStore.deleteItemAsync(TRACKING.SESSION_KEY);
  };

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  if (!user) return <LoginScreen onAuth={handleAuth} />;
  return <TrackingScreen user={user} onLogout={handleLogout} />;
}
