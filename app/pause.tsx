import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useBLE, useBLEControl } from '../context/BLEContext';
import { HoldToStartButton } from '../components/hold-to-start-button';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { HOLD_TO_START_MS } from '../lib/pauseFlow';
import { Category, getSelectedCategories } from './pauseLogger';

type PauseMode = 'med-låda' | 'utan-låda' | null;

/**
 * Lådan är inte ute ännu, så dess läge går inte att välja.
 *
 * **Allt bakom knappen står kvar orört** — `sendSetMode`, BLE-kollen,
 * routningen till `/placeinbox`, hela `med-låda`-grenen i `handleCheckIn`.
 * Det enda som ändras är att knappen inte går att trycka på och att den säger
 * varför. Sätt den här till `false` och lådläget är tillbaka i exakt samma
 * skick som förut; det är hela avsikten med att det är en konstant och inte
 * en bortkommenterad gren.
 *
 * Knappen döljs alltså inte heller. Att lådan finns är en del av vad appen
 * är — introduktionens lådsteg står kvar av samma skäl — och en knapp som
 * säger COMING SOON berättar det, medan en borttagen knapp bara gör
 * valskärmen till ett val mellan en sak.
 */
const POD_COMING_SOON = true;

/**
 * CHECK IN måste hållas in i `HOLD_TO_START_MS` innan pausen startar. Ett
 * startat tryck är det enda i appen som sätter igång något man inte ångrar
 * med ett tryck till, och ett avsiktligt håll skiljer det från ett snuddat.
 * `false` ger tillbaka det vanliga trycket — båda vägarna anropar samma
 * `handleCheckIn`, och ingenting i den (BLE, `set_mode`, routningen) rörs av
 * valet. Se components/hold-to-start-button.tsx.
 */
const HOLD_TO_START = true;
// Hålltiden bor i lib/pauseFlow.ts, delad med PAUSE på Hem.

/**
 * Valskärmen hör till **Pause-rummet**, trots att den ligger utanför
 * `app/(tabs)/`.
 *
 * Den nås av PAUSE-knappen på Hem och är samma handling fortsatt ett steg, så
 * den ska se ut som skärmen man kom från — utan rummet låg den på basens
 * plommonbotten och bytte kulör mitt i ett tryck. Rummet är alltså inte bundet
 * till flikgruppen utan till *vad skärmen handlar om*; ligger nästa skärm i en
 * annan flikfamilj men samma ärende hör den hit också.
 *
 * Skalet är identiskt med `HomeRoom` i [app/(tabs)/index.tsx](app/(tabs)/index.tsx),
 * av samma två skäl: en komponent kan inte läsa sin egen provider, och en
 * bakgrund i skalet täcker varje gren skärmen kan returnera.
 */
export default function PauseRoom() {
  return (
    <RoomProvider room="pause">
      <View style={roomShell}>
        <ScreenBackground room="pause" />
        <PauseScreen />
      </View>
    </RoomProvider>
  );
}

function PauseScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { sharedSessionId, sharedWithName } = useLocalSearchParams<{
    sharedSessionId?: string;
    sharedWithName?: string;
  }>();

  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // Med lådan utom räckhåll är "utan låda" inte ett val längre utan det enda
  // läget, och då ska skärmen inte kräva ett tryck för att komma igång: CHECK IN
  // står annars död tills man valt det som ändå var givet.
  //
  // Förvalet hänger därför på POD_COMING_SOON och är inte skrivet rakt ut. Släcks
  // konstanten är båda lägena valbara igen, och då måste skärmen vara neutral — ett
  // förval på det ena hade gjort valet till en knuff, och konstantens löfte om att
  // allt är tillbaka i exakt samma skick hade brutits här utan att något felar.
  const [selectedMode, setSelectedMode] = useState<PauseMode>(POD_COMING_SOON ? 'utan-låda' : null);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const { isConnected } = useBLEControl();
  const { sendSetMode } = useBLE();

  // Tom lista betyder "medvetet tömd i Settings" och inte "aldrig vald" —
  // standardgrenen sitter i getSelectedCategories() och ger hela
  // uppsättningen till den som aldrig rört saken. Se CLAUDE.md.
  useEffect(() => {
    getSelectedCategories().then(setCategories);
  }, []);

  const canCheckIn = selectedMode !== null;

  const handleCheckIn = () => {
    if (!canCheckIn) return;

    if (selectedMode === 'med-låda' && !isConnected) {
      // Trattens första bortfall, och det enda som inte lämnar något spår
      // alls i pause_sessions: hen ville pausa med lådan och kom aldrig
      // längre än till varningen.
      track('pause_blocked_box_offline', { category: selectedCategory ?? null });
      Alert.alert(
        'PAUSEPOD not connected',
        'Check that Bluetooth is turned on on your phone and that the box is within range.',
        [{ text: 'OK' }]
      );
      return;
    }

    // Trattens ingång. `with_pod` är hela skälet att händelsen finns: de två
    // flödena faller ifrån på helt olika ställen, och i pause_sessions syns
    // bara de försök som faktiskt blev en paus.
    track('pause_mode_selected', {
      with_pod: selectedMode === 'med-låda',
      category: selectedCategory ?? null,
      shared: !!(sharedSessionId && sharedWithName),
    });

    if (selectedMode === 'med-låda') {
      // Ingen vald längd med låda ännu — UP:0 tills en längdväljare finns.
      // Lådan parsar inte innehållet idag, men formatet ligger på plats.
      sendSetMode('session', 'UP', 0).catch(() => {});

      const base = {
        mode: 'session',
        category: selectedCategory ?? '',
        withPod: 'true',
        pauseType: 'session',
        targetSeconds: '0',
      };
      if (sharedSessionId && sharedWithName) {
        router.push({ pathname: '/pausing', params: { ...base, sharedSessionId, sharedWithName } });
      } else {
        router.push({ pathname: '/placeinbox', params: base });
      }
      return;
    }

    const base = {
      mode: 'session',
      category: selectedCategory ?? '',
      withPod: 'false',
      pauseType: 'session',
      targetSeconds: '0',
    };

    if (sharedSessionId && sharedWithName) {
      router.push({ pathname: '/pausing', params: { ...base, sharedSessionId, sharedWithName } });
    } else {
      router.push({ pathname: '/pausing', params: base });
    }
  };

  return (
    <View style={styles.container}>
      <FontAwesome name="pause" size={40} color={Palette.hue} />
      <Text style={styles.title}>Start pause</Text>

      {/* ── CHOOSE MODE ──────────────────────────── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>CHOOSE MODE</Text>
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[
              styles.modeButton,
              selectedMode === 'med-låda' && styles.modeButtonSelected,
              POD_COMING_SOON && styles.modeButtonSoon,
            ]}
            disabled={POD_COMING_SOON}
            accessibilityState={{ disabled: POD_COMING_SOON }}
            onPress={() => setSelectedMode(selectedMode === 'med-låda' ? null : 'med-låda')}
          >
            <MaterialIcons
              name="pause-presentation"
              size={38}
              color={
                POD_COMING_SOON
                  ? Palette.textDisabled
                  : selectedMode === 'med-låda' ? Palette.hue : Palette.textFaint
              }
            />
            <Text
              style={[
                styles.modeTitle,
                selectedMode === 'med-låda' && styles.modeTitleSelected,
                POD_COMING_SOON && styles.modeTitleSoon,
              ]}
            >
              WITH PAUSEPOD
            </Text>
            {/* Anslutningsraden säger ingenting medan läget inte går att
                välja — "Connect" hade varit en uppmaning att göra något som
                inte leder någonstans. Den byts mot skälet, inte mot tomrum:
                en nedtonad knapp utan förklaring läser som trasig. */}
            {POD_COMING_SOON ? (
              <View style={styles.bleRow}>
                <Text style={styles.soonText}>COMING SOON</Text>
              </View>
            ) : (
              <View style={[styles.bleRow, { opacity: selectedMode === 'med-låda' ? 1 : 0.3 }]}>
                <View style={[styles.bleDot, { backgroundColor: isConnected ? Palette.success : Palette.textPrimary }]} />
                <Text style={styles.bleSmallText}>{isConnected ? 'Ready' : 'Connect'}</Text>
              </View>
            )}
            {selectedMode === 'med-låda' && !POD_COMING_SOON && (
              <View style={styles.checkDot}>
                <FontAwesome name="check" size={10} color={Palette.onAccent} />
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.modeButton, selectedMode === 'utan-låda' && styles.modeButtonSelected]}
            onPress={() => setSelectedMode(selectedMode === 'utan-låda' ? null : 'utan-låda')}
          >
            <MaterialIcons
              name="cancel-presentation"
              size={38}
              color={selectedMode === 'utan-låda' ? Palette.hue : Palette.textFaint}
            />
            <Text style={[styles.modeTitle, selectedMode === 'utan-låda' && styles.modeTitleSelected]}>
              WITHOUT PAUSEPOD
            </Text>
            <View style={[styles.bleRow, { opacity: selectedMode === 'utan-låda' ? 1 : 0.3 }]}>
              <Text style={styles.bleSmallText}>Anywhere</Text>
            </View>
            {selectedMode === 'utan-låda' && (
              <View style={styles.checkDot}>
                <FontAwesome name="check" size={10} color={Palette.onAccent} />
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* ── KATEGORI ───────────────────────────── */}
      <View style={styles.section}>
        {/* Knappen var ett plus som öppnade en lista att lägga till ur, och
            den slutade fungera den dagen introduktionens kategoristeg revs:
            den som aldrig valt får numera hela uppsättningen framme, och
            plusets lista stod då tom med "All intentions have already been
            added." Tillägget sparades dessutom aldrig — nästa paus började om
            från samma rad.

            Frågetecknet säger i stället var valet faktiskt bor. Priset är att
            den som smalnat av sin lista i Settings inte längre kan plocka in
            en aktivitet bara för idag; vägen dit går via Settings och håller i
            stället. */}
        <View style={styles.sectionLabelRow}>
          <Text style={styles.sectionLabel}>WHAT WILL YOU DO? (OPTIONAL)</Text>
          <TouchableOpacity
            style={styles.addIntentionBtn}
            onPress={() => setShowHelpModal(true)}
            accessibilityLabel="About your intentions"
          >
            <MaterialIcons name="question-mark" size={14} color={Palette.textFaint} />
          </TouchableOpacity>
        </View>
        {categories.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categoryScroll}
          >
            {categories.map(cat => (
              <TouchableOpacity
                key={cat.id}
                style={[styles.categoryChip, selectedCategory === cat.id && styles.categoryChipSelected]}
                onPress={() => setSelectedCategory(selectedCategory === cat.id ? null : cat.id)}
              >
                <Text style={styles.categoryEmoji}>{cat.emoji}</Text>
                <Text style={[styles.categoryText, selectedCategory === cat.id && styles.categoryTextSelected]}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* ── Modal ──────────────────────────────── */}
      <Modal transparent animationType="fade" visible={showHelpModal} onRequestClose={() => setShowHelpModal(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowHelpModal(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.addModalBox}>
            <Text style={styles.addModalTitle}>YOUR INTENTIONS</Text>
            <Text style={styles.helpBody}>
              Tag a pause with what you&apos;re doing, and it&apos;s shown in your stats. Customize them in Settings.
            </Text>
            <TouchableOpacity
              style={styles.helpBtn}
              onPress={() => {
                setShowHelpModal(false);
                // Settings bor i app/onboarding.tsx trots filnamnet — se
                // CLAUDE.md. push och inte replace: pausvalet ovanför ska
                // stå kvar när man backar tillbaka hit.
                router.push('/onboarding');
              }}
            >
              <Text style={styles.helpBtnText}>GO TO SETTINGS</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* ── Checka in ──────────────────────────── */}
      {/* Samma `handleCheckIn` i båda grenarna — det är bara gesten som
          skiljer. `HOLD_TO_START` högst upp växlar tillbaka till ett vanligt
          tryck. */}
      {HOLD_TO_START ? (
        <HoldToStartButton
          style={[styles.checkInButton, !canCheckIn && styles.checkInButtonDisabled]}
          onComplete={handleCheckIn}
          holdMs={HOLD_TO_START_MS}
          disabled={!canCheckIn}
          borderRadius={Radius.pill}
          accessibilityLabel="Check in"
          hintStyle={styles.holdHint}
        >
          <FontAwesome name="check" size={18} color={Palette.onAccent} style={{ marginRight: 10 }} />
          <Text style={styles.checkInText}>CHECK IN</Text>
        </HoldToStartButton>
      ) : (
        <TouchableOpacity
          style={[styles.checkInButton, !canCheckIn && styles.checkInButtonDisabled]}
          onPress={handleCheckIn}
          disabled={!canCheckIn}
        >
          <FontAwesome name="check" size={18} color={Palette.onAccent} style={{ marginRight: 10 }} />
          <Text style={styles.checkInText}>CHECK IN</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.noButton} onPress={() => router.back()}>
        <Text style={styles.noText}>Not now</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flex: 1,
    // Botten ritas av <ScreenBackground> i skalet ovan. Stod färgen kvar här
    // hade den lagt sig ovanpå de fyra lagren.
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    padding: Spacing.xl,
    marginTop: -15,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: Palette.textPrimary,
    marginTop: -15,
  },
  section: { width: '100%' },
  sectionLabel: { ...Palette.eyebrow, marginBottom: Spacing.md },

  // ── Mode buttons ──────────────────────────
  modeRow: { flexDirection: 'row', gap: Spacing.md },
  modeButton: {
    flex: 1,
    backgroundColor: Palette.surface,
    borderWidth: 2,
    borderColor: Palette.surfaceBorder,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    position: 'relative',
    gap: 6,
  },
  modeButtonSelected: {
    borderColor: Palette.hue,
    backgroundColor: Palette.hueTint,
    // Ingen cardShadow här, och det är själva fixen: skuggan låg bakom en yta
    // som bara är 10 % täckande och syntes därför rakt igenom knappens eget fyll.
    // I ljust läge blev det en grå ruta bakom texten i stället för en skugga under
    // kortet (Android ritar dessutom elevation som en fylld rektangel när
    // bakgrunden inte är opak); i mörkt läge doldes samma sak av att skuggan är
    // en blå glöd mot en mörk botten. Valet syns ändå på fem andra sätt — ramen,
    // fyllet, ikonen, titeln och bocken. Ska en skugga tillbaka måste fyllet
    // först bli opakt.
  },
  modeTitle: {
    color: Palette.textSecondary,
    fontSize: 12,
    fontWeight: 'bold',
    letterSpacing: 1,
    textAlign: 'center',
  },
  modeTitleSelected: { color: Palette.hue },
  // Nedtonat, inte osynligt: knappen ska gå att läsa, bara inte att välja.
  modeButtonSoon: { opacity: 0.55 },
  modeTitleSoon: { color: Palette.textDisabled },
  soonText: {
    color: Palette.textDisabled,
    fontSize: 11,
    fontWeight: 'bold',
    letterSpacing: 1.5,
  },
  checkDot: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: Radius.pill,
    backgroundColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  bleDot: { width: 7, height: 7, borderRadius: 4 },
  bleSmallText: {
    color: Palette.textSecondary,
    fontSize: 12,
    letterSpacing: 0.3,
    fontStyle: 'italic',
  },

  // ── Category ──────────────────────────────
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  addIntentionBtn: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: Palette.surfaceBorder,
    backgroundColor: Palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryScroll: { paddingHorizontal: 2, gap: Spacing.sm, flexDirection: 'row' },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.surface,
    borderWidth: 1.5,
    borderColor: Palette.surfaceBorder,
    borderRadius: Radius.pill,
    paddingVertical: 10,
    paddingHorizontal: Spacing.lg,
  },
  categoryChipSelected: { borderColor: Palette.hue, backgroundColor: Palette.hueTint },
  categoryEmoji: { fontSize: 16 },
  categoryText: { color: Palette.textSecondary, fontSize: 13, fontWeight: 'bold', letterSpacing: 1.5 },
  categoryTextSelected: { color: Palette.textPrimary },

  // ── Modal ─────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: Palette.scrimStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addModalBox: {
    backgroundColor: Palette.modalSurface,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    width: '88%',
    maxHeight: '75%',
    borderWidth: 1,
    borderColor: Palette.modalBorder,
  },
  addModalTitle: { ...Palette.eyebrow, marginBottom: Spacing.lg, textAlign: 'center' },
  helpBody: {
    color: Palette.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  helpBtn: {
    marginTop: Spacing.xl,
    backgroundColor: Palette.accent,
    paddingVertical: 14,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  helpBtnText: { color: Palette.onAccent, fontSize: 14, fontWeight: 'bold', letterSpacing: 2 },

  // ── CTA ───────────────────────────────────
  checkInButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Palette.accent,
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: Radius.pill,
    width: '100%',
    ...Palette.cardShadow,
  },
  checkInButtonDisabled: { backgroundColor: Palette.surface, shadowOpacity: 0, elevation: 0 },
  checkInText: { color: Palette.onAccent, fontSize: 18, fontWeight: 'bold', letterSpacing: 3 },
  // *Keep holding* under CHECK IN efter ett för kort tryck. Raden svävar
  // under knappen (komponenten placerar den) och tar ingen plats; 4 + 18
  // slutar ovanför texten i *Not now*, som börjar 16 + 10 under knappen.
  holdHint: { fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  noButton: { paddingVertical: 10, paddingHorizontal: 32 },
  noText: { color: Palette.textTertiary, fontSize: 15 },
});
