import { FontAwesome, MaterialIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { HoldToStartButton } from '../components/hold-to-start-button';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { HOLD_TO_START_MS } from '../lib/pauseFlow';
import { Category, getSelectedCategories } from './pauseLogger';

/**
 * Bara det lådlösa läget går att välja, och **det är inte längre ett
 * tillfälligt tillstånd bakom en konstant**. Sedan firmware v8.5 startar
 * appen aldrig en lådpaus: lådan äger sin paus hela vägen (taggen, locket,
 * uppladdningen över WiFi) och behöver ingen app alls. Grenen som skickade
 * `set_mode` och routade till `/placeinbox` är därför borta, inte parkerad —
 * det fanns en `POD_COMING_SOON` som lovade att allt kom tillbaka i exakt
 * samma skick, och det löftet går inte att hålla när flödet inte finns.
 * Vill man ha ett lådflöde i appen är det en ny funktion, och frågan att
 * svara på först är varför appen ska lägga sig i en paus lådan klarar själv.
 *
 * WITH PAUSEPOD-knappen står kvar, otryckbar och med COMING SOON. Att lådan
 * finns är en del av vad appen är, och en knapp som säger varför berättar
 * det, medan en borttagen knapp bara gör valskärmen till ett val mellan en
 * sak. Vägen till lådan går via *How it works ›* i Settings
 * ([app/pod.tsx](pod.tsx)).
 *
 * Det som återstår att bygga när lådorna är ute är en annan skärm än den
 * här: *CLOSE THE POD TO START*, driven av `ready_to_close` över Bluetooth
 * (se lib/bleProtocol.ts) — en upplysning om att pausen inte börjat än, inte
 * ett flöde appen styr.
 */
type PauseMode = 'utan-låda' | null;

/**
 * CHECK IN måste hållas in i `HOLD_TO_START_MS` innan pausen startar. Ett
 * startat tryck är det enda i appen som sätter igång något man inte ångrar
 * med ett tryck till, och ett avsiktligt håll skiljer det från ett snuddat.
 * `false` ger tillbaka det vanliga trycket — båda vägarna anropar samma
 * `handleCheckIn`, och ingenting i den rörs av valet. Se
 * components/hold-to-start-button.tsx.
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
  // "Utan låda" är inte ett val längre utan det enda läget, så det är valt
  // från början: CHECK IN står annars död tills man tryckt på det som ändå
  // var givet. Ett tryck på knappen avmarkerar fortfarande, och det är med
  // flit — den som öppnat valskärmen och ändrat sig ska kunna backa ur utan
  // att gå tillbaka, och CHECK IN säger då att inget läge är valt.
  const [selectedMode, setSelectedMode] = useState<PauseMode>('utan-låda');
  const [showHelpModal, setShowHelpModal] = useState(false);

  // Tom lista betyder "medvetet tömd i Settings" och inte "aldrig vald" —
  // standardgrenen sitter i getSelectedCategories() och ger hela
  // uppsättningen till den som aldrig rört saken. Se CLAUDE.md.
  useEffect(() => {
    getSelectedCategories().then(setCategories);
  }, []);

  const canCheckIn = selectedMode !== null;

  const handleCheckIn = () => {
    if (!canCheckIn) return;

    // Trattens ingång: i pause_sessions syns bara de försök som faktiskt
    // blev en paus. Fältet `with_pod` är borta — appens paus är alltid
    // telefonens egen, och lådans pauser passerar aldrig den här skärmen.
    track('pause_mode_selected', {
      category: selectedCategory ?? null,
      shared: !!(sharedSessionId && sharedWithName),
    });

    const base = {
      mode: 'session',
      category: selectedCategory ?? '',
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
          {/* Lådans knapp är ren upplysning: den går inte att välja, och
              anslutningsraden ("Ready"/"Connect") är borta med lådflödet —
              "Connect" hade varit en uppmaning att göra något som inte leder
              någonstans. Den säger skälet i stället för att stå tom: en
              nedtonad knapp utan förklaring läser som trasig. */}
          <View
            style={[styles.modeButton, styles.modeButtonSoon]}
            accessible
            accessibilityLabel="With PausePod, coming soon"
          >
            <MaterialIcons name="pause-presentation" size={38} color={Palette.textDisabled} />
            <Text style={[styles.modeTitle, styles.modeTitleSoon]}>WITH PAUSEPOD</Text>
            <View style={styles.bleRow}>
              <Text style={styles.soonText}>COMING SOON</Text>
            </View>
          </View>

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
