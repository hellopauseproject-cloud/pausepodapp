import { ReactNode, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

/**
 * Lådans display på lådsidan. Firmwarens skärmar
 * ([firmware/pausepod_firmware_v8](../firmware/pausepod_firmware_v8/pausepod_firmware_v8.ino),
 * `render*`) i lådsidans form: **en rad, stor**, för att kameran inte längre
 * zoomar in på displayen (på begäran) och texten ska gå att läsa ändå.
 * Orden och färgerna är lådans — HI, CLOCK ON., ON HOLD i honung, den gröna
 * bocken — men varje skärm är kortad till det viktigaste. Ändras en skärm
 * i firmwaren ska den ändras här.
 *
 * Måtten skrivs i en remsa på 320 × 90 och räknas om med `u()`. Färgerna är
 * fasta, inte palettstyrda: displayen är ett föremål, mörkt i båda lägena.
 */

export type PodScreenId =
  | 'off' | 'logo' | 'checking' | 'hello' | 'check' | 'clockOn' | 'count'
  | 'active' | 'hold' | 'done' | 'wifi' | 'connected' | 'pair' | 'paired';

const BG = '#03060e';
const ACCENT = '#2e86de';
const INK = '#fff4ec';
const HONEY = '#f0b978';
const GREEN = '#3cc878';

const SW = 320;
const SH = 100;

export function PodScreen({ id, width, height, name }: { id: PodScreenId; width: number; height: number; name: string }) {
  const scale = Math.min(width / SW, height / SH);
  const u = (n: number) => n * scale;
  return (
    <View style={{ width, height, backgroundColor: BG, overflow: 'hidden' }}>
      <Animated.View key={id} entering={FadeIn.duration(260)} exiting={FadeOut.duration(180)} style={[StyleSheet.absoluteFill, styles.row]}>
        <ScreenBody id={id} u={u} name={name} width={width} height={height} />
      </Animated.View>
    </View>
  );
}

type U = (n: number) => number;

function ScreenBody({ id, u, name, width, height }: { id: PodScreenId; u: U; name: string; width: number; height: number }) {
  const hi = `HI, ${name.toUpperCase().slice(0, 14)}`;
  switch (id) {
    case 'off':
      return null;
    case 'logo':
      return (
        <>
          <Breathing min={0.45}><Mark u={u} h={42} /></Breathing>
          <Heavy u={u} size={43} style={{ marginLeft: u(14) }}>PAUSEPOD</Heavy>
        </>
      );
    case 'checking':
      return <Alternating u={u} />;
    case 'hello':
      return <Heavy u={u} size={48}>{hi}</Heavy>;
    case 'check':
      return <Check u={u} r={30} />;
    case 'clockOn':
      return <Heavy u={u} size={46}>CLOCK ON.</Heavy>;
    case 'count':
      return <Count u={u} />;
    case 'active':
      return <ActiveMark u={u} width={width} height={height} />;
    case 'hold':
      return <Heavy u={u} size={46} color={HONEY}>ON HOLD</Heavy>;
    case 'done':
      return (
        <>
          <Heavy u={u} size={43} color={HONEY}>DONE</Heavy>
          <Heavy u={u} size={44} style={{ marginLeft: u(16) }}>42:18</Heavy>
        </>
      );
    case 'wifi':
      return (
        <>
          <Qr u={u} seed={7} />
          <Heavy u={u} size={44} style={{ marginLeft: u(18) }}>SET UP</Heavy>
        </>
      );
    case 'connected':
      return (
        <>
          <CheckStatic u={u} r={22} />
          <Heavy u={u} size={40} style={{ marginLeft: u(14) }}>CONNECTED</Heavy>
        </>
      );
    case 'pair':
      return (
        <>
          <Qr u={u} seed={3} />
          <Heavy u={u} size={43} style={{ marginLeft: u(18), letterSpacing: u(3) }}>K7Q2MX</Heavy>
        </>
      );
    case 'paired':
      return (
        <>
          <CheckStatic u={u} r={22} />
          <Heavy u={u} size={43} style={{ marginLeft: u(14) }}>{hi}</Heavy>
        </>
      );
  }
}

// ─── Byggstenar ────────────────────────────────────────────

function Heavy({ u, size, color = INK, children, style }: { u: U; size: number; color?: string; children: string; style?: object }) {
  return (
    // Ett långt namn krymper i stället för att klippas (som `fitHeadline` i firmwaren).
    <Text
      numberOfLines={1}
      adjustsFontSizeToFit
      minimumFontScale={0.5}
      allowFontScaling={false}
      style={[styles.heavy, { flexShrink: 1, fontSize: u(size), lineHeight: u(size * 1.25), color }, style]}
    >
      {children}
    </Text>
  );
}

/** Pausmärket: två stående rundade staplar. */
function Mark({ u, h }: { u: U; h: number }) {
  const w = h * 0.3;
  const bar = { width: u(w), height: u(h), borderRadius: u(w / 2), backgroundColor: ACCENT };
  return (
    <View style={{ flexDirection: 'row', gap: u(h * 0.24) }}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

/** Märket som andas, som på lådans startsida. */
function Breathing({ min, children, period = 3200 }: { min: number; children: ReactNode; period?: number }) {
  const reduce = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduce) return;
    o.value = min;
    o.value = withRepeat(withTiming(1, { duration: period / 2, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [reduce, min, period, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** Taggen läst: märkets staplar turas om att lysa. */
function Alternating({ u }: { u: U }) {
  const reduce = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    t.value = withRepeat(withTiming(1, { duration: 600, easing: Easing.inOut(Easing.sin) }), -1, true);
  }, [reduce, t]);
  const a = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * (1 - t.value) }));
  const b = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * t.value }));
  const bar = { width: u(14), height: u(50), borderRadius: u(7), backgroundColor: ACCENT };
  return (
    <View style={{ flexDirection: 'row', gap: u(12) }}>
      <Animated.View style={[bar, a]} />
      <Animated.View style={[bar, b]} />
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Startceremonins gröna bock, ritad fram — lådans enda bekräftelse. */
function Check({ u, r }: { u: U; r: number }) {
  const reduce = useReducedMotion();
  const p = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce) return;
    p.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
  }, [reduce, p]);
  const R = u(r);
  const size = R * 2 + u(10);
  const c = size / 2;
  const len = R * 1.6;
  const props = useAnimatedProps(() => ({ strokeDashoffset: len * (1 - p.value) }));
  return (
    <Svg width={size} height={size}>
      <Circle cx={c} cy={c} r={R} stroke={GREEN} strokeWidth={u(6)} fill="none" />
      <AnimatedPath
        d={`M${c - R * 0.42} ${c + R * 0.02}L${c - R * 0.1} ${c + R * 0.34}L${c + R * 0.46} ${c - R * 0.3}`}
        stroke={GREEN}
        strokeWidth={u(8)}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        strokeDasharray={[len, len]}
        animatedProps={props}
      />
    </Svg>
  );
}

