import type { User } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// Sign in with Apple, bara på iOS. Apple kräver det (guideline 4.8) när appen
// erbjuder Google-inloggning. Inloggningen är native: Apples ark ger en
// identitetstoken som Supabase byter mot en session — ingen webbläsare och
// ingen omdirigering, till skillnad från googleAuth.ts.
//
// Kräver Apple-leverantören påslagen i Supabase (Authentication → Providers →
// Apple) med appens bundle-id som Client ID.

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Har kontot loggat in med Apple någon gång? */
export function usesAppleSignIn(user: User | null): boolean {
  if (!user) return false;
  const providers = (user.app_metadata?.providers as string[] | undefined) ?? [];
  return providers.includes('apple') || !!user.identities?.some(i => i.provider === 'apple');
}

/**
 * Tar bort kopplingen till Apple-ID:t inför en kontoradering (Apples krav,
 * se supabase/functions/revoke-apple). Apples ark visas en gång till, för
 * det är bara där en färsk engångskod går att få. `canceled` betyder att
 * användaren stängde arket — då raderas ingenting.
 */
export async function revokeAppleSignIn(): Promise<'revoked' | 'canceled' | 'failed'> {
  let code: string | null = null;
  try {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    code = credential.authorizationCode;
  } catch (e) {
    if ((e as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return 'canceled';
    return 'failed';
  }
  if (!code) return 'failed';

  const { error } = await supabase.functions.invoke('revoke-apple', {
    body: { authorization_code: code },
  });
  return error ? 'failed' : 'revoked';
}

export async function signInWithApple(): Promise<{ error: string | null }> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (e) {
    // Avbrutet av användaren — inget felmeddelande behövs
    if ((e as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return { error: null };
    return { error: 'Could not start Apple sign-in.' };
  }

  if (!credential.identityToken) return { error: 'Could not complete Apple sign-in.' };

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
  });
  if (error) return { error: error.message };

  // Apple lämnar namnet bara vid första inloggningen, och aldrig i tokenen.
  // Det sparas i metadatan så att det inte är borta; användarnamnet väljs
  // ändå i introduktionen.
  const name = [credential.fullName?.givenName, credential.fullName?.familyName]
    .filter(Boolean)
    .join(' ');
  if (name) {
    await supabase.auth.updateUser({ data: { full_name: name } }).catch(() => {});
  }
  return { error: null };
}
