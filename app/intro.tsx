import { decode } from 'base64-arraybuffer';
import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StepProfile } from '../components/intro/step-profile';
import { StepSocial } from '../components/intro/step-social';
import { StepWelcome } from '../components/intro/step-welcome';
import { AppPalette } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { clearIntroDeferred, deferIntro } from '../lib/introPrefs';
import { supabase } from '../lib/supabase';
import { isUsernameTakenError, USERNAME_TAKEN_MESSAGE } from '../lib/username';
import { getProfile, saveProfile } from './userProfile';

const { width } = Dimensions.get('window');

/**
 * Måste stämma med `steps`-arrayen längre ner. Den byggs inne i komponenten
 * och kan inte läsas härifrån, men `goTo` behöver en övre gräns innan den
 * finns — ett hopp utanför listan hade tömt scenen utan felmeddelande.
 */
const TOTAL_STEPS = 3;

/**
 * Stegens namn i händelseloggen, i samma ordning som `steps`-arrayen längre
 * ner. Ett index hade varit ett tal som betyder olika saker i olika
 * versioner — `analytics.intro_funnel` grupperar på den här strängen, och
 * flyttar man ett steg ska raden följa med sitt namn och inte sitt nummer.
 */
const STEP_NAMES = ['welcome', 'profile', 'social'] as const;

/**
 * Introduktionen — skalet runt stegen.
 *
 * Den här filen äger tre saker och inget annat: vilket steg som visas, vad
 * användaren har svarat, och skrivningen på slutet. Varje steg är sin egen
 * fil under components/intro/ och vet ingenting om de andra.
 *
 * **Allt sparas i ett svep i sista steget, inte steg för steg.** Ett avbrutet
 * flöde ska inte lämna en halv profil i molnet — och framför allt får
 * `onboarding_completed` inte sättas förrän allt annat gått igenom, för det är
 * den flaggan som avgör om appen någonsin visar introduktionen igen. Sätts
 * den för tidigt och uppladdningen faller, har användaren tappat sin chans att
 * fylla i namnet utan att veta om det.
 *
 * **Tre skärmar: hälsningen, namnet och det sociala.** Tröskeln var
 * rapporterad: åtta skärmar innan den första pausen av en app vars hela löfte
 * är att lägga ifrån sig telefonen. Lådsteget, dagsmålet och kvittot togs
 * bort på begäran — målet sätts på Hem (*Set a daily goal*), och lådan är
 * ändå nedtonad (`POD_COMING_SOON`). I stället kom en interaktiv sida om
 * vänner, stöd och kretsen ([step-social.tsx](../components/intro/step-social.tsx)),
 * som är det sista steget och sparar. Tidigare försvann också tre steg som
 * redan hade en bättre hemvist:
 *
 * - **Tema** frågades här fast [app/onboarding.tsx](./onboarding.tsx)
 *   (Settings) äger väljaren, valet sparas per enhet och gäller redan innan
 *   någon loggat in. Introduktionen bad alltså om ett val som inte var dess.
 * - **Aktiviteter** frågades innan användaren sett vad en paus är i den här
 *   appen. [app/pause.tsx](./pause.tsx) ställer samma fråga i det ögonblick
 *   den betyder något, med hela listan framme — se standardgrenen i
 *   `getSelectedCategories()`, som är vad som gör den raden befolkad utan ett
 *   steg här. Settings äger redigeringen, inklusive egna aktiviteter.
 * - **Stödförfrågningar** visade ett story-kort för någon som ännu inte har
 *   en enda vän att fråga. Fliken Friends har en synlig plusknapp för samma
 *   sak, och den dyker upp när det finns någon att skicka till.
 *
 * Lådsteget (step-box.tsx) ligger kvar som fil men används inte. När lådan
 * går att välja (`POD_COMING_SOON` = false) bör det tillbaka: den som inte
 * vet att lådan finns hittar aldrig dit, och (i v7) tummarnas grind står ingen
 * annanstans innan telefonen ligger i en stängd låda.
 */
