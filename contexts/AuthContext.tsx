import { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { flush, forgetAnalyticsUser, setAnalyticsUser, track } from '../lib/analytics';
import { revokeAppleSignIn, usesAppleSignIn } from '../lib/appleAuth';
import { syncIntentions } from '../app/pauseLogger';
import { clearLocalAccountData } from '../lib/localAccountData';
import { acceptTerms as acceptTermsRpc, takeTermsAgreedBeforeSignIn } from '../lib/moderation';
import { clearPushToken } from '../lib/notifications';
import { supabase } from '../lib/supabase';
import { isUsernameAvailable, USERNAME_TAKEN_MESSAGE } from '../lib/username';

type AuthContextType = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  onboardingCompleted: boolean | null;
  /** Har användarvillkoren godkänts (`profiles.terms_accepted_at`)? `null`
   *  = vet inte än. Grinden i app/_layout.tsx (components/terms-gate.tsx)
   *  står över allt så länge det är `false`. */
  termsAccepted: boolean | null;
  acceptTerms: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  signUp: (email: string, password: string, username?: string) => Promise<{ error: string | null; needsConfirmation?: boolean }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** `canceled`: Apples ark stängdes, och ingenting raderades. */
  deleteAccount: () => Promise<{ error: string | null; canceled?: boolean }>;
};

// Buckets där användaren laddat upp under `<user_id>/`. Delete-policyerna
// står i supabase/delete_account.sql.
const ACCOUNT_BUCKETS = ['avatars', 'support-media', 'voice-messages', 'video-messages', 'video-message'];

