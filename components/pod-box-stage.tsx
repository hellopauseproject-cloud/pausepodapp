import { ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { Art, buildPodBoxArt, Grad, PHONE_DROP, Prim, VIEW_H, VIEW_W } from '../lib/podBoxArt';
import { PodAppPeek, PodAppView } from './pod-app-peek';
import { PodScreen, PodScreenId } from './pod-screen';

/**
 * Lådan på lådsidan ([app/pod.tsx](../app/pod.tsx)): ritningen ur
 * [lib/podBoxArt.ts](../lib/podBoxArt.ts) i fem lager som rör sig var för
 * sig, och displayen som riktiga vyer i sitt fönster.
 *
 * **Scenen tar ett läge, inte en tidslinje.** `state` säger var locket,
 * telefonen och kameran ska vara och vad displayen visar; scenen glider dit.
 * Tidslinjen bor i sidan, som byter läge — så att samma låda kan spela både
 * ritualen och inställningen.
 *
 * - **Locket** har tre lägen: på (0), lyft (1) och lagt åt sidan bakom
 *   lådan (2). Det finns två kopior, en framför kroppen och en bakom
 *   inredningen, och de byter vid lyftets topp: på väg upp är locket framför
 *   lådan, lagt åt sidan ligger det bakom, så att telefonen kan passera
 *   framför det.
 * - **Telefonen** hålls ovanför lådan (`hover`) och sjunker ner bakom
 *   framsidan (`in`) — den ligger lägre än kanten och syns inte, precis som i
 *   verkligheten. `away` tonar bort den uppåt. **Den vänds innan den läggs
 *   ner** (`side`): ryggen med taggen visas först, sedan vänds telefonen runt
 *   sin långa axel så att skärmen ligger upp och taggen pekar nedåt mot
 *   lådans läsare.
 * - **Kameran** zoomar bara in på taggen, inte på displayen (på begäran):
 *   displayens text är i stället stor nog att läsas i vila. I vila står den
 *   lite närmare än hela ritningen (`REST`), så att lådan fyller bredden.
 *   Allt ritas i `SUPER` gånger sin storlek och skalas ner, så att det
 *   inzoomade är skarpt: iOS skalar annars upp en färdig bild. Varje lager är
 *   bara så stort som det det ritar, för minnets skull.
 *
 * Med reducerad rörelse hoppar allt direkt till sitt läge.
 */

export type PodLid = 0 | 1 | 2;
export type PodPhone = 'away' | 'hover' | 'in';
export type PodZoom = 'none' | 'phone';
export type PodStageState = {
  lid: PodLid;
  phone: PodPhone;
  screen: PodScreenId;
  zoom: PodZoom;
  /** Vilken sida av telefonen som ligger upp: ryggen med taggen, eller skärmen. */
  side: 'tag' | 'screen';
  /** Om Pause-dekalen sitter på telefonen. Blir den `true` klistras den på. */
  sticker: boolean;
  /** Telefonen efter pausen, framför lådan: ringen på Hem eller statistiken. */
  app: 'none' | PodAppView;
};

const ART: Art = buildPodBoxArt();

/** Hur mycket större än sin plats scenen ritas. */
const SUPER = 2;
/** Skalan (mot den ritade storleken) i vila och när kameran står på taggen. */
const REST = 1.18 / SUPER;
const PHONE_ZOOM = 1.5;
/** Vilans mittpunkt: lite ovanför vyns mitt, så att locket bakom lådan ryms. */
const REST_FOCUS = [VIEW_W / 2, 140];

const LID_MS = 850;
const PHONE_MS = 1100;
const ZOOM_MS = 1000;
const FLIP_MS = 800;
const MORPH_MS = 1000;
/** Hur stor del av lyftet som tonar telefonen i scenen och attrappen i varandra. */
const MORPH_FADE = 0.22;
const EASE = Easing.inOut(Easing.cubic);

// Lockets lägen, i vyns enheter: på, lyft, och lagt bakom lådan (lite mindre,
// för det ligger längre bort).
const LID_X = [0, 0, 14];
const LID_Y = [0, -70, -88];
const LID_SCALE = [1, 1, 0.92];
const LID_ROT = [0, -2, 0];

// Lagrens rutor i vyn (y0, y1, x0, x1): bara det som ritas i dem.
const REGION = {
  base: [112, VIEW_H, 0, VIEW_W],
  phone: [64, 112, 90, 290],
  lid: [108, 182, 30, 336],
  // Dekalen, centrerad på sig själv så att den skalas kring sin egen mitt.
  tag: [ART.tagCenter[1] - 12, ART.tagCenter[1] + 12, ART.tagCenter[0] - 28, ART.tagCenter[0] + 28],
} as const;

/**
 * Dekalen klistras på som en riktig dekal: den kommer ner böjd, tar i med
 * vänsterkanten och rullas fast mot högerkanten. Talen är i dekallagrets
 * enheter: dekalen spänner över `STICKER_X0`–`STICKER_X1` i sin ruta.
 */
const STICKER_X0 = 10;
const STICKER_X1 = 46;
/** Hur högt den hålls innan den tar i, och hur böjd den lösa delen är. */
const STICKER_LIFT = -10;
const STICKER_BEND = 62;
/** Andelen av förloppet som går åt till att sänka den mot telefonen. */
const STICKER_LAND = 0.28;
const STICKER_MS = 1700;

const PHONE_AWAY = -40;

export function PodBoxStage({ width, state, name }: { width: number; state: PodStageState; name: string }) {
  const reduce = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const height = width * (VIEW_H / VIEW_W);
  const cw = width * SUPER;
  const ch = height * SUPER;
  const k = cw / VIEW_W;

  const lid = useSharedValue<number>(state.lid);
  const phoneY = useSharedValue(phoneTarget(state.phone));
  const flip = useSharedValue(state.side === 'screen' ? 1 : 0);
  const glow = useSharedValue(0);
  // Telefonen lyft ur scenen som attrappen (se `morph` nedan).
  const morph = useSharedValue(0);
  const lifted = useSharedValue(0);
  const sticker = useSharedValue(state.sticker ? 1 : 0);

  // Dekalen klistras på: först sänks den, böjd, tills vänsterkanten tar i;
  // sedan går kontaktlinjen åt höger. Det som passerats ligger platt (`stuck`,
  // urklippt fram till linjen), resten är en lös flik som lutar upp från
  // linjen och lägger sig allt plattare (`flap`, vriden kring sin vänsterkant
  // med perspektiv). Tas den bort (mellan varven) sker det direkt, för då är
  // telefonen borta.
  useEffect(() => {
    sticker.value = state.sticker && !reduce
      ? withTiming(1, { duration: STICKER_MS, easing: Easing.inOut(Easing.cubic) })
      : (state.sticker ? 1 : 0);
  }, [state.sticker, reduce, sticker]);
  const tagW = (REGION.tag[3] - REGION.tag[2]) * k;
  const tagH = (REGION.tag[1] - REGION.tag[0]) * k;
  const lineAt = (p: number) => {
    'worklet';
    return interpolate(p, [STICKER_LAND, 1], [STICKER_X0, STICKER_X1], 'clamp') * k;
  };
  const stickerWrap = useAnimatedStyle(() => ({
    opacity: interpolate(sticker.value, [0, 0.12], [0, 1], 'clamp'),
    transform: [{ translateY: interpolate(sticker.value, [0, STICKER_LAND], [STICKER_LIFT, 0], 'clamp') * k }],
  }));
  const stuckStyle = useAnimatedStyle(() => ({ width: lineAt(sticker.value) }));
  const flapStyle = useAnimatedStyle(() => {
    const x = lineAt(sticker.value);
    const bend = interpolate(sticker.value, [0, STICKER_LAND, 1], [STICKER_BEND, STICKER_BEND * 0.8, 0], 'clamp');
    return {
      left: x,
      width: Math.max(0, tagW - x),
      transform: [{ perspective: tagW * 2.2 }, { rotateY: `${-bend}deg` }],
    };
  });
  const flapInner = useAnimatedStyle(() => ({ transform: [{ translateX: -lineAt(sticker.value) }] }));

  // Taggen skiner och pulserar medan kameran står på den, så att det syns
  // vad kameran pekar på.
  useEffect(() => {
    const on = state.zoom === 'phone';
    if (reduce) { glow.value = on ? 1 : 0; return; }
    glow.value = on
      ? withDelay(400, withRepeat(withSequence(
        withTiming(1, { duration: 650, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.3, { duration: 650, easing: Easing.inOut(Easing.sin) }),
      ), -1))
      : withTiming(0, { duration: 300 });
  }, [state.zoom, reduce, glow]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const camera0 = cameraFor(state.zoom, cw, ch, k);
  const s = useSharedValue(camera0.s);
  const tx = useSharedValue(camera0.tx);
  const ty = useSharedValue(camera0.ty);

  useEffect(() => {
    const t = (ms: number) => ({ duration: reduce ? 0 : ms, easing: EASE });
    lid.value = withTiming(state.lid, t(LID_MS * Math.max(1, Math.abs(state.lid - lid.value))));
    phoneY.value = withTiming(phoneTarget(state.phone), t(PHONE_MS));
    flip.value = withTiming(state.side === 'screen' ? 1 : 0, t(FLIP_MS));
    const cam = cameraFor(state.zoom, cw, ch, k);
    s.value = withTiming(cam.s, t(ZOOM_MS));
    tx.value = withTiming(cam.tx, t(ZOOM_MS));
    ty.value = withTiming(cam.ty, t(ZOOM_MS));
  }, [state.lid, state.phone, state.zoom, state.side, reduce, cw, ch, k, lid, phoneY, flip, s, tx, ty]);

  const camera = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: s.value }],
  }));
  const lidMotion = (front: boolean) => () => {
    'worklet';
    const L = lid.value;
    return {
      opacity: front ? (L <= 1 ? 1 : 0) : (L > 1 ? 1 : 0),
      transform: [
        { translateX: interpolate(L, [0, 1, 2], LID_X) * k },
        { translateY: interpolate(L, [0, 1, 2], LID_Y) * k },
        { rotate: `${interpolate(L, [0, 1, 2], LID_ROT)}deg` },
        { scale: interpolate(L, [0, 1, 2], LID_SCALE) },
      ],
    };
  };
  const lidFront = useAnimatedStyle(lidMotion(true));
  const lidBack = useAnimatedStyle(lidMotion(false));
  // Vändningen: telefonen trycks ihop på höjden till en kant och vecklas ut
  // med andra sidan upp, och lyfts lite medan den vänds.
  const phone = useAnimatedStyle(() => ({
    // Medan telefonen är lyft ur scenen och står upprätt (`lifted`) syns den
    // inte här — den är attrappen framför lådan.
    opacity: interpolate(phoneY.value, [PHONE_AWAY, -12], [0, 1], 'clamp')
      * (1 - lifted.value * interpolate(morph.value, [0, MORPH_FADE], [0, 1], 'clamp')),
    transform: [
      { translateY: (phoneY.value - 14 * Math.sin(Math.PI * flip.value)) * k },
      { rotate: `${interpolate(phoneY.value, [PHONE_AWAY, 0], [-5, 0], 'clamp')}deg` },
      { scaleY: Math.max(0.04, Math.abs(Math.cos(Math.PI * flip.value))) },
    ],
  }));
  // Attrappen framför lådan. Lyfts telefonen ur lådan (`hover`) när den
  // visas, är attrappen den telefonen: den börjar på telefonens plats,
  // liggande och platt, och reser sig upprätt (`morph`). Annars tonar den in.
  const peekW = width * 0.36;
  const peekH = peekW * 2.1;
  const [peek, setPeek] = useState<PodAppView | null>(state.app === 'none' ? null : state.app);
  const [fromPhone, setFromPhone] = useState(false);
  const fromPhoneRef = useRef(false);
  useEffect(() => {
    if (state.app !== 'none') {
      if (!peek) {
        const lift = state.phone === 'hover';
        fromPhoneRef.current = lift;
        setFromPhone(lift);
        if (lift) {
          lifted.value = 1;
          morph.value = 0;
          morph.value = withTiming(1, { duration: reduce ? 0 : MORPH_MS, easing: EASE });
        }
      }
      setPeek(state.app);
      return;
    }
    if (!peek) return;
    if (!fromPhoneRef.current) { setPeek(null); return; }
    // Tillbaka: attrappen lägger sig platt på telefonens plats, och sedan är
    // det telefonen i scenen igen.
    morph.value = withTiming(0, { duration: reduce ? 0 : MORPH_MS, easing: EASE }, done => {
      if (!done) return;
      lifted.value = 0;
      runOnJS(setPeek)(null);
    });
    // `peek` läses bara för att veta om attrappen redan står framme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.app]);

  // Var telefonen i scenen står på skärmen, i vila: p' = mitten + S(p - fokus).
  const phoneX = width / 2 + REST * (ART.phoneCenter[0] - REST_FOCUS[0]) * k;
  const phoneY0 = height / 2 + REST * (ART.phoneCenter[1] - REST_FOCUS[1]) * k;
  const lenPx = ART.phoneLength * k * REST;
  const depthPx = ART.phoneDepth * k * REST;
  // Liggande är attrappen lika lång som telefonen i scenen (`flatScale`), och
  // den lutar bakåt i perspektiv tills den är lika platt (`flatTilt`): en
  // telefon som läggs ner i handen, inte en bild som trycks ihop.
  const flatScale = lenPx / peekH;
  const flatTilt = (Math.acos(Math.min(1, depthPx / (peekW * flatScale))) * 180) / Math.PI;
  // Den sista biten (`MORPH_FADE`) tonar attrappen och telefonen i scenen i
  // varandra, i stället för att byta på en bildruta.
  const morphTilt = useAnimatedStyle(() => {
    const m = morph.value;
    return {
      opacity: interpolate(m, [0, MORPH_FADE], [0, 1], 'clamp'),
      transform: [
        { translateX: (1 - m) * (phoneX - width / 2) },
        { translateY: (1 - m) * (phoneY0 - height / 2) },
        { perspective: peekH * 3 },
        { rotateX: `${flatTilt * (1 - m)}deg` },
      ],
    };
  });
  const morphTurn = useAnimatedStyle(() => {
    const m = morph.value;
    return {
      transform: [
        { rotate: `${-90 * (1 - m)}deg` },
        { scale: interpolate(m, [0, 1], [flatScale, 1]) },
      ],
    };
  });
  const dimStyle = useAnimatedStyle(() => ({ opacity: 0.45 * morph.value }));

  const phoneBack = useAnimatedStyle(() => ({ opacity: flip.value < 0.5 ? 1 : 0 }));
  const phoneFront = useAnimatedStyle(() => ({ opacity: flip.value < 0.5 ? 0 : 1 }));

  const layer = (region: readonly number[], prims: Prim[]) => (
    <ArtLayer uid={uid} k={k} region={region} prims={prims} />
  );
  const box = (region: readonly number[]) => ({
    position: 'absolute' as const,
    left: region[2] * k,
    top: region[0] * k,
    width: (region[3] - region[2]) * k,
    height: (region[1] - region[0]) * k,
  });

  // Displayen: ritad i den storlek den har i vila, så att texten är skarp.
  const scr = ART.screen;
  const big = REST;
  const dispW = scr.w * k * big;
  const dispH = scr.h * k * big;

  return (
    <View
      style={{ width, height, overflow: 'hidden' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          { position: 'absolute', width: cw, height: ch, left: (width - cw) / 2, top: (height - ch) / 2 },
          camera,
        ]}
      >
        <Animated.View style={[box(REGION.lid), lidBack]}>{layer(REGION.lid, ART.lid)}</Animated.View>
        <View style={box(REGION.base)}>{layer(REGION.base, [...ART.shadow, ...ART.interior])}</View>
        <Animated.View style={[box(REGION.phone), phone]}>
          <Animated.View style={[StyleSheet.absoluteFill, phoneBack]}>
            {layer(REGION.phone, ART.phone)}
            <Animated.View style={[StyleSheet.absoluteFill, glowStyle]}>{layer(REGION.phone, ART.tagGlow)}</Animated.View>
            <Animated.View
              style={[
                {
                  position: 'absolute',
                  left: (REGION.tag[2] - REGION.phone[2]) * k,
                  top: (REGION.tag[0] - REGION.phone[0]) * k,
                  width: tagW,
                  height: tagH,
                },
                stickerWrap,
              ]}
            >
              {/* Det som redan sitter fast: dekalen urklippt fram till kontaktlinjen. */}
              <Animated.View style={[{ position: 'absolute', left: 0, top: 0, height: tagH, overflow: 'hidden' }, stuckStyle]}>
                {layer(REGION.tag, ART.tag)}
              </Animated.View>
              {/* Den lösa fliken: resten, vriden upp kring linjen. */}
              <Animated.View
                style={[{ position: 'absolute', top: 0, height: tagH, overflow: 'hidden', transformOrigin: 'left center' }, flapStyle]}
              >
                <Animated.View style={[{ width: tagW, height: tagH }, flapInner]}>
                  {layer(REGION.tag, ART.tag)}
                </Animated.View>
              </Animated.View>
            </Animated.View>
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, phoneFront]}>{layer(REGION.phone, ART.phoneFront)}</Animated.View>
        </Animated.View>
        <View style={box(REGION.base)}>{layer(REGION.base, ART.body)}</View>
        <View
          style={{
            position: 'absolute',
            left: scr.x * k + (scr.w * k - dispW) / 2,
            top: scr.y * k + (scr.h * k - dispH) / 2,
            width: dispW,
            height: dispH,
            transform: [{ scale: 1 / big }],
          }}
        >
          <PodScreen id={state.screen} width={dispW} height={dispH} name={name} />
          <Glare w={dispW} h={dispH} />
        </View>
        <Animated.View style={[box(REGION.lid), lidFront]}>{layer(REGION.lid, ART.lid)}</Animated.View>
      </Animated.View>
      {peek && (fromPhone ? (
        // Telefonen som hålls ovanför lådan är samma telefon: attrappen börjar
        // som den, platt och liggande, och reser sig mot betraktaren.
        <View style={[StyleSheet.absoluteFill, styles.peek]} pointerEvents="none">
          <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
          <Animated.View style={morphTilt}>
            <Animated.View style={morphTurn}>
              <PodAppPeek view={peek} width={peekW} name={name} />
            </Animated.View>
          </Animated.View>
        </View>
      ) : (
        <Animated.View
          entering={FadeIn.duration(400)}
          exiting={FadeOut.duration(400)}
          style={[StyleSheet.absoluteFill, styles.peek]}
        >
          <View style={[StyleSheet.absoluteFill, styles.dim]} />
          <Animated.View entering={FadeInDown.duration(600).delay(100)}>
            <PodAppPeek view={peek} width={peekW} name={name} />
          </Animated.View>
        </Animated.View>
      ))}
    </View>
  );
}