export default function IntroScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { user, completeOnboarding } = useAuth();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Introduktionen kan köras om — den som sköt upp den når den från Hem, och
   * hen kan mycket väl ha satt sitt namn i profilskärmen under tiden. Utan
   * den här seedningen möts hen av ett tomt fält, och `finish()` skriver
   * sedan över namnet med sin egen fallback ur user_metadata. Ett kvitto som
   * säger "Add your name" om någon som har ett är dessutom fel kvitto.
   *
   * `'Yourself'` seedas med flit inte: det är vad `getProfile()` svarar när
   * ingen profil skrivits, alltså frånvaron av ett namn och inte ett val.
   * Målet behöver ingen motsvarighet — `applyPendingDailyGoal()` skriver
   * aldrig över ett mål som redan är satt.
   */
  useEffect(() => {
    getProfile().then(p => {
      if (p.name && p.name !== 'Yourself') setName(n => n || p.name);
      if (p.photoUri) setPhoto(ph => ph ?? p.photoUri);
    });
  }, []);

  const slide = useRef(new Animated.Value(0)).current;
  /** Spärr mot dubbeltryck: animationen tar 300 ms och hinner annars dubbla steget. */
  const animating = useRef(false);

  /**
   * Byter steg med en svepning. `target` är antingen ett grannsteg (Next och
   * Back) eller ett godtyckligt index — kvittot hoppar tillbaka till det steg
   * en rad hör till. Riktningen räknas ut ur avståndet, så ett hopp bakåt
   * sveper åt samma håll som en vanlig bakåtknapp.
   */
  const goTo = (target: number) => {
    if (animating.current || target === step) return;
    if (target < 0 || target >= TOTAL_STEPS) return;
    animating.current = true;
    const out = target > step ? -width : width;
    Animated.timing(slide, { toValue: out, duration: 260, useNativeDriver: true }).start(() => {
      setStep(target);
      slide.setValue(-out);
      Animated.timing(slide, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => {
        animating.current = false;
      });
    });
  };

  const next = () => goTo(step + 1);
  const back = () => goTo(step - 1);

  // Ett steg räknas som visat när det faktiskt står på skärmen, inte när
  // Next trycks: kvittot hoppar bakåt med `onEdit`, och ett steg man
  // återvänder till har setts en gång till. Tratten i
  // analytics.intro_funnel räknar därför distinkta användare per steg och
  // inte rader.
  useEffect(() => {
    track('intro_step_shown', { step: STEP_NAMES[step] ?? String(step) });
  }, [step]);

  /**
   * "Set up later".
   *
   * Ingenting sparas: användaren har inte svarat på något. Det enda som
   * skrivs är uppskjutandet, och det måste skrivas *före* navigeringen —
   * grinden i [app/_layout.tsx](./_layout.tsx) läser flaggan vid nästa
   * appstart, och en skrivning som inte hunnit landa hade skickat tillbaka
   * hit.
   *
   * `onboarding_completed` rörs inte. Se `deferIntro` i
   * [lib/introPrefs.ts](../lib/introPrefs.ts) för varför det är hela poängen.
   */
  const skip = async () => {
    // Uppskjuten, inte avklarad — och vilket steg man stod på när man
    // hoppade av är det enda som säger var introduktionen tappar folk.
    track('intro_deferred', { step: STEP_NAMES[step] ?? String(step) });
    await deferIntro();
    router.replace('/(tabs)' as never);
  };

  // ── Skrivningen ───────────────────────────────────────────────────────────
  const finish = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      // Lokalt först: profilen läses av resten av appen härifrån, inte från
      // Supabase. Kategorierna skrivs inte längre här — introduktionen frågar
      // inte om dem, och ett tomt `saveSelectedCategories([])` hade varit
      // värre än inget: det ser ut som ett medvetet tomt val och hade tagit
      // bort standardgrenen i `getSelectedCategories()`.
      await saveProfile(name.trim() || 'Yourself', photo);

      if (!user?.id) {
        // Inget konto (kan hända om sessionen gått ut mitt i) — det lokala är
        // ändå sparat, och grinden i _layout skickar tillbaka till inloggning.
        router.replace('/(tabs)' as never);
        return;
      }

      const username =
        name.trim() ||
        (user.user_metadata?.username ??
          user.user_metadata?.name ??
          user.email?.split('@')[0] ??
          'user');

      let avatarUrl: string | null = null;
      if (photo) {
        if (photo.startsWith('https://')) {
          avatarUrl = photo;
        } else {
          try {
            // Två vägar till samma byte-array. Webben har ingen
            // `expo-file-system`, men där ÄR bilden redan en blob-URL som
            // `fetch` kan hämta — på native finns ingen sådan URL, men väl
            // en fil att läsa. Ingen av vägarna fungerar på andra sidan.
            const body =
              Platform.OS === 'web'
                ? await (await fetch(photo)).blob()
                : decode(
                    await FileSystem.readAsStringAsync(photo, {
                      encoding: FileSystem.EncodingType.Base64,
                    }),
                  );
            const path = `${user.id}/avatar.jpg`;
            const { error: uploadError } = await supabase.storage
              .from('avatars')
              .upload(path, body, { contentType: 'image/jpeg', upsert: true });
            if (!uploadError) {
              const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
              // Cache-brytaren behövs: sökvägen är densamma varje gång, så
              // utan den visar klienten den förra bilden efter ett byte.
              avatarUrl = urlData.publicUrl + '?t=' + Date.now();
            }
          } catch {
            // En bild som inte gick att läsa får inte stoppa hela
            // introduktionen — profilen sparas utan den.
          }
        }
      }

      // Flaggan skrivs i samma svep som namnet, allra sist av allt som kan
      // falla: den avgör om introduktionen någonsin visas igen, och sätts den
      // före uppladdningen har den som tappat nätet mitt i förlorat sin chans
      // att fylla i namnet utan att veta om det.
      const { data, error: updateError } = await supabase
        .from('profiles')
        .update({ username, avatar_url: avatarUrl, onboarding_completed: true })
        .eq('id', user.id)
        .select('id');

      if (updateError) throw updateError;

      // AuthContext skapar profilraden vid inloggning, men den körningen är
      // asynkron och kan ha fallit eller ännu inte vara klar. Saknas raden
      // skapas den här, annars försvinner namnet tyst.
      if (!data || data.length === 0) {
        const { error: insertError } = await supabase.from('profiles').insert({
          id: user.id,
          username,
          avatar_url: avatarUrl,
          onboarding_completed: true,
          show_stats: false,
        });
        if (insertError) throw insertError;
      }

      // Och samma flagga i minnet. Utan den står AuthContext kvar på `false`
      // tills appen startas om, och grinden i _layout kan skicka tillbaka hit
      // så fort den utvärderas på nytt.
      await completeOnboarding();
      // Uppskjutandet har tjänat ut: introduktionen är körd. Rivs den inte
      // ligger en död nyckel kvar och säger emot serverflaggan, och puffen på
      // Hem skulle fortsätta be om något som redan är gjort.
      await clearIntroDeferred();
      track('intro_completed', { has_avatar: !!avatarUrl });
      router.replace('/(tabs)' as never);
    } catch (e: any) {
      // Ett upptaget namn är inte ett haveri utan ett val som behöver göras
      // om, och `duplicate key value violates unique constraint
      // "profiles_username_lower_key"` är inte något att lägga framför någon
      // som just skrivit sitt förnamn. Raden ovanför säger vilket steg som
      // behöver ändras, eftersom kvittot är sista skärmen och namnet står
      // längre bak.
      // Skiljer på de två: ett upptaget namn är ett val som ska göras om,
      // allt annat är ett haveri. Blandas de ihop ser en trasig uppladdning
      // ut som en namnkrock i vyerna.
      track('intro_save_failed', { reason: isUsernameTakenError(e) ? 'username_taken' : 'other' });
      if (isUsernameTakenError(e)) {
        setError(`${USERNAME_TAKEN_MESSAGE} Go back to pick another.`);
      } else {
        setError(e?.message ? `Could not save: ${e.message}` : 'Could not save. Check your connection and try again.');
      }
      setSaving(false);
    }
  };

  // Ordningen måste stämma med STEP_NAMES och TOTAL_STEPS ovan.
  const steps = [
    <StepWelcome key="welcome" onNext={next} />,
    <StepProfile
      key="profile"
      name={name}
      setName={setName}
      photo={photo}
      setPhoto={setPhoto}
      onNext={next}
      onBack={back}
    />,
    <StepSocial key="social" saving={saving} error={error} onFinish={finish} onBack={back} />,
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <View style={styles.dots}>
        {steps.map((_, i) => (
          <View key={i} style={[styles.dot, i <= step && styles.dotOn]} />
        ))}
        {/* Uppe till höger, och bara på första sidan: en dörr man väljer
            innan man gått in, inte en nödutgång på varje steg. Absolut
            placerad så att prickarna står kvar i mitten. */}
        {step === 0 && (
          <TouchableOpacity onPress={skip} style={styles.skip} hitSlop={8} accessibilityRole="button">
            <Text style={styles.skipText}>Set up later</Text>
          </TouchableOpacity>
        )}
      </View>

      <Animated.View style={[styles.stage, { transform: [{ translateX: slide }] }]}>
        {steps[step]}
      </Animated.View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Palette.bg,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 16,
  },
  skip: {
    position: 'absolute',
    right: 20,
    paddingVertical: 8,
  },
  skipText: {
    fontSize: 14,
    color: Palette.textTertiary,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: Palette.ink12,
  },
  dotOn: {
    width: 20,
    backgroundColor: Palette.accent,
  },
  stage: {
    flex: 1,
    width: '100%',
  },
});
