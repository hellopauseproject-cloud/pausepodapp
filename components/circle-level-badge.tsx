import { FontAwesome5 } from '@expo/vector-icons';
import { useId } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { MAX_CIRCLE_LEVEL } from '../lib/circleLevels';

/**
 * Cirkelns nivåmärke — ett riktigt emblem, inte en siffra i en ruta.
 *
 * - **Skivan är svg**, för att den ska glänsa: en radiell toning från en ljus
 *   punkt uppe till vänster ner till en djup ton, en mörkare kant med en ljus
 *   linje innanför, och en glans över övre halvan. Platta palettfärger
 *   lästes som appens förvalda grönt och blått och inte som märken.
 * - **Stjärnan** är N kvadrater lagda på varandra och vridna `90 / N` grader
 *   emellan — två ger åtta uddar, fyra ger sexton. En kvadrat med sidan
 *   `0.66 × size` har hörnen `0.47 × size` från mitten medan skivan bara når
 *   `0.34`, och det glappet *är* uddarna. Ändrar man skivans storlek måste
 *   kvadraternas följa med, annars slukas stjärnan eller spretar utanför.
 * - **Regnbågsringen** på sista steget utnyttjar att React Native färgar
 *   varje kant för sig och byter färg längs kvadratens diagonaler. En rund
 *   `View` med fyra olika `border*Color` blir fyra bågar; två sådana, den
 *   yttre vriden 45°, ger åtta.
 *
 * Märkena trappas upp medvetet: tonen vandrar uppför spektrumet (lime →
 * smaragd → akvamarin → safir → indigo → ametist → magenta → rubin → guld →
 * regnbåge) medan stjärnan växer, ringen blir dubbel och glöden tänds.
 */

type Tone =
  | 'lime'
  | 'emerald'
  | 'aqua'
  | 'sapphire'
  | 'indigo'
  | 'amethyst'
  | 'magenta'
  | 'ruby'
  | 'gold'
  | 'rainbow';

type BadgeSpec = {
  icon: React.ComponentProps<typeof FontAwesome5>['name'];
  tone: Tone;
  /** Antal kvadrater i stjärnan bakom. 0 = ingen stjärna, 4 = sexton uddar. */
  rays: number;
  /** 1 = kant runt skivan, 2 = dessutom en yttre ring. */
  ring: 1 | 2;
  /** Slagskugga i tonens färg. Sparad åt de tre sista stegen. */
  glow?: boolean;
};

type Jewel = { light: string; base: string; deep: string };

/**
 * Ädelstenstonerna: ljus (glansens punkt), bas och djup (kanten och botten).
 * De är **inte** palettnycklar och byter inte med ljust/mörkt läge — ett
 * märke är ett föremål med sin egen kulör, som regnbågen och post-it-lappen.
 */
const JEWELS: Record<Exclude<Tone, 'rainbow'>, Jewel> = {
  lime: { light: '#efffa8', base: '#9bdc3c', deep: '#3f8a1c' },
  emerald: { light: '#b0ffdc', base: '#1fcf86', deep: '#0a6e4a' },
  aqua: { light: '#c0fff9', base: '#1fd3d0', deep: '#0a6f88' },
  sapphire: { light: '#b4dbff', base: '#2f7bff', deep: '#14309a' },
  indigo: { light: '#cfd0ff', base: '#6a5cff', deep: '#2f1ca8' },
  amethyst: { light: '#ecd2ff', base: '#a54dff', deep: '#55189c' },
  magenta: { light: '#ffd0f5', base: '#f03fc9', deep: '#8a1172' },
  ruby: { light: '#ffc8cf', base: '#f2334f', deep: '#850b22' },
  gold: { light: '#fff6c0', base: '#ffc21a', deep: '#a65f00' },
};

/** De åtta regnbågsfärgerna, bara för steg 10 — ringarna och skivans toning. */
const RAINBOW = [
  '#ff4d4d',
  '#ff9f1a',
  '#ffe14d',
  '#3ee07a',
  '#1fd3d0',
  '#3d8bff',
  '#6a5cff',
  '#c04dff',
];

/** Index 0 är nivå 1. Samma ordning och längd som `CIRCLE_LEVELS`. */
const BADGE_SPECS: readonly BadgeSpec[] = [
  { icon: 'seedling', tone: 'lime', rays: 0, ring: 1 },
  { icon: 'leaf', tone: 'emerald', rays: 0, ring: 1 },
  { icon: 'shoe-prints', tone: 'aqua', rays: 0, ring: 1 },
  // Ingen stjärna: en ensam kvadrat är inga uddar utan en ruta bakom skivan.
  { icon: 'fire', tone: 'sapphire', rays: 0, ring: 1 },
  { icon: 'bolt', tone: 'indigo', rays: 2, ring: 1 },
  { icon: 'shield-alt', tone: 'amethyst', rays: 2, ring: 2 },
  { icon: 'medal', tone: 'magenta', rays: 3, ring: 2 },
  { icon: 'trophy', tone: 'ruby', rays: 3, ring: 2, glow: true },
  { icon: 'crown', tone: 'gold', rays: 4, ring: 2, glow: true },
  { icon: 'gem', tone: 'rainbow', rays: 4, ring: 2, glow: true },
];

