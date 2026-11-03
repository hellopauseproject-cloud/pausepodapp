import { FontAwesome5 } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, interpolateColor, useAnimatedStyle, useReducedMotion, useSharedValue,
  withRepeat, withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { AppPalette, Radius } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import {
  fetchGlobalPause, formatCountdown, formatGlobalPauseStart, GLOBAL_PAUSE_NEAR_MS, GlobalPause,
} from '../lib/globalPause';
import { GLOBAL_PAUSE_NAME } from '../lib/notifications';

/**
 * Raden på Hem, mitt emellan topbaren och Day/Night. Ett tryck öppnar rummet
 * ([app/global-pause.tsx](../app/global-pause.tsx)).
 *
 * **Den är grå tills det pågår, och tänds då.** Före och efter är kapseln en
 * dämpad yta med grått jordklot och grå text — en upplysning. Medan Global
 * Pause pågår blir den designsystemets ribbon (flikarnas ljusa toner
 * `#8CC4FF → #7FE0B0 → #FFB77D`) med glans upptill, och pricken vid jordklotet skiftar genom ribbonens tre
 * färger. Skillnaden mellan de två är hela poängen: man ska se på håll att
 * det är dags.
 *
 * **Jordklotet är namnet** i alla lägen; namnet står bara i
 * `accessibilityLabel`. Texten: *Next · 18:00*, *Tomorrow · 18:00*,
 * *In 1h 20min*, *12 pausing now* och *Done* (en kvart efter slutet).
 *
 * Hem placerar den (`GLOBAL_PAUSE_LINE_H` är dess höjd).
 */
export const GLOBAL_PAUSE_LINE_H = 40;

const PILL_H = 32;
const POLL_MS = 30_000;
const TICK_MS = 15_000;
const DOT_CYCLE_MS = 6000;
// Designsystemets ribbon i flikarnas ljusa toner.
const RIBBON = ['#8CC4FF', '#7FE0B0', '#FFB77D'] as const;
const INK = '#0A1330';      // Navy 900
const ICON = '#173f8a';     // mörkblått

/** *Next · 18:00*, *Tomorrow · 18:00* eller *Next · Tue 18:00*. */
function nextLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const clock = formatGlobalPauseStart(iso).slice(4);
  if (days === 0) return `Next · ${clock}`;
  if (days === 1) return `Tomorrow · ${clock}`;
  return `Next · ${formatGlobalPauseStart(iso)}`;
}

export function GlobalPauseLine() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [pause, setPause] = useState<GlobalPause | null>(null);
  const [now, setNow] = useState(Date.now());
  const [w, setW] = useState(0);

  useFocusEffect(useCallback(() => {
    const load = () => { fetchGlobalPause().then(setPause).catch(() => {}); };
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []));

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const starts = pause ? new Date(pause.starts_at).getTime() : 0;
  const ends = pause ? new Date(pause.ends_at).getTime() : 0;
  const live = !!pause && now >= starts && now < ends;

  // Pricken byter ribbonfärg — bara medan den pågår. (En ljusreflex som svepte
  // över kapseln fanns en kort stund och togs bort på begäran.)
  const reduceMotion = useReducedMotion();
  const cycle = useSharedValue(0);
  useEffect(() => {
    if (!live || reduceMotion) { cancelAnimation(cycle); return; }
    cycle.value = 0;
    cycle.value = withRepeat(withTiming(1, { duration: DOT_CYCLE_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(cycle);
  }, [live, reduceMotion, cycle]);

  const dotStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      cycle.value, [0, 1 / 3, 2 / 3, 1], [RIBBON[0], RIBBON[1], RIBBON[2], RIBBON[0]],
    ),
  }));

  if (!pause) return <View style={styles.slot} />;

  const value = live
    ? `${pause.counts.pausing} pausing now`
    : pause.last
      ? 'Done'
      : starts - now <= GLOBAL_PAUSE_NEAR_MS
        ? `In ${formatCountdown(starts - now)}`
        : nextLabel(pause.starts_at);

  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    setW(prev => (prev === next ? prev : next));
  };

  return (
    <View style={styles.slot}>
      <TouchableOpacity
        style={[styles.pill, !live && styles.pillQuiet]}
        onLayout={onLayout}
        onPress={() => router.push('/global-pause' as never)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${GLOBAL_PAUSE_NAME}. ${value}${pause.me ? '. You are joining.' : ''}`}
      >
        {live && w > 0 && (
          <Svg width={w} height={PILL_H} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs>
                <LinearGradient id="globalRibbon" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={RIBBON[0]} stopOpacity={0.9} />
                  <Stop offset="0.5" stopColor={RIBBON[1]} stopOpacity={0.9} />
                  <Stop offset="1" stopColor={RIBBON[2]} stopOpacity={0.9} />
                </LinearGradient>
                <LinearGradient id="globalSheen" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor="#ffffff" stopOpacity={0.5} />
                  <Stop offset="0.55" stopColor="#ffffff" stopOpacity={0.05} />
                  <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Rect x={0} y={0} width={w} height={PILL_H} rx={PILL_H / 2} fill="url(#globalRibbon)" />
              <Rect x={0} y={0} width={w} height={PILL_H} rx={PILL_H / 2} fill="url(#globalSheen)" />
            </Svg>
        )}
        <View style={styles.globe}>
          <FontAwesome5 name="globe-europe" size={14} color={live ? ICON : Palette.textTertiary} />
          {live && <Animated.View style={[styles.dot, dotStyle]} />}
        </View>
        <Text style={[styles.value, !live && styles.valueQuiet]} numberOfLines={1}>{value}</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  slot: { height: GLOBAL_PAUSE_LINE_H, alignItems: 'center', justifyContent: 'center' },
  pill: {
    height: PILL_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 11,
    paddingRight: 15,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    maxWidth: '100%',
  },
  // Före och efter: en dämpad yta, ingen färg.
  pillQuiet: { backgroundColor: Palette.ink08 },
  globe: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute', right: -3, top: -2,
    width: 7, height: 7, borderRadius: 3.5,
    borderWidth: 1.5, borderColor: '#ffffff',
  },
  value: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: INK, fontVariant: ['tabular-nums'] },
  valueQuiet: { fontWeight: '600', color: Palette.textSecondary },
});
