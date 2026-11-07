import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { AppPalette } from '../constants/appTheme';
import { useAuth } from '../contexts/AuthContext';
import { usePalette } from '../contexts/ThemeContext';
import { Category, getSelectedCategories } from '../app/pauseLogger';
import { track } from '../lib/analytics';
import { formatDuration } from '../lib/circles';
import { findJustEndedSessionId, setPauseIntention, tagPauseAsSleep } from '../lib/pauseTags';
import { CelebrationBurst } from './celebration-burst';
import { PauseTagChips } from './pause-tag-chips';

/**
 * Kortet som glider upp på Hem efter en paus: *+18 min won back* i grönt med
 * *SKIP* uppe till höger, och *What did you do instead?* med intentionerna
 * som färgade chips.
 *
 * Komponenten äger frågan och sparningen; Hem äger var kortet står och hur
 * det glider (app/(tabs)/index.tsx). Sparningen är samma som i statistiken
 * (lib/pauseTags.ts) — pausens rad letas upp på längd och tid, eftersom Hem
 * inte får något id.
 *
 * **Ett val får ett svar.** Användarna tyckte att efter-pausen var platt, och
 * det plattaste var att kortet bara försvann när man valt. Nu svarar det
 * direkt — chippen fylls och studsar, en skur, en haptik och en rad som
 * `Pages over scrolling.` i frågans ställe — och stänger sig efter
 * `REWARD_MS`. Svaret är optimistiskt: det visas innan sparningen hunnit
 * klart (den kan ta ett nytt försök efter 1,2 s), och faller sparningen
 * byts det mot felraden som förut.
 *
 * Det blockerar aldrig: *SKIP* stänger det, och ett misslyckat val byter
 * chippen mot en rad om att pausen går att tagga i statistiken i stället.
 */

// Hur länge svaret står kvar innan kortet glider ner — räknat från trycket,
// inte från sparningen.
const REWARD_MS = 1500;

// Svaret på ett val. Tre till fyra ord, inget pronomen, ingen skuld — och
// ingen bock eller grönt, för bekräftelse är lådans (CLAUDE.md, *Design*).
// Egna aktiviteter och okända id:n får reservraden.
const REWARD_LINES: Record<string, string> = {
  focus: 'Deep focus. Nice.',
  walk: 'Fresh air. Good call.',
  workout: 'Strong move.',
  social: 'Real people. Nice.',
  clean: 'Tidy win.',
  meditate: 'Calm mind. Nice.',
  read: 'Pages over scrolling.',
  study: 'Brain time. Nice.',
  rest: 'Rest counts too.',
  create: 'Made something. Nice.',
  music: 'Good vibes only.',
  nature: 'Outside. Good call.',
  sleep: 'Sleep well.',
};
const SLEEP_PICK: Category = { id: 'sleep', label: 'SLEEP', emoji: '🌙' };
const REWARD_FALLBACK = 'Time well spent.';