export function CircleLevelBadge({
  level,
  size = 40,
  /** Låst nivå: samma form, all färg och glans borta. Gör listan läsbar på en blick. */
  locked = false,
}: {
  level: number;
  size?: number;
  locked?: boolean;
}) {
  const Palette = usePalette();
  const uid = useId().replace(/:/g, '');
  const i = Math.max(1, Math.min(MAX_CIRCLE_LEVEL, Math.round(level))) - 1;
  const spec = BADGE_SPECS[i];
  const rainbow = spec.tone === 'rainbow' && !locked;
  // Regnbågens skiva bär ametistens kant och glöd under toningen.
  const jewel = spec.tone === 'rainbow' ? JEWELS.amethyst : JEWELS[spec.tone];

  const tint = locked ? Palette.textDisabled : jewel.base;
  const disc = size * 0.68;
  const ray = size * 0.66;
  const iconSize = size * 0.3;
  const r = disc / 2;
  const rim = Math.max(1.5, disc * 0.06);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Stjärnan. I regnbågsläget får varannan kvadrat sin egen kulör, så
          att uddarna skiftar i stället för att vara enfärgade. */}
      {!locked &&
        Array.from({ length: spec.rays }).map((_, k) => (
          <View
            key={k}
            style={{
              position: 'absolute',
              width: ray,
              height: ray,
              borderRadius: size * 0.07,
              backgroundColor: alpha(
                rainbow ? RAINBOW[(k * 2) % RAINBOW.length] : jewel.base,
                spec.glow ? 0.42 : 0.32,
              ),
              borderWidth: 1,
              borderColor: alpha(rainbow ? RAINBOW[(k * 2 + 1) % RAINBOW.length] : jewel.light, 0.45),
              transform: [{ rotate: `${(90 / spec.rays) * k}deg` }],
            }}
          />
        ))}

      {/* Yttre ringen. I regnbågsläget blir den två ringar med fyra kanter
          var — den andra vriden 45° — vilket ger åtta bågar hela varvet. */}
      {spec.ring === 2 &&
        (rainbow ? (
          [0, 45].map((deg, k) => (
            <View
              key={deg}
              style={{
                position: 'absolute',
                width: size * 0.94,
                height: size * 0.94,
                borderRadius: size * 0.47,
                borderWidth: 2,
                borderTopColor: RAINBOW[k],
                borderRightColor: RAINBOW[k + 2],
                borderBottomColor: RAINBOW[k + 4],
                borderLeftColor: RAINBOW[k + 6],
                transform: [{ rotate: `${deg}deg` }],
              }}
            />
          ))
        ) : (
          <View
            style={{
              position: 'absolute',
              width: size * 0.94,
              height: size * 0.94,
              borderRadius: size * 0.47,
              borderWidth: 1.5,
              borderColor: locked ? alpha(tint, 0.5) : alpha(jewel.base, 0.75),
            }}
          />
        ))}

      {/* Skivan. Glöden ligger här och inte på behållaren, annars lyser den
          runt stjärnans hörn i stället för runt märket. Bakgrundsfärgen bär
          skuggan på Android (elevation kräver en yta). */}
      <View
        style={[
          {
            width: disc,
            height: disc,
            borderRadius: r,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: locked ? Palette.ink07 : jewel.deep,
          },
          spec.glow && !locked
            ? {
                shadowColor: jewel.base,
                shadowOffset: { width: 0, height: 0 },
                shadowOpacity: 0.85,
                shadowRadius: size * 0.2,
                elevation: 8,
              }
            : null,
        ]}
      >
        {locked ? (
          <View
            style={{
              position: 'absolute',
              width: disc,
              height: disc,
              borderRadius: r,
              borderWidth: 1.5,
              borderColor: alpha(tint, 0.55),
            }}
          />
        ) : (
          <Svg width={disc} height={disc} style={{ position: 'absolute' }}>
            <Defs>
              <RadialGradient id={`body${uid}`} cx="35%" cy="28%" r="80%">
                <Stop offset="0" stopColor={jewel.light} />
                <Stop offset="0.45" stopColor={jewel.base} />
                <Stop offset="1" stopColor={jewel.deep} />
              </RadialGradient>
              <LinearGradient id={`rainbow${uid}`} x1="0" y1="0" x2="1" y2="1">
                {RAINBOW.map((c, k) => (
                  <Stop key={c} offset={k / (RAINBOW.length - 1)} stopColor={c} />
                ))}
              </LinearGradient>
              <LinearGradient id={`gloss${uid}`} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#ffffff" stopOpacity={0.7} />
                <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {/* Kroppen, med den djupa tonen som kant. */}
            <Circle
              cx={r}
              cy={r}
              r={r - rim / 2}
              fill={`url(#${rainbow ? 'rainbow' : 'body'}${uid})`}
              stroke={jewel.deep}
              strokeWidth={rim}
            />
            {/* En ljus linje innanför kanten — det som gör en kant till en fasning. */}
            <Circle
              cx={r}
              cy={r}
              r={r - rim * 1.5}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
            {/* Glansen över övre halvan, och en liten skarp reflex. */}
            <Ellipse
              cx={r}
              cy={r * 0.62}
              rx={r * 0.7}
              ry={r * 0.44}
              fill={`url(#gloss${uid})`}
            />
            <Ellipse
              cx={r * 0.62}
              cy={r * 0.45}
              rx={r * 0.13}
              ry={r * 0.08}
              fill="#ffffff"
              fillOpacity={0.85}
              transform={`rotate(-30 ${r * 0.62} ${r * 0.45})`}
            />
          </Svg>
        )}
        <FontAwesome5
          name={spec.icon}
          size={iconSize}
          solid
          color={locked ? Palette.textDisabled : '#ffffff'}
          style={
            locked
              ? undefined
              : {
                  textShadowColor: alpha(jewel.deep, 0.9),
                  textShadowOffset: { width: 0, height: 1 },
                  textShadowRadius: 2,
                }
          }
        />
      </View>
    </View>
  );
}
