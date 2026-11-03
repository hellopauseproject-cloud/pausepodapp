import { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { GlobeGrid } from './globe-grid';

/**
 * Kortet i veckans sammanfattning (app/my-wrapped.tsx): hur många Global
 * Pauses man var med i. Samma ribbon och glans som Global Pause-raden på Hem
 * medan den pågår, med jordklotet i mörkblått — en Global Pause ska se likadan
 * ut överallt den nämns.
 *
 * Kortet mäter sig och ritas i pixlar, av samma skäl som natthimlen.
 */

const RIBBON = ['#8CC4FF', '#7FE0B0', '#FFB77D'] as const;
const INK = '#0A1330';
const ICON = '#173f8a';
const RADIUS = 22;

export function GlobalPauseWeekCard({ count }: { count: number }) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    const h = Math.round(e.nativeEvent.layout.height);
    setBox(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
  };
  const line = count === 1
    ? 'You took part in 1 Global Pause.'
    : `You took part in ${count} Global Pauses.`;

  return (
    <View style={styles.card} onLayout={onLayout} accessibilityLabel={line}>
      {box.w > 0 && (
        <Svg width={box.w} height={box.h} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <LinearGradient id="weekRibbon" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={RIBBON[0]} stopOpacity={0.92} />
              <Stop offset="0.5" stopColor={RIBBON[1]} stopOpacity={0.92} />
              <Stop offset="1" stopColor={RIBBON[2]} stopOpacity={0.92} />
            </LinearGradient>
            <LinearGradient id="weekSheen" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.4} />
              <Stop offset="0.5" stopColor="#ffffff" stopOpacity={0.04} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={box.w} height={box.h} rx={RADIUS} fill="url(#weekRibbon)" />
          <Rect x={0} y={0} width={box.w} height={box.h} rx={RADIUS} fill="url(#weekSheen)" />
        </Svg>
      )}
      <View style={styles.text}>
        <Text style={styles.kicker}>GLOBAL PAUSE</Text>
        <Text style={styles.number}>{count}</Text>
        <Text style={styles.line}>{line}</Text>
      </View>
      <View style={styles.globe}>
        <GlobeGrid size={64} active={false} tint={ICON} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: RADIUS, paddingVertical: 18, paddingHorizontal: 20, overflow: 'hidden',
  },
  text: { flex: 1, gap: 2 },
  kicker: { fontSize: 11, fontWeight: '900', letterSpacing: 2.2, color: ICON },
  number: { fontSize: 40, lineHeight: 44, fontWeight: '900', letterSpacing: -1.2, color: INK, fontVariant: ['tabular-nums'] },
  line: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: INK },
  globe: { width: 64, height: 64 },
});
