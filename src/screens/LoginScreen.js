import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  SafeAreaView,
} from 'react-native';
import { login, register } from '../api/auth';

export default function LoginScreen({ onAuth }) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }
    if (isSignUp && !name.trim()) {
      setError('Name is required');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      const data = isSignUp
        ? await register(name.trim(), email.trim(), password)
        : await login(email.trim(), password);

      if (data.error) {
        setError(data.error);
      } else if (data.ok && data.token && data.user) {
        onAuth(data.token, data.user);
      } else {
        setError('Unexpected response');
      }
    } catch {
      setError('Network error — check your connection');
    }
    setLoading(false);
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.card}>
            <Text style={s.title}>Deep Horizon</Text>
            <Text style={s.sub}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>

            {/* TABS */}
            <View style={s.tabs}>
              <Pressable style={[s.tab, !isSignUp && s.tabActive]} onPress={() => { setIsSignUp(false); setError(''); }}>
                <Text style={[s.tabText, !isSignUp && s.tabTextActive]}>Login</Text>
              </Pressable>
              <Pressable style={[s.tab, isSignUp && s.tabActive]} onPress={() => { setIsSignUp(true); setError(''); }}>
                <Text style={[s.tabText, isSignUp && s.tabTextActive]}>Sign Up</Text>
              </Pressable>
            </View>

            {/* FIELDS */}
            {isSignUp && (
              <TextInput
                style={s.input}
                placeholder="Full Name"
                placeholderTextColor="#999"
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
              />
            )}
            <TextInput
              style={s.input}
              placeholder="Email"
              placeholderTextColor="#999"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            <TextInput
              style={s.input}
              placeholder="Password"
              placeholderTextColor="#999"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            {error ? <Text style={s.error}>{error}</Text> : null}

            <Pressable style={[s.btn, loading && s.btnDisabled]} onPress={handleSubmit} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Text style={s.btnText}>{isSignUp ? 'Create Account' : 'Login'}</Text>
              )}
            </Pressable>

            <Pressable onPress={() => { setIsSignUp(!isSignUp); setError(''); }} style={s.switchBtn}>
              <Text style={s.switchText}>
                {isSignUp ? 'Already have an account? Login' : "Don't have an account? Sign Up"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F8FAFC', paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 },
  card: {
    backgroundColor: '#FFF', padding: 28, borderRadius: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12, elevation: 5,
  },
  title: { fontSize: 26, fontWeight: '800', color: '#0F172A', textAlign: 'center' },
  sub: { fontSize: 14, color: '#94A3B8', textAlign: 'center', marginTop: 4, marginBottom: 20 },

  tabs: { flexDirection: 'row', backgroundColor: '#F1F5F9', borderRadius: 10, marginBottom: 20, padding: 3 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: '#FFF', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  tabText: { fontSize: 14, fontWeight: '600', color: '#94A3B8' },
  tabTextActive: { color: '#0F172A' },

  input: {
    borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: 12, padding: 14,
    fontSize: 15, color: '#1E293B', backgroundColor: '#F8FAFC', marginBottom: 14,
  },
  error: { color: '#EF4444', fontSize: 13, marginBottom: 14, textAlign: 'center' },
  btn: { backgroundColor: '#0F172A', paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  btnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },
  switchBtn: { marginTop: 16, alignItems: 'center' },
  switchText: { color: '#64748B', fontSize: 13 },
});