export function PauseTagSheet({
  durationSeconds, sleepable, onClose, onSlept, onHeight, bottomPadding,
}: {
  durationSeconds: number;
  /** Bara en ensam lådpaus får *Sleep* (lib/pauseTags.ts). */
  sleepable: boolean;
  onClose: () => void;
  /** Pausen blev en natt: Hem hämtar om dagens siffra, som just tappade den. */
  onSlept: () => void;
  /** Kortets uppmätta höjd — Hem lyfter heron med den. */
  onHeight: (h: number) => void;
  bottomPadding: number;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const { user } = useAuth();
  const [cats, setCats] = useState<Category[]>([]);
  const [state, setState] = useState<'open' | 'saving' | 'failed'>('open');
  const [picked, setPicked] = useState<Category | null>(null);
  const [burst, setBurst] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => { getSelectedCategories().then(setCats); }, []);

  const pick = async (c: Category) => {
    if (!user?.id || state !== 'open') return;
    const startedAt = Date.now();
    setPicked(c);
    setState('saving');
    setBurst(k => k + 1);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    const isSleep = c === SLEEP_PICK;
    const id = await findJustEndedSessionId(user.id, durationSeconds);
    const ok = id
      ? await (isSleep ? tagPauseAsSleep(id) : setPauseIntention(id, user.id, c.label))
      : false;
    if (!aliveRef.current) return;
    if (ok) {
      track(isSleep ? 'pause_tagged_as_sleep' : 'pause_tagged', { category: c.id, where: 'home' });
      if (isSleep) onSlept();
      const left = REWARD_MS - (Date.now() - startedAt);
      setTimeout(() => { if (aliveRef.current) onClose(); }, Math.max(0, left));
    } else {
      setPicked(null);
      setState('failed');
    }
  };

  const rewarding = !!picked && state === 'saving';

  return (
    <View
      style={[styles.sheet, { paddingBottom: bottomPadding }]}
      onLayout={(e: LayoutChangeEvent) => onHeight(Math.round(e.nativeEvent.layout.height))}
      accessibilityViewIsModal={false}
      accessibilityLiveRegion="polite"
    >
      {/* Skuren ligger bakom innehållet och når ut över kortets kant. */}
      <View pointerEvents="none" style={styles.burstWrap}>
        <CelebrationBurst burstKey={burst} size={300} count={20} />
      </View>

      {/* Skip står uppe till höger, på samma rad som tiden: den är en väg
          ut, inte ett svar, och ska inte stå sist under chippen där den
          läses som ett av dem. Medan svaret visas finns inget att hoppa
          över — knappen står kvar osynlig så att raden inte hoppar. */}
      <View style={styles.topRow}>
        <Text style={styles.won} numberOfLines={1}>
          +{formatDuration(durationSeconds)}
          <Text style={styles.wonUnit}>  won back</Text>
        </Text>
        <TouchableOpacity
          onPress={onClose}
          style={[styles.skip, rewarding && styles.hidden]}
          disabled={rewarding}
          activeOpacity={0.6}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityElementsHidden={rewarding}
        >
          <Text style={styles.skipText}>{state === 'failed' ? 'Close' : 'Skip'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.question, rewarding && styles.reward]}>
        {rewarding ? (REWARD_LINES[picked.id] ?? REWARD_FALLBACK) : 'What did you do instead?'}
      </Text>
      {state === 'failed' ? (
        <Text style={styles.failed}>
          Couldn&apos;t save that. You can tag this pause in Statistics.
        </Text>
      ) : (
        <PauseTagChips
          categories={cats}
          selectedLabel={picked?.label ?? null}
          onPick={pick}
          disabled={state !== 'open'}
          colorful
          onPickSleep={sleepable ? () => pick(SLEEP_PICK) : undefined}
          sleepOn={picked === SLEEP_PICK}
        />
      )}
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  // Designreferensens kort: kant i kant, rundat upptill, ett lyft uppåt.
  // Samma yta som rummets kort (`surface`) och samma skugga som lakanet som
  // låg här förut — svart och djup, inte en blå glöd.
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: 34, borderTopRightRadius: 34,
    paddingTop: 24, paddingHorizontal: 22,
    gap: 12,
    shadowColor: Palette.mode === 'dark' ? 'rgb(0,0,0)' : 'rgb(10,30,80)',
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: Palette.mode === 'dark' ? 0.5 : 0.14,
    shadowRadius: 24,
    elevation: 16,
  },
  burstWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  // Tiden är kortets rubrik nu, i grönt (på begäran, se grönregeln i
  // CLAUDE.md) — det man fick är det första man
  // ser. Får krympa före Skip, så att en lång tid aldrig trycker ut knappen.
  won: {
    flexShrink: 1,
    fontSize: 22, lineHeight: 26, fontWeight: '900', letterSpacing: 0.5,
    color: Palette.success,
  },
  wonUnit: {
    fontSize: 13, fontWeight: '800', letterSpacing: 1.6,
    color: Palette.success, textTransform: 'uppercase',
  },
  question: { fontSize: 24, lineHeight: 28, fontWeight: '900', color: Palette.textPrimary, marginBottom: 2 },
  reward: { color: Palette.hue },
  failed: { fontSize: 14, lineHeight: 20, color: Palette.textSecondary },
  skip: { paddingVertical: 4 },
  hidden: { opacity: 0 },
  skipText: { fontSize: 13, fontWeight: '700', letterSpacing: 1.8, color: Palette.textSecondary, textTransform: 'uppercase' },
});
