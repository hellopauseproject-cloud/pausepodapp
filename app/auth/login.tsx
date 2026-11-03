import { FontAwesome } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import DismissKeyboardView from '../components/DismissKeyboardView';
import { useAuth } from '../../contexts/AuthContext';
import { signInWithGoogle } from '../../lib/googleAuth';
import { AppPalette, Radius, Spacing } from '../../constants/appTheme';
import { usePalette } from '../../contexts/ThemeContext';

export default function LoginScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const passwordInputRef = useRef<TextInput>(null);

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 6, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      shake();
      return;
    }
    setLoading(true);
    setError('');
    const { error: err } = await signIn(email.trim(), password);
    setLoading(false);
    if (err) {
      setError('Incorrect email or password.');
      shake();
    } else {
      router.replace('/(tabs)' as never);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    const { error: err } = await signInWithGoogle();
    setGoogleLoading(false);
    if (err) {
      setError(err);
      shake();
    }
    // Vid framgång hanteras navigation av auth-gate i _layout.tsx
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <DismissKeyboardView>
      <View style={styles.inner}>
        <View style={styles.logoRow}>
          <FontAwesome name="pause" size={22} color={Palette.accent} />
          <Text style={styles.logoText}>PAUSEPOD</Text>
        </View>

        <View style={styles.header}>
          <Text style={styles.title}>{'\n'}Welcome.</Text>
          <Text style={styles.subtitle}>Log in to continue.</Text>
        </View>

        <Animated.View style={[styles.form, { transform: [{ translateX: shakeAnim }] }]}>
          <TextInput
            style={styles.input}
            placeholder="Email address"
            placeholderTextColor={Palette.ink20}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            returnKeyType="next"
            onSubmitEditing={() => passwordInputRef.current?.focus()}
          />
          <TextInput
            ref={passwordInputRef}
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={Palette.ink20}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            returnKeyType="done"
            onSubmitEditing={handleLogin}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </Animated.View>

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading || googleLoading}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>{loading ? 'Logging in...' : 'Log in'}</Text>
        </TouchableOpacity>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <TouchableOpacity
          style={[styles.googleButton, googleLoading && styles.buttonDisabled]}
          onPress={handleGoogleSignIn}
          disabled={loading || googleLoading}
          activeOpacity={0.85}
        >
          <Text style={styles.googleG}>G</Text>
          <Text style={styles.googleText}>
            {googleLoading ? 'Connecting...' : 'Continue with Google'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/auth/signup' as never)} style={styles.switchRow}>
          <Text style={styles.switchText}>No account? </Text>
          <Text style={styles.switchLink}>Create one</Text>
        </TouchableOpacity>
      </View>
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Palette.bg,
  },
  inner: {
    flex: 1,
    paddingHorizontal: Spacing.xxl,
    paddingTop: 80,
    paddingBottom: 48,
    justifyContent: 'center',
    gap: 24,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
  },
  logoText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: Palette.accent,
    letterSpacing: 4,
  },
  header: {
    gap: 8,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: Palette.textPrimary,
    lineHeight: 44,
    letterSpacing: 0.2,
  },
  subtitle: {
    fontSize: 16,
    color: Palette.textSecondary,
    letterSpacing: 0.2,
  },
  form: {
    gap: 12,
  },
  input: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.md,
    paddingVertical: 16,
    paddingHorizontal: 20,
    fontSize: 16,
    color: Palette.textPrimary,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  errorText: {
    color: Palette.danger,
    fontSize: 14,
    marginTop: 4,
  },
  button: {
    backgroundColor: Palette.accent,
    borderRadius: Radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
    ...Palette.cardShadow,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: Palette.onAccent,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 2,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Palette.surfaceBorder,
  },
  dividerText: {
    color: Palette.textTertiary,
    fontSize: 14,
    letterSpacing: 1,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: Palette.surface,
    borderRadius: Radius.pill,
    paddingVertical: 15,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
  },
  googleG: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.textSecondary,
    letterSpacing: 0,
  },
  googleText: {
    color: Palette.textSecondary,
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  switchText: {
    color: Palette.textTertiary,
    fontSize: 14,
  },
  switchLink: {
    color: Palette.accent,
    fontSize: 14,
    fontWeight: '600',
  },
});