function CheckStatic({ u, r }: { u: U; r: number }) {
  const R = u(r);
  const size = R * 2 + u(8);
  const c = size / 2;
  return (
    <Svg width={size} height={size}>
      <Circle cx={c} cy={c} r={R} stroke={GREEN} strokeWidth={u(5)} fill="none" />
      <Path
        d={`M${c - R * 0.42} ${c}L${c - R * 0.1} ${c + R * 0.32}L${c + R * 0.46} ${c - R * 0.3}`}
        stroke={GREEN}
        strokeWidth={u(6)}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** 00:01–00:03 efter CLOCK ON., en sekund i taget (lådan räknar till 5, `COUNT_SECONDS`; sidan kortar till 3 på begäran). */
function Count({ u }: { u: U }) {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN(v => Math.min(3, v + 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return <Heavy u={u} size={52}>{`00:0${n}`}</Heavy>;
}

/** Pausen pågår: märket i sin gloria, och inget mer. */
function ActiveMark({ u, width, height }: { u: U; width: number; height: number }) {
  return (
    <>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="podHalo" cx={width / 2} cy={height / 2} rx={u(90)} ry={u(60)} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={ACCENT} stopOpacity={0.32} />
            <Stop offset="0.6" stopColor={ACCENT} stopOpacity={0.1} />
            <Stop offset="1" stopColor={ACCENT} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#podHalo)" />
      </Svg>
      <Breathing min={0.7} period={6000}><Mark u={u} h={60} /></Breathing>
    </>
  );
}

/**
 * En QR-kod i en vit ruta, som lådan visar för WiFi och nya taggar. Den är
 * en attrapp med kodens tre hörnmärken; den ska se ut som en kod, inte gå
 * att skanna.
 */
function Qr({ u, seed }: { u: U; seed: number }) {
  return <QrCode size={u(76)} seed={seed} />;
}

/** Samma attrapp-kod i valfri storlek — också i kamerans sökare (pod-app-peek.tsx). */
export function QrCode({ size, seed }: { size: number; seed: number }) {
  const N = 21;
  const cells = useMemo(() => fakeQr(N, seed), [seed]);
  const pad = size * 0.066;
  const cell = (size - 2 * pad) / N;
  return (
    <View style={{ width: size, height: size, backgroundColor: '#ffffff', borderRadius: size * 0.053 }}>
      <Svg width={size} height={size}>
        <Path d={cells.map(([cx, cy]) => `M${pad + cx * cell} ${pad + cy * cell}h${cell}v${cell}h${-cell}Z`).join('')} fill={BG} />
      </Svg>
    </View>
  );
}

function fakeQr(n: number, seed: number): [number, number][] {
  let a = seed * 9973 + 17;
  const rnd = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: [number, number][] = [];
  const finder = (x: number, y: number) => x >= 0 && y >= 0 && x < 7 && y < 7;
  const inFinder = (x: number, y: number) => finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (inFinder(x, y)) {
        const lx = x < 7 ? x : n - 1 - x;
        const ly = y < 7 ? y : n - 1 - y;
        const ring = Math.max(Math.abs(lx - 3), Math.abs(ly - 3));
        if (ring !== 2) out.push([x, y]);
      } else if ((x === 7 || y === 7 || x === n - 8 || y === n - 8) && (inFinder(x - 1, y) || inFinder(x, y - 1) || inFinder(x + 1, y) || inFinder(x, y + 1))) {
        // Den tysta kanten runt hörnmärkena.
      } else if (rnd() < 0.5) {
        out.push([x, y]);
      }
    }
  }
  return out;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: '4%' },
  heavy: { fontWeight: '900' },
});
