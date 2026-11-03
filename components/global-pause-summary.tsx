import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AudioPlayer } from 'expo-audio';

import { alpha, AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { formatDuration } from '../lib/circles';
import {
  fetchGlobalPause, formatGlobalPauseWhen, GlobalPause, GlobalPauseResult, joinGlobalPause,
} from '../lib/globalPause';
import { setPendingPauseTag } from '../lib/pauseTags';
import { GlobeGrid } from './globe-grid';

/**
 * Sammanfattningen efter en paus som låg i en Global Pause
 * ([app/pausesummary.tsx](../app/pausesummary.tsx) väljer den). Samma
 * överlämning som en ensam paus — lappen till Hem, klockan — men skärmen
 * stannar, för här finns något att säga: att man var med.
 *
 * I rummets stil: nattrummet, jordklotet och designsystemets display. Raderna
 * stiger upp en i taget (designsystemets *reveal*: lyft och tona in, lugnt).
 * Ingen beröm och inga utropstecken — rösten är kort och lite torr.
 *
 * Under resultatet står nästa Global Pause med *I'll join*. Ett tryck anmäler
 * och byter knappen mot *You're in*; tiden står kvar. Står man redan anmäld
 * syns *You're in* direkt.
 */

// Designsystemets easing och reveal: .9–1.1 s, i steg om .13 s.
const REVEAL_MS = 1000;
const STAGGER_MS = 130;

const reveal = (i: number) => FadeInDown.duration(REVEAL_MS).delay(200 + i * STAGGER_MS);

export function GlobalPauseSummary({ result, seconds, hasIntention, bell }: {
  result: GlobalPauseResult;
  /** Hela pausens längd — det man vann, som på Hem. */
  seconds: number;
  hasIntention: boolean;
  bell: AudioPlayer;
}) {
  const Palette = usePalette();
  const s = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();

  useEffect(() => { bell.play(); }, [bell]);

  // Nästa Global Pause. Pågår den man just var med i fortfarande är "nästa"
  // samma paus, och då står ingen nästa här.
  const [next, setNext] = useState<GlobalPause | null>(null);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetchGlobalPause().then(p => {
      if (!p || p.starts_at === result.starts_at) return;
      setNext(p);
      setJoined(!!p.me);
    }).catch(() => {});
  }, [result.starts_at]);

  const join = async () => {
    setBusy(true);
    try {
      await joinGlobalPause(null);
      setJoined(true);
    } catch {
      // Står kvar som en knapp; ett nytt tryck försöker igen.
    } finally {
      setBusy(false);
    }
  };

  const others = Math.max(0, result.people - 1);
  const withLine = others === 0
    ? 'You held the room.'
    : others === 1 ? 'You paused with 1 other.' : `You paused with ${others} others.`;

  const home = () => {
    // Klockan har redan ringt här.
    setPendingPauseTag(seconds, hasIntention, false);
    router.replace('/(tabs)');
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 24) + 24 }]}>
      <StatusBar style="light" />
      <View style={s.center}>
        <GlobeGrid size={260} active fade={Palette.bg} />
        <Animated.Text entering={reveal(0)} style={s.kicker}>GLOBAL PAUSE</Animated.Text>
        <Animated.Text entering={reveal(1)} style={s.big}>{formatDuration(seconds)}</Animated.Text>
        <Animated.Text entering={reveal(2)} style={s.sub}>{withLine}</Animated.Text>
        {result.total_seconds > 0 && (
          <Animated.View entering={reveal(3)} style={s.togetherPill}>
            <Text style={s.togetherText}>{formatDuration(result.total_seconds)} together</Text>
          </Animated.View>
        )}
      </View>

      {next && (
        <Animated.View entering={reveal(4)} style={s.next}>
          <Text style={s.nextKicker}>NEXT GLOBAL PAUSE</Text>
          <Text style={s.nextWhen}>{formatGlobalPauseWhen(next.starts_at)}</Text>
          {joined ? (
            <Text style={s.inLine}>You&apos;re in</Text>
          ) : (
            <TouchableOpacity style={s.join} onPress={join} disabled={busy} activeOpacity={0.75} accessibilityRole="button">
              <Text style={s.joinText}>I&apos;ll join</Text>
            </TouchableOpacity>
          )}
        </Animated.View>
      )}

      <Animated.View entering={reveal(5)}>
        <TouchableOpacity style={s.back} onPress={home} activeOpacity={0.75} accessibilityRole="button">
          <Text style={s.backText}>Back to start</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: Spacing.xl, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { ...Palette.eyebrow, color: Palette.hue },
  // Designsystemets display: Arial Black 900, tätt.
  big: {
    fontSize: 64, lineHeight: 72, fontWeight: '900', letterSpacing: -2,
    color: Palette.textPrimary, fontVariant: ['tabular-nums'], marginTop: 8,
  },
  sub: { fontSize: 16, color: Palette.textSecondary, marginTop: 8, textAlign: 'center' },
  togetherPill: {
    marginTop: 18, paddingHorizontal: 14, height: 30, borderRadius: Radius.pill,
    borderWidth: 1, borderColor: alpha(Palette.hue, 0.4), justifyContent: 'center',
  },
  togetherText: { fontSize: 13, fontWeight: '700', color: Palette.hue, fontVariant: ['tabular-nums'] },
  next: { alignItems: 'center', gap: 6, marginBottom: 28 },
  nextKicker: { ...Palette.eyebrow, color: Palette.textTertiary },
  nextWhen: { fontSize: 20, fontWeight: '900', color: Palette.textPrimary, fontVariant: ['tabular-nums'], marginBottom: 8 },
  // Samma mått som rummets I'll join, som är lika bred som PAUSE.
  join: {
    width: 196, minHeight: 58, paddingHorizontal: 14, borderRadius: 29,
    borderWidth: 1.5, borderColor: alpha(Palette.hue, 0.55), alignItems: 'center', justifyContent: 'center',
  },
  joinText: { fontSize: 16, fontWeight: '600', color: Palette.hue },
  // Lika hög som knappen den ersätter, så att ingenting under flyttar sig.
  inLine: { minHeight: 58, textAlignVertical: 'center', lineHeight: 58, fontSize: 17, fontWeight: '700', color: Palette.textPrimary },
  // Tillbaka: en textlänk, så att den inte tävlar med I'll join.
  back: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  backText: { fontSize: 15, fontWeight: '600', color: Palette.textSecondary },
});