/** Bästa försök: en fil som inte gick att radera får inte stoppa raderingen. */
async function removeMyFiles(userId: string): Promise<void> {
  await Promise.all(ACCOUNT_BUCKETS.map(async bucket => {
    try {
      const store = supabase.storage.from(bucket);
      while (true) {
        const { data, error } = await store.list(userId, { limit: 1000 });
        if (error || !data || data.length === 0) return;
        const { error: removeError } = await store.remove(data.map(f => `${userId}/${f.name}`));
        if (removeError) return;
      }
    } catch {}
  }));
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [termsAccepted, setTermsAccepted] = useState<boolean | null>(null);

  useEffect(() => {
    const initSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
          console.warn('Session refresh failed:', error.message);
          if (error.message?.includes('Refresh Token') || error.message?.includes('refresh_token')) {
            await supabase.auth.signOut().catch(() => {});
          }
          setSession(null);
          setUser(null);
          return;
        }
        setSession(session);
        setUser(session?.user ?? null);
      } catch (e) {
        console.warn('Auth init error:', e);
        setSession(null);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    initSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setSession(null);
        setUser(null);
        return;
      }
      // Täcker även TOKEN_REFRESHED och USER_UPDATED — ny session sätts som vanligt
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Händelseloggen behöver veta vem raderna tillhör. Det här är den enda
  // platsen som vet det, och den körs också vid utloggning — kön töms då
  // innan id:t nollas, så ingen rad kan följa med över till nästa konto som
  // loggar in på samma telefon. Se lib/analytics.ts.
  useEffect(() => {
    setAnalyticsUser(user?.id ?? null);
  }, [user?.id]);

  // Intentionerna bor i Supabase och cachas i filer på telefonen. Filerna
  // rivs vid utloggning, så de hämtas ner här (app/pauseLogger.ts).
  useEffect(() => {
    if (user?.id) syncIntentions(user.id);
  }, [user?.id]);

  // Har introduktionen körts? Styr grinden i app/_layout.tsx. `null` betyder
  // "vet inte än" och håller kvar startöverlägget, så att ingen hinner se
  // fliklayouten blinka förbi innan introduktionen tar över.
  useEffect(() => {
    if (!user) {
      setOnboardingCompleted(null);
      setTermsAccepted(null);
      return;
    }

    supabase
      .from('profiles')
      .select('onboarding_completed, terms_accepted_at')
      .eq('id', user.id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        // Ett fel är inte ett nej. Utan den här grenen blir `data` null när
        // nätet är nere, `?? false` gör det till "inte klar", och en gammal
        // användare som öppnar appen på tunnelbanan får fylla i sitt namn på
        // nytt. Hellre släppa in någon för tidigt än att be dem göra om
        // introduktionen på grund av dålig täckning — frågan ställs ändå igen
        // nästa gång det går att ställa den.
        //
        // Villkoren följer samma linje: ett fel stänger inte appen, och
        // frågan ställs igen vid nästa start.
        if (error) {
          console.log('[auth] kunde inte läsa onboarding_completed:', error.message);
          setOnboardingCompleted(true);
          setTermsAccepted(true);
          return;
        }
        setOnboardingCompleted(data?.onboarding_completed ?? false);

        if (data?.terms_accepted_at) {
          setTermsAccepted(true);
          return;
        }
        // Godkänt på registreringen: e-postens konto bär det i metadatan
        // (ingen session fanns att skriva med), Google och Apple i minnet.
        const agreedAtSignUp =
          !!user.user_metadata?.terms_accepted_at || takeTermsAgreedBeforeSignIn();
        if (agreedAtSignUp) {
          try {
            await acceptTermsRpc();
            setTermsAccepted(true);
            return;
          } catch (e: any) {
            console.log('[auth] kunde inte spara villkoren:', e?.message);
          }
        }
        setTermsAccepted(false);
      });
  }, [user]);

  // Se till att profilraden finns.
  //
  // Onboardingen var förr den enda som skapade den — den skrev username och
  // avatar efter registreringen. Nu när den är borta måste raden komma till
  // någon annanstans, annars står en nyregistrerad användare som "Unknown"
  // överallt och `profiles`-uppslag ger null. Namnet hämtas ur auth-metadatan
  // där signup lade det.
  //
  // Bara insert: en befintlig rad rörs aldrig, så den som redan valt namn i
  // profilskärmen får det inte överskrivet vid nästa inloggning.
  useEffect(() => {
    if (!user) return;

    const ensureProfile = async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .maybeSingle();
      if (data) return;

      const username =
        (user.user_metadata?.username as string | undefined)?.trim() ||
        user.email?.split('@')[0] ||
        'Unknown';

      const { error } = await supabase
        .from('profiles')
        .insert({ id: user.id, username, show_stats: false });
      if (error) console.log('[auth] kunde inte skapa profilrad:', error.message);
    };

    ensureProfile();
  }, [user]);

  const acceptTerms = async () => {
    await acceptTermsRpc();
    setTermsAccepted(true);
  };

  const signUp = async (email: string, password: string, username?: string) => {
    // Frågan ställs FÖRE kontot skapas, och det är hela poängen.
    //
    // Profilraden skrivs av triggern `on_auth_user_created` i samma
    // transaktion som användaren, så ett upptaget namn hade förr sänkt hela
    // registreringen — och GoTrue rapporterar den sortens fel som sitt
    // generiska "Database error saving new user", en text som varken nämner
    // namnet eller går att göra begriplig i efterhand. Triggern tar numera ett
    // upptaget namn och lägger till en siffra i stället för att fälla kontot
    // (se supabase/usernames.sql), vilket är rätt för ett skyddsnät men fel
    // för någon som just skrivit sitt namn: hen ska få välja om, inte bli
    // "maja2" utan att veta om det.
    //
    // `null` betyder att frågan inte gick att ställa — då fortsätter vi och
    // låter skalet i databasen avgöra.
    //
    // Registreringen frågar inte längre efter ett namn (det väljs i
    // introduktionens namnsteg, som ställer samma fråga), så utan namn
    // hoppas kontrollen över och triggern tar e-postens början.
    if (username && (await isUsernameAvailable(username)) === false) {
      return { error: USERNAME_TAKEN_MESSAGE };
    }

    // Kryssrutan på registreringen är ett krav för att komma hit. Tiden
    // läggs i metadatan, eftersom det ofta inte finns någon session att
    // skriva profilen med förrän e-posten bekräftats; AuthContext flyttar
    // den till `profiles.terms_accepted_at` vid första inloggningen.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { ...(username ? { username } : {}), terms_accepted_at: new Date().toISOString() } },
    });
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('already registered') || msg.includes('already exists')) {
        return { error: 'This email address is already registered.' };
      }
      if (msg.includes('unique') || msg.includes('username')) {
        return { error: USERNAME_TAKEN_MESSAGE };
      }
      return { error: error.message };
    }
    // Om e-postbekräftelse krävs i Supabase-inställningarna skapas inget session direkt
    if (!data.session) {
      // Id:t går med som prop och inte som radens ägare: det finns ingen
      // session än, alltså ingen auth.uid() för RLS att jämföra mot. Raden
      // ligger i kön och skickas när hen bekräftat och loggat in.
      track('signed_up', { needs_confirmation: true, signed_up_user: data.user?.id ?? null });
      return { error: null, needsConfirmation: true };
    }
    track('signed_up', { needs_confirmation: false });
    return { error: null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Namnet säger "försöket" och inte "användaren": vem som misslyckades
      // vet vi inte, och raden får inget user_id — den ligger i kön tills
      // någon faktiskt loggar in på telefonen.
      track('sign_in_failed');
      return { error: error.message };
    }
    track('signed_in');
    return { error: null };
  };

  // Anropas av sista steget i app/intro/ när allt annat skrivits. Håller
  // bara den lokala flaggan i takt med databasen — själva skrivningen sker
  // där, tillsammans med namn och avatar.
  const completeOnboarding = async () => {
    setOnboardingCompleted(true);
  };

  const signOut = async () => {
    // Före skrivningen: effekten ovan nollar användaren i händelsekön så
    // fort `user` blir null, och en rad utan ägare går inte att skicka.
    track('signed_out');

    // Push-token bort HÄR, medan sessionen finns kvar. Efter signOut() finns
    // ingen att skriva med, och en token som ligger kvar på profilraden
    // fortsätter kunna ta emot push långt efter att klienten slutat bry sig —
    // det var precis den kvarlevan som gjorde att databasen måste rivas för
    // hand när notiserna togs bort (supabase/notifications-teardown.sql). En
    // utloggad telefon ska inte få veta att någon i kretsen nådde sitt mål.
    //
    // Inväntas med flit, till skillnad från `track` ovan: utloggningen får
    // vänta de millisekunderna, för efteråt är möjligheten borta.
    if (user?.id) await clearPushToken(user.id);

    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('Sign out error:', e);
    } finally {
      // Före nollningen, så att ingen skärm hinner läsa den gamla profilen
      // åt nästa konto. Se lib/localAccountData.ts.
      await clearLocalAccountData();
      setSession(null);
      setUser(null);
    }
  };

  // Raderar kontot för gott (supabase/delete_account.sql). Profilraden och
  // därmed push-token försvinner med kontot, så clearPushToken behövs inte.
  // När `user` blir null skickar grinden i app/_layout.tsx till inloggningen.
  const deleteAccount = async (): Promise<{ error: string | null; canceled?: boolean }> => {
    const userId = user?.id;
    if (!userId) return { error: 'Not signed in.' };

    // Apple-kopplingen först, medan kontot finns. Går den inte (nätet,
    // hemligheterna) raderas kontot ändå: att radera datan väger tyngre, och
    // händelsen visar hur ofta det händer.
    if (Platform.OS === 'ios' && usesAppleSignIn(user)) {
      const revoked = await revokeAppleSignIn();
      if (revoked === 'canceled') return { error: null, canceled: true };
      if (revoked === 'failed') track('apple_revoke_failed');
    }

    track('account_delete_started');
    // Kön skickas medan kontot finns; raderna blir anonyma när det raderas.
    await flush();
    await removeMyFiles(userId);

    const { error } = await supabase.rpc('delete_my_account');
    if (error) {
      console.warn('Delete account failed:', error.message);
      return { error: error.message };
    }

    forgetAnalyticsUser(userId);
    try {
      // Bara lokalt: sessionen finns inte längre på servern.
      await supabase.auth.signOut({ scope: 'local' });
    } catch {}
    await clearLocalAccountData();
    setSession(null);
    setUser(null);
    return { error: null };
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, onboardingCompleted, termsAccepted, acceptTerms, completeOnboarding, signUp, signIn, signOut, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth måste användas inom AuthProvider');
  return ctx;
}