/** Kamerans läge. Fokuspunkten hamnar i mitten: p' = c + T + S(p - c) ⇒ T = S(c - f). */
function cameraFor(zoom: PodZoom, cw: number, ch: number, k: number) {
  const S = zoom === 'phone' ? PHONE_ZOOM : REST;
  const f = zoom === 'phone' ? ART.phoneFocus : REST_FOCUS;
  return { s: S, tx: S * (cw / 2 - f[0] * k), ty: S * (ch / 2 - f[1] * k) };
}

function phoneTarget(p: PodPhone) {
  return p === 'away' ? PHONE_AWAY : p === 'hover' ? 0 : PHONE_DROP;
}

/** Ett lager av ritningen, i en egen svg som bara täcker sin ruta. */
function ArtLayer({ uid, k, region, prims }: { uid: string; k: number; region: readonly number[]; prims: Prim[] }) {
  const [y0, y1, x0, x1] = region;
  const content = useMemo(() => {
    const used = new Set<string>();
    for (const p of prims) {
      const m = p.fill?.match(/^url\(#(.+)\)$/);
      if (m) used.add(m[1]);
    }
    return { grads: ART.grads.filter(g => used.has(g.id)) };
  }, [prims]);
  const ref = (fill?: string) => (fill?.startsWith('url(#') ? fill.replace('url(#', `url(#${uid}`) : fill);
  return (
    <Svg width={(x1 - x0) * k} height={(y1 - y0) * k} viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`}>
      <Defs>{content.grads.map(g => <GradDef key={g.id} g={g} uid={uid} />)}</Defs>
      {prims.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          fill={ref(p.fill) ?? 'none'}
          fillRule={p.evenOdd ? 'evenodd' : 'nonzero'}
          stroke={p.stroke}
          strokeWidth={p.sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={p.opacity}
        />
      ))}
    </Svg>
  );
}

function GradDef({ g, uid }: { g: Grad; uid: string }): ReactNode {
  const stops = g.stops.map(([o, c, a], i) => <Stop key={i} offset={o} stopColor={c} stopOpacity={a ?? 1} />);
  if (g.kind === 'linear') {
    return (
      <LinearGradient id={uid + g.id} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
        {stops}
      </LinearGradient>
    );
  }
  return (
    <RadialGradient id={uid + g.id} gradientUnits="userSpaceOnUse" cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry}>
      {stops}
    </RadialGradient>
  );
}

const styles = StyleSheet.create({
  peek: { alignItems: 'center', justifyContent: 'center' },
  // Lådan träder tillbaka medan telefonen står framme.
  dim: { backgroundColor: '#03060e', opacity: 0.45 },
});

/**
 * Ovanpå skärmens innehåll: skuggan som ramen kastar ner på den nedsänkta
 * skärmen (överkant och vänsterkant, där ramen står närmast), och ett svagt
 * snett ljus i glaset.
 */
function Glare({ w, h }: { w: number; h: number }) {
  const shade = Math.min(w, h) * 0.22;
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="podShadeTop" x1="0" y1="0" x2="0" y2={shade} gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.75} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="podShadeLeft" x1="0" y1="0" x2={shade * 0.8} y2="0" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#000000" stopOpacity={0.6} />
          <Stop offset="1" stopColor="#000000" stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={`M0 0H${w}V${shade}H0Z`} fill="url(#podShadeTop)" />
      <Path d={`M0 0H${shade * 0.8}V${h}H0Z`} fill="url(#podShadeLeft)" />
      <Path d={`M${w * 0.08} 0L${w * 0.42} 0L${w * 0.18} ${h}L${-w * 0.16} ${h}Z`} fill="#ffffff" opacity={0.045} />
      <Path d={`M${w * 0.5} 0L${w * 0.56} 0L${w * 0.32} ${h}L${w * 0.26} ${h}Z`} fill="#ffffff" opacity={0.03} />
    </Svg>
  );
}
