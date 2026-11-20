import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { isAppleSignInAvailable } from '../lib/appleAuth';

/**
 * Apples egen knapp, inte en egen ritad: Apple granskar hur Sign in with
 * Apple ser ut, och den inbyggda följer deras riktlinjer av sig själv. Vit
 * i mörkt läge, svart i ljust. Renderas inte alls utanför iOS.
 */
export function AppleSignInButton({ onPress, disabled, type = 'continue' }: {
  onPress: () => void;
  disabled?: boolean;
  type?: 'continue' | 'signUp';
}) {
  const { mode } = useTheme();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    isAppleSignInAvailable().then(setAvailable);
  }, []);

  if (!available) return null;

  return (
    <View style={disabled && styles.disabled} pointerEvents={disabled ? 'none' : 'auto'}>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={type === 'signUp'
          ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
          : AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={mode === 'dark'
          ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
          : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={25}
        style={styles.button}
        onPress={onPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Samma höjd som Google-knappen bredvid.
  button: { height: 50, width: '100%' },
  disabled: { opacity: 0.6 },
});
