import { useCallback, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { RoomName, roomMode, roomPalette, ThemeMode } from '../constants/appTheme';
import { useRoom, useTheme } from '../contexts/ThemeContext';

/**
 * Bakgrunden bakom varje flikskärm — fyra lager, inget av dem interaktivt.
 *
 * Det här var det första stället i appen som använde react-native-svg (det
 * andra är vågytan i [liquid-bars.tsx](liquid-bars.tsx), en kurva), och
 * därmed ett undantag från regeln som
 * [components/progress-ring.tsx](progress-ring.tsx) och
 * [components/circle-level-badge.tsx](circle-level-badge.tsx) står under:
 * ingen native-modul för ett enda element. Skälet att undantaget är värt en ny
 * dev-build är att det inte *är* ett element — det är botten i alla tre
 * flikarna, och tre av de fyra lagren är toningar som inte går att rita för hand
 * utan att banda. Ringen och nivåmärkena ritas fortfarande med View-ar och rörs
 * inte: de är former, inte toningar, och en form går att bygga av kanter.
 *
 * Ordningen underifrån är bg → himmel → glöd → vinjett: bottnen är en vanlig
 * `backgroundColor`, de tre toningarna ligger i ett enda `Svg` ovanpå den, och
 * vinjetten ritas sist eftersom den ska mörkna allt under sig.
 *
 * Här låg förr ett femte lager — "dust in lamplight", fjorton prickar som steg
 * uppåt — och det är borttaget. Det bodde mellan glöden och vinjetten, och det
 * är därför toningarna en gång låg i *två* `Svg`: prickarna var View-ar och
 * måste ligga emellan. Utan dem finns ingen anledning till skarven, så lagren
 * är ett `Svg` igen. Vill någon ha rörelse här är det en ny funktion, och
 * frågan att svara på först är varför en app som ber dig lägga ifrån dig
 * telefonen ska ha något som rör sig i bakgrunden.
 */

// ── Himlen ─────────────────────────────────────────────────────────────────
// Toppkulör vid 0%, genomskinligt vid 46%, bottenkulör vid 100%. Alfan sitter
// som stopOpacity och inte i färgen, så att de två ändarna delar samma tal.
const SKY: Record<ThemeMode, Record<RoomName, { top: string; bottom: string }>> = {
  dark: {
    pause: { top: 'rgb(70,100,200)', bottom: 'rgb(46,134,222)' },
    circle: { top: 'rgb(70,140,165)', bottom: 'rgb(92,201,143)' },
    friends: { top: 'rgb(165,105,70)', bottom: 'rgb(232,168,124)' },
    // Samma himmel som `pause` med flit — se kommentaren vid ROOMS i
    // constants/appTheme.ts. Rummets mörkare botten under samma himmel ger
    // ett mörkare resultat utan ett andra par tal att hålla i takt.
    study: { top: 'rgb(70,100,200)', bottom: 'rgb(46,134,222)' },
    // Natten: kanterna mörkare än mitten, där glöden tar över — samma form
    // som nattbilden i designreferensen (#0b1630 → #0f2048 → #08122a).
    night: { top: 'rgb(6,12,30)', bottom: 'rgb(5,11,26)' },
  },
  light: {
    pause: { top: 'rgb(120,175,245)', bottom: 'rgb(46,134,222)' },
    circle: { top: 'rgb(140,195,215)', bottom: 'rgb(35,132,90)' },
    friends: { top: 'rgb(240,205,175)', bottom: 'rgb(157,85,32)' },
    study: { top: 'rgb(170,200,245)', bottom: 'rgb(46,134,222)' },
    // Läses aldrig: natten ritas alltid i mörkt läge (roomMode).
    night: { top: 'rgb(6,12,30)', bottom: 'rgb(5,11,26)' },
  },
};

const SKY_OPACITY: Record<ThemeMode, number> = { dark: 0.3, light: 0.32 };

// ── Glöden ─────────────────────────────────────────────────────────────────
// Två mjuka radialer. Den första ligger ungefär bakom dagsringen på Hem, den
// andra utanför nedre högra hörnet — båda med sin mittpunkt delvis utanför
// skärmen, så att det som syns är kanten av ett ljus och inte en fläck.
//
// Talen nedan är **delade mellan rummen** och svala, vilket var oproblematiskt
// så länge varje rum var svalt. Sedan Friends blev varmt är det inte det: ett
// blått ljus på en varmbrun botten är komplementfärger, och komplementfärger
// blandar mot *grått*. Glöden hade grånat precis den botten den skulle lyfta.
//
// Därför får ett rum skriva över ljuset, och `ROOM_*`-tabellerna innehåller
// bara de rum som gör det. Allt som inte står där faller tillbaka på det
// delade förvalet, så de svala rummen är oförändrade till sista decimalen.
type GlowSpec = { color: string; opacity: number };
type RoomKey = `${ThemeMode}:${RoomName}`;

const GLOW_1: Record<ThemeMode, GlowSpec> = {
  dark: { color: 'rgb(70,150,235)', opacity: 0.17 },
  light: { color: 'rgb(46,134,222)', opacity: 0.17 },
};
const ROOM_GLOW_1: Partial<Record<RoomKey, GlowSpec>> = {
  // Pause i ljust läge var platt: ett tydligare blått ljus bakom ringen.
  'light:pause': { color: 'rgb(47,136,224)', opacity: 0.3 },
  'dark:friends': { color: 'rgb(235,160,110)', opacity: 0.17 },
  'light:friends': { color: 'rgb(200,120,60)', opacity: 0.15 },
  // Nattens ljus är det som gör mitten ljusare än kanterna, och är därför
  // starkare än de andra rummens. Blått mot blått — inte Friends-problemet.
  'dark:night': { color: 'rgb(29,58,122)', opacity: 0.6 },
};

const GLOW_2: Record<ThemeMode, GlowSpec> = {
  dark: { color: 'rgb(162,155,254)', opacity: 0.08 },
  light: { color: 'rgb(150,130,230)', opacity: 0.1 },
};
const ROOM_GLOW_2: Partial<Record<RoomKey, GlowSpec>> = {
  'dark:friends': { color: 'rgb(214,140,90)', opacity: 0.08 },
  'light:friends': { color: 'rgb(205,135,80)', opacity: 0.1 },
  'dark:night': { color: 'rgb(29,58,122)', opacity: 0.25 },
};

// ── Topp och botten ──
// En vågrät mörkning uppifrån och nedifrån, på begäran, för Pause-rummet och
// sedan för Circle och Support (`friends`). Vinjetten nedan är en ellips och
// mörknar mest hörnen; den här ramar in sidan ovanför och under, där topbaren
// och flikraden står. Kulören är rummets egen i mörkt — mörkgrön respektive
// mörk terrakotta — och inte svart, så att kanten fördjupar rummet i stället
// för att gråna det.
type EdgeSpec = { color: string; top: number; bottom: number };
const ROOM_EDGES: Partial<Record<RoomKey, EdgeSpec>> = {
  'dark:pause': { color: 'rgb(2,5,14)', top: 0.55, bottom: 0.6 },
  'light:pause': { color: 'rgb(10,19,48)', top: 0.16, bottom: 0.2 },
  'dark:circle': { color: 'rgb(4,30,18)', top: 0.55, bottom: 0.6 },
  'light:circle': { color: 'rgb(12,66,40)', top: 0.18, bottom: 0.22 },
  'dark:friends': { color: 'rgb(38,13,4)', top: 0.55, bottom: 0.6 },
  'light:friends': { color: 'rgb(104,44,14)', top: 0.18, bottom: 0.22 },
};

// ── Vinjetten ──────────────────────────────────────────────────────────────
// Genomskinligt inifrån, glöden som mellanstopp, kantfärgen ytterst. Tre stopp
// och inte två: utan mellanstoppet går mitten rakt till kanten och ytan blir en
// platt mörkning i stället för ett ljus med en skugga runt.
type VignetteSpec = { glow: string; glowOpacity: number; edge: string; edgeOpacity: number };

const VIGNETTE: Record<ThemeMode, VignetteSpec> = {
  dark: { glow: 'rgb(70,150,235)', glowOpacity: 0.14, edge: 'rgb(0,0,0)', edgeOpacity: 0.62 },
  light: { glow: 'rgb(46,134,222)', glowOpacity: 0.16, edge: 'rgb(70,45,60)', edgeOpacity: 0.18 },
};
// Se ROOM_GLOW_1. Kanten i ljusläget är varmbrun i stället för plommon av
// samma skäl som glöden byter: en sval kant runt en varm botten syns som en
// smutsrand, inte som en skugga.
const ROOM_VIGNETTE: Partial<Record<RoomKey, VignetteSpec>> = {
  // En sval kant i navy i stället för plommon, så att den blå ytan får djup.
  'light:pause': { glow: 'rgb(47,136,224)', glowOpacity: 0.18, edge: 'rgb(10,19,48)', edgeOpacity: 0.16 },
  'dark:friends': { glow: 'rgb(235,160,110)', glowOpacity: 0.14, edge: 'rgb(0,0,0)', edgeOpacity: 0.62 },
  'light:friends': { glow: 'rgb(200,120,60)', glowOpacity: 0.16, edge: 'rgb(80,50,30)', edgeOpacity: 0.18 },
  'dark:night': { glow: 'rgb(15,32,72)', glowOpacity: 0.3, edge: 'rgb(0,0,0)', edgeOpacity: 0.55 },
};

/**
 * Skalet varje flikskärm ligger i: bakgrunden absolut bakom, innehållet ovanpå.
 * Delad härifrån och inte skriven tre gånger — det är ett tal, men det är
 * *samma* tal, och en flik med ett annat hade tappat sin botten.
 */
export const roomShell = { flex: 1 } as const;

export function ScreenBackground({ room }: { room?: RoomName }) {
  const { mode: requestedMode } = useTheme();
  const contextRoom = useRoom();

  /**
   * Måtten **mäts** och gissas inte.
   *
   * `absoluteFill` fyller sin *förälder*, medan `useWindowDimensions()`
   * rapporterar *fönstret*, och på Android med `edgeToEdgeEnabled` är de två
   * inte samma sak: skärmen ritar bakom systemets navigeringsfält, men
   * fönsterhöjden räknar inte in insetet. Svg:n blev därför för kort och
   * lämnade ett band längst ner — ovanför systemknapparna — där varken himlen
   * eller vinjetten nådde. Eftersom det är just vinjetten som mörknar kanten
   * syntes bandet som en ljus remsa mot den mörknade ytan ovanför, och i
   * ljusläget som en vit kant.
   *
   * Flikarna hade samma fel åt andra hållet (Svg:n var *högre* än ytan,
   * eftersom flikraden tar sin del) och vinjettens nederkant klipptes bort
   * utanför skärmen. Det syntes inte, men det var samma bugg.
   *
   * Fönstret är bara startvärdet, så att första framen inte står omålad innan
   * `onLayout` hunnit mäta.
   */
  const win = useWindowDimensions();
  const [size, setSize] = useState({ w: win.width, h: win.height });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    // Jämförelsen är vad som gör den här setState:en ofarlig: utan den
    // renderar varje layout om komponenten, och varje omrendering utlöser en
    // ny layout.
    setSize(p => (p.w === width && p.h === height ? p : { w: width, h: height }));
  }, []);
  const W = size.w;
  const H = size.h;

  // Propen vinner över kontexten, men kontexten räcker: skärmarna skickar
  // rummet explicit för att den som läser JSX:en ska se vilket rum det är.
  const active: RoomName = room ?? contextRoom ?? 'pause';
  // Natten har bara ett läge — se NIGHT i constants/appTheme.ts.
  const mode = roomMode(requestedMode, active);

  const sky = SKY[mode][active];
  const skyOpacity = SKY_OPACITY[mode];
  // Rummets eget ljus om det har ett, annars det delade.
  const roomKey: RoomKey = `${mode}:${active}`;
  const glow1 = ROOM_GLOW_1[roomKey] ?? GLOW_1[mode];
  const glow2 = ROOM_GLOW_2[roomKey] ?? GLOW_2[mode];
  const vignette = ROOM_VIGNETTE[roomKey] ?? VIGNETTE[mode];
  const edges = ROOM_EDGES[roomKey];
  const bg = roomPalette(mode, active).bg;

  // Glöd 1: en cirkel på 330 px vars ruta börjar 30 px utanför vänsterkanten
  // och 76 px ner. Mittpunkten hamnar därmed en bit in på skärmen och en bit
  // ner — ungefär bakom dagsringen på Hem.
  const g1r = 330 / 2;
  const g1x = -30 + g1r;
  const g1y = 76 + g1r;

  // Glöd 2: 240 px, 70 px förbi högerkanten och 150 px upp från nederkanten.
  const g2r = 240 / 2;
  const g2x = W + 70 - g2r;
  const g2y = H - 150 - g2r;

  // Vinjetten är en ellips och inte en cirkel: 85 % av bredden och 75 % av
  // höjden som radier, centrerad 42 % ner. `rx`/`ry` på RadialGradient är
  // react-native-svgs egen utvidgning och gör att ingen gradientTransform
  // behövs.
  const vx = W / 2;
  const vy = H * 0.42;
  const vrx = W * 0.85;
  const vry = H * 0.75;

  return (
    <View
      style={[StyleSheet.absoluteFill, { backgroundColor: bg }]}
      pointerEvents="none"
      onLayout={onLayout}
    >
      <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor={sky.top} stopOpacity={skyOpacity} />
            {/* Två stopp på samma offset, båda med alfa 0. Ett enda
                "transparent" hade behövt en kulör, och den kulören lyser igenom
                halva övergången: går den mot svart gråmulnar mitten, går den mot
                grannen drar den fel håll på andra sidan. Vid alfa 0 är skarven
                osynlig. */}
            <Stop offset={0.46} stopColor={sky.top} stopOpacity={0} />
            <Stop offset={0.46} stopColor={sky.bottom} stopOpacity={0} />
            <Stop offset={1} stopColor={sky.bottom} stopOpacity={skyOpacity} />
          </LinearGradient>

          <RadialGradient id="glow1" cx={g1x} cy={g1y} r={g1r} gradientUnits="userSpaceOnUse">
            <Stop offset={0} stopColor={glow1.color} stopOpacity={glow1.opacity} />
            <Stop offset={0.68} stopColor={glow1.color} stopOpacity={0} />
          </RadialGradient>

          <RadialGradient id="glow2" cx={g2x} cy={g2y} r={g2r} gradientUnits="userSpaceOnUse">
            <Stop offset={0} stopColor={glow2.color} stopOpacity={glow2.opacity} />
            <Stop offset={0.7} stopColor={glow2.color} stopOpacity={0} />
          </RadialGradient>

          <RadialGradient
            id="vignette"
            cx={vx}
            cy={vy}
            rx={vrx}
            ry={vry}
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset={0.38} stopColor={vignette.glow} stopOpacity={0} />
            <Stop offset={0.72} stopColor={vignette.glow} stopOpacity={vignette.glowOpacity} />
            <Stop offset={1} stopColor={vignette.edge} stopOpacity={vignette.edgeOpacity} />
          </RadialGradient>
          {edges && (
            <LinearGradient id="edges" x1="0" y1="0" x2="0" y2="1">
              <Stop offset={0} stopColor={edges.color} stopOpacity={edges.top} />
              <Stop offset={0.24} stopColor={edges.color} stopOpacity={0} />
              <Stop offset={0.72} stopColor={edges.color} stopOpacity={0} />
              <Stop offset={1} stopColor={edges.color} stopOpacity={edges.bottom} />
            </LinearGradient>
          )}
        </Defs>

        {/* Ritordningen är lagerordningen: himlen, de två glöden, och
            vinjetten sist eftersom den ska mörkna allt under sig. */}
        <Rect x={0} y={0} width={W} height={H} fill="url(#sky)" />
        <Rect x={0} y={0} width={W} height={H} fill="url(#glow1)" />
        <Rect x={0} y={0} width={W} height={H} fill="url(#glow2)" />
        <Rect x={0} y={0} width={W} height={H} fill="url(#vignette)" />
        {edges && <Rect x={0} y={0} width={W} height={H} fill="url(#edges)" />}
      </Svg>
    </View>
  );
}
