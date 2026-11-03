import { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Ytan på PAUSE (och SLEEP) — knappen man håller in för att börja.
 *
 * Tre lager, och inget av dem är en platt färg:
 *
 * - **Kroppen** är en toning i pausens ljus, ljusare upptill och djupare
 *   nedtill, så att knappen har en volym och inte är en målad yta.
 * - **Ljuskällan** är designsystemets ljusa pausblå (`#8CC4FF`) som ett mjukt
 *   ljus uppe i mitten, som om knappen lyser inifrån.
 * - **Kanten** är en hårfin ljus linje som är starkast upptill och tonar bort
 *   nedåt, den spekulära kanten i Apples Liquid Glass och den inre
 *   ljuslinjen i Linears knappar. Det är den som gör att knappen läses som
 *   ett material.
 *
 * Ytan ligger **under** hållfyllningen (`background` på HoldToStartButton), så
 * fyllningen syns som förut. Den mäter sin knapp och ritas i pixlar, av samma
 * skäl som natthimlen: procent löses inte upp mot den verkliga höjden.
 */

// Pausens ljus ur designsystemet, ljusare och djupare.
const TOP = '#4aa3f5';
const BOTTOM = '#1f6fc8';
const LIGHT = '#8cc4ff';

export function PauseButtonFace({ radius }: { radius: number }) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    const h = Math.round(e.nativeEvent.layout.height);
    setBox(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
  };
  const { w, h } = box;
  const r = Math.min(radius, h / 2);

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}
      onLayout={onLayout}
    >
      {w > 0 && (
        <Svg width={w} height={h}>
          <Defs>
            <LinearGradient id="pauseBody" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={TOP} />
              <Stop offset="1" stopColor={BOTTOM} />
            </LinearGradient>
            <RadialGradient id="pauseLight" cx={w / 2} cy={0} rx={w * 0.55} ry={h * 0.95} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={LIGHT} stopOpacity={0.55} />
              <Stop offset="1" stopColor={LIGHT} stopOpacity={0} />
            </RadialGradient>
            <LinearGradient id="pauseEdge" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#ffffff" stopOpacity={0.55} />
              <Stop offset="0.45" stopColor="#ffffff" stopOpacity={0.08} />
              <Stop offset="1" stopColor="#ffffff" stopOpacity={0.18} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={w} height={h} rx={r} fill="url(#pauseBody)" />
          <Rect x={0} y={0} width={w} height={h} rx={r} fill="url(#pauseLight)" />
          <Rect
            x={0.75} y={0.75} width={w - 1.5} height={h - 1.5} rx={r - 0.75}
            fill="none" stroke="url(#pauseEdge)" strokeWidth={1.5}
          />
        </Svg>
      )}
    </View>
  );
}
