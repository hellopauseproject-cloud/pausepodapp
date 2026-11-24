import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Den riktiga databasen är förval. EXPO_PUBLIC_SUPABASE_URL och
// EXPO_PUBLIC_SUPABASE_ANON_KEY i en .env.local pekar om appen till ett
// annat projekt (och Expo startas om).
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://iwyumzgewiwvcbuqzjnk.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_cqX_cT1CBZ8oqOnNd1alfA_JZQDUqOQ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
