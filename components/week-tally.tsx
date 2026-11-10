import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming,
} from 'react-native-reanimated';

import { alpha, AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { getWeekTally, TallyRow } from '../lib/weekTally';
import { intentionTone } from './pause-tag-chips';
import { TallyRod } from './tally-rod';

/**
 * Veckans taggar i Hems nedre vänstra hörn, där att göra-lappen satt.
 *
 * **Exklusivt genom återhållsamhet och en avslöjning** (november 2026, på
 * begäran — en version med en emoji och en kulör per intention såg rörig ut
 * i hörnet). Hörnet är lugnt: *THIS WEEK* i designsystemets glesa versaler
 * och under det en enda rad korta **platta, rundade streck**
 * (components/tally-rod.tsx) i rummets kulör, ett per taggad paus sedan
 * måndag, alla med samma lucka (en större lucka mellan intentionerna
 * prövades och föll på begäran: strecken lästes två och två). Inga emojier
 * och inga kulörer — hörnet antyder. (Strecken var först glas i
 * PAUSE-knappens material; det föll på begäran.)
 *
 * **Kulören bor inuti.** Ett tryck öppnar arket, där veckan står ordentligt:
 * varje intention med emoji, namn och sina streck i sin egen ton. Ingen
 * förklarande text. Därifrån leder en rad till statistikens pauser, där
 * taggar sätts och byts.
 *
 * **De otaggade står sist, i ljusgrått** (lib/weekTally.ts), i hörnet och i
 * arket — streck, text och en tom rund ruta utan emoji, så att de inte tar
 * blicken.
 * Taggas en växer ett fullt streck fram och ett tonat försvinner.
 *
 * Ett nytt streck växer upp ur raden med en haptik — när räkningen stigit
 * sedan hörnet senast visades: när taggkortet
 * stängts, när en paus med intention landat, eller efter en tagg i
 * statistiken. Ingen målsiffra och inget tak (lib/weekTally.ts); på måndag är
 * raden tom igen, och då syns inte hörnet alls.
 *
 * Hörnet ligger under PAUSE-knappens golv (56). Rapporterar det ändå en högre
 * höjd (`onHeight`) lyfter Hem blocket med det som sticker upp.
 */

const ROD_W = 5;
const ROD_H = 18;
const ROD_GAP = 4;
// Fler streck än så blir `+N`, så att raden inte växer in under PAUSE.
const MAX_RODS = 14;
/** Hörnets avstånd från skärmens nederkant (flikraden). */
export const WEEK_TALLY_BOTTOM = 10;
const GROW_MS = 620;
// Ett streck i taget när flera pauser taggats sedan sist.
const STAGGER_MS = 200;
const EASE = Easing.out(Easing.cubic);

function Rod({ color, grow, delay, onLanded }: {
  color: string;
  /** Satt: strecket växer fram i stället för att stå klart. */
  grow: boolean;
  delay: number;
  onLanded?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const k = useSharedValue(grow && !reduceMotion ? 0 : 1);

  useEffect(() => {
    if (!grow) return;
    if (reduceMotion) { onLanded?.(); return; }
    k.value = withDelay(delay, withTiming(1, { duration: GROW_MS, easing: EASE }, done => {
      if (done && onLanded) runOnJS(onLanded)();
    }));
    // onLanded byts vid varje rendering och ska inte starta om rörelsen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grow, delay, reduceMotion, k]);

  // Växer upp ur radens botten.
  const growStyle = useAnimatedStyle(() => ({
    opacity: k.value < 0.02 ? 0 : 1,
    transform: [{ translateY: (1 - k.value) * ROD_H / 2 }, { scaleY: Math.max(0.001, k.value) }],
  }));

  return (
    <Animated.View style={growStyle}>
      <TallyRod width={ROD_W} height={ROD_H} color={color} />
    </Animated.View>
  );
}

type Fresh = Record<string, { from: number; key: number }>;

export function WeekTally({ userId, refreshKey, onHeight }: {
  userId: string;
  /** Byts det här hämtas räkningen om — Hem byter det när en paus taggats. */
  refreshKey: number;
  /** Hörnets uppmätta höjd (0 när det är tomt). */
  onHeight?: (h: number) => void;
}) {
  const Palette = usePalette();
  const sheet = useMemo(() => makeSheetStyles(Palette), [Palette]);
  const [rows, setRows] = useState<TallyRow[] | null>(null);
  const [fresh, setFresh] = useState<Fresh>({});
  const [open, setOpen] = useState(false);
  // Räkningen som senast visades, per intention. Null före första hämtningen:
  // då står strecken klara utan rörelse.
  const seenRef = useRef<Record<string, number> | null>(null);
  const freshKey = useRef(0);

  const load = useCallback(async () => {
    const next = await getWeekTally(userId);
    const seen = seenRef.current;
    const anim: Fresh = {};
    if (seen) {
      for (const r of next) {
        const prev = seen[r.category.id] ?? 0;
        if (r.count > prev) anim[r.category.id] = { from: prev, key: ++freshKey.current };
      }
    }
    seenRef.current = Object.fromEntries(next.map(r => [r.category.id, r.count]));
    setFresh(anim);
    setRows(next);
  }, [userId]);

  useFocusEffect(useCallback(() => { load().catch(() => {}); }, [load]));
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    load().catch(() => {});
  }, [refreshKey, load]);

  const empty = !rows || rows.length === 0;
  useEffect(() => { if (empty) onHeight?.(0); }, [empty, onHeight]);
  if (empty) return null;

  // Strecken i hörnet, i intentionernas ordning, högst `MAX_RODS`.
  let left = MAX_RODS;
  const groups = rows.map(r => {
    const shown = Math.max(0, Math.min(r.count, left));
    left -= shown;
    return { row: r, shown };
  }).filter(g => g.shown > 0);
  const total = rows.reduce((n, r) => n + r.count, 0);
  const hidden = total - groups.reduce((n, g) => n + g.shown, 0);
  // Haptiken landar med det sista nya strecket som syns.
  let lastNew: string | null = null;
  for (const g of groups) {
    const f = fresh[g.row.category.id];
    // Bara en taggad paus är värd en haptik; ett nytt otaggat streck växer tyst.
    if (f && g.shown > f.from && !g.row.untagged) lastNew = `${g.row.category.id}-${g.shown - 1}`;
  }
  let order = 0;

  const a11y = `This week: ${rows.map(r => `${r.category.label.toLowerCase()} ${r.count} ${r.count === 1 ? 'time' : 'times'}`).join(', ')}. Opens your week.`;

  return (
    <>
      <TouchableOpacity
        style={styles.corner}
        onPress={() => setOpen(true)}
        onLayout={e => onHeight?.(Math.round(e.nativeEvent.layout.height))}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={a11y}
      >
        <Text style={[styles.kicker, { color: Palette.textTertiary }]}>THIS WEEK</Text>
        <View style={styles.rods}>
          {groups.map(g => {
            const f = fresh[g.row.category.id];
            return (
              <View key={g.row.category.id} style={styles.group}>
                {Array.from({ length: g.shown }, (_, i) => {
                  const isNew = !!f && i >= f.from;
                  const id = `${g.row.category.id}-${i}`;
                  const delay = isNew ? order++ * STAGGER_MS : 0;
                  return (
                    <Rod
                      key={isNew ? `${id}-${f!.key}` : id}
                      // De otaggade står tonade: de finns, men väntar på en tagg.
                      color={g.row.untagged ? Palette.ink20 : Palette.hue}
                      grow={isNew}
                      delay={delay}
                      onLanded={id === lastNew
                        ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); }
                        : undefined}
                    />
                  );
                })}
              </View>
            );
          })}
          {hidden > 0 && <Text style={[styles.more, { color: Palette.textTertiary }]}>+{hidden}</Text>}
        </View>
      </TouchableOpacity>

      {/* Arket: veckan med namn och kulör. */}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={sheet.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={sheet.card}>
            <Text style={sheet.kicker}>THIS WEEK</Text>
            <View style={sheet.list}>
              {rows.map(r => {
                // De otaggade i ljusgrått, utan emoji: raden finns men ska
                // inte ta blicken från de taggade.
                const tone = r.untagged ? Palette.ink40 : intentionTone(Palette, r.category.id);
                const rodColor = r.untagged ? Palette.ink20 : tone;
                const countStyle = [sheet.count, r.untagged && { color: Palette.ink40 }];
                return (
                  <View key={r.category.id} style={sheet.row}>
                    <View style={[
                      sheet.disc,
                      { backgroundColor: r.untagged ? Palette.ink08 : alpha(tone, Palette.mode === 'dark' ? 0.18 : 0.14) },
                    ]}>
                      {!r.untagged && <Text style={sheet.emoji}>{r.category.emoji}</Text>}
                    </View>
                    <View style={sheet.rowBody}>
                      <View style={sheet.rowHead}>
                        <Text style={[sheet.label, { color: tone }]} numberOfLines={1}>{r.category.label}</Text>
                        <Text style={countStyle}>{r.count}×</Text>
                      </View>
                      <View style={sheet.rowRods}>
                        {Array.from({ length: Math.min(r.count, 21) }, (_, i) => (
                          <TallyRod key={i} width={ROD_W} height={ROD_H - 2} color={rodColor} />
                        ))}
                        {r.count > 21 && <Text style={countStyle}>+{r.count - 21}</Text>}
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
            {/* Statistiken öppnas nedrullad till pauserna, där taggarna sätts. */}
            <TouchableOpacity
              onPress={() => { setOpen(false); router.push('/stats?focus=recent' as never); }}
              style={sheet.link}
              accessibilityRole="button"
            >
              <Text style={sheet.linkText}>Tag your pauses ›</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  corner: {
    position: 'absolute', left: Spacing.xl, bottom: WEEK_TALLY_BOTTOM,
    paddingVertical: 4, paddingRight: 10, gap: 7,
  },
  kicker: { fontSize: 11, lineHeight: 13, fontWeight: '900', letterSpacing: 2.2 },
  rods: { flexDirection: 'row', alignItems: 'flex-end', gap: ROD_GAP },
  group: { flexDirection: 'row', gap: ROD_GAP },
  more: { fontSize: 11, lineHeight: 14, fontWeight: '700', marginLeft: 4 },
});

const makeSheetStyles = (Palette: AppPalette) => StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: Palette.scrim,
    alignItems: 'center', justifyContent: 'center', padding: Spacing.xl,
  },
  card: {
    width: '100%', backgroundColor: Palette.modalSurface, borderRadius: Radius.xl,
    borderWidth: 1, borderColor: Palette.modalBorder,
    padding: Spacing.xl, gap: Spacing.md,
  },
  kicker: { ...Palette.eyebrow, textAlign: 'center' },
  list: { gap: 14, marginTop: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  disc: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 19 },
  rowBody: { flex: 1, gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  label: { fontSize: 13, lineHeight: 17, fontWeight: '900', letterSpacing: 1.2, flexShrink: 1 },
  count: { fontSize: 13, lineHeight: 17, fontWeight: '700', color: Palette.textSecondary },
  rowRods: { flexDirection: 'row', flexWrap: 'wrap', gap: ROD_GAP, alignItems: 'center' },
  link: { alignItems: 'center', paddingVertical: 4 },
  linkText: { fontSize: 14, fontWeight: '700', color: Palette.hue },
});
