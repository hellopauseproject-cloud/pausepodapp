// Delat visuellt designsystem för hela appen. Rena värden, inga komponenter
// — varje skärm bygger sin egen StyleSheet men hämtar färger/mått härifrån
// så utseendet hänger ihop mellan sidor.
//
// Sedan ljusläget finns är paletten inte längre en konstant utan **två**
// paletter med identiska nycklar, och skärmarnas StyleSheet byggs av en
// `makeStyles(Palette)` som `usePalette()` matar. Se contexts/ThemeContext.tsx.
// Måtten (Radius/Spacing) är däremot fortfarande konstanter — bara färg byter
// läge, aldrig layout.

// ---------------------------------------------------------------------------
// Ink-skalan
//
// Nästan all genomskinlig färg i appen var `rgba(255,255,255,a)`: vit text och
// vita hårstreck ovanpå en mörk botten. I ljusläget måste exakt samma ytor bli
// mörk bläck på ljus botten, så varje sådan nivå har fått ett namn i stället
// för att stå som literal ute i skärmarna.
//
// Alfavärdena är *inte* speglade rakt av. Under ~0.30 är nivåerna ytor och
// kantlinjer, och svart bläck biter hårdare på vitt än vitt gör på svart — de
// nivåerna tonas därför ned i ljusläget. Över ~0.30 är de text, där samma
// alfa ger ungefär samma upplevda kontrast åt båda håll.
//
// Bläcket är inte heller rent vitt eller rent svart. De två paletterna är ett
// **par**: mörklägets bläck är ljuslägets papper (gräddvitt), och ljuslägets
// bläck är plommonbrunt. Det är därför ingen yta i appen är kulörlös — ett
// grått hårstreck på en plommonbotten ser ut som smuts, medan samma streck i
// gräddton läser som en skugga av papperet.
// ---------------------------------------------------------------------------

const darkInk = (a: number) => `rgba(255,244,236,${a})`;
const lightInk = (a: number) => `rgba(42,31,40,${a})`;

const darkInks = {
  ink02: darkInk(0.02),
  ink04: darkInk(0.04),
  ink05: darkInk(0.05),
  ink06: darkInk(0.06),
  ink07: darkInk(0.07),
  ink08: darkInk(0.08),
  ink10: darkInk(0.1),
  ink12: darkInk(0.12),
  ink15: darkInk(0.15),
  ink18: darkInk(0.18),
  ink20: darkInk(0.2),
  ink22: darkInk(0.22),
  ink25: darkInk(0.25),
  ink28: darkInk(0.28),
  ink30: darkInk(0.3),
  ink35: darkInk(0.35),
  ink40: darkInk(0.4),
  ink45: darkInk(0.45),
  ink50: darkInk(0.5),
  ink55: darkInk(0.55),
  ink60: darkInk(0.6),
  ink70: darkInk(0.7),
  ink80: darkInk(0.8),
  ink85: darkInk(0.85),
  ink90: darkInk(0.9),
};

const lightInks: typeof darkInks = {
  ink02: lightInk(0.03),
  ink04: lightInk(0.04),
  ink05: lightInk(0.05),
  ink06: lightInk(0.055),
  ink07: lightInk(0.06),
  ink08: lightInk(0.07),
  ink10: lightInk(0.08),
  ink12: lightInk(0.1),
  ink15: lightInk(0.12),
  ink18: lightInk(0.14),
  ink20: lightInk(0.16),
  ink22: lightInk(0.18),
  ink25: lightInk(0.2),
  ink28: lightInk(0.24),
  ink30: lightInk(0.42),
  ink35: lightInk(0.5),
  ink40: lightInk(0.55),
  ink45: lightInk(0.6),
  ink50: lightInk(0.65),
  ink55: lightInk(0.7),
  ink60: lightInk(0.75),
  ink70: lightInk(0.78),
  ink80: lightInk(0.85),
  ink85: lightInk(0.9),
  ink90: lightInk(0.93),
};

const darkBase = {
  mode: 'dark' as 'dark' | 'light',

  bg: '#1a141b',
  surface: '#271f28',
  surfaceAlt: '#2f2630',
  surfaceBorder: darkInk(0.09),
  // Den djupaste ytan: modalers botten och skärmar som vill ligga under bg.
  sunken: '#120d12',

  accent: '#2e86de',
  accentTint: 'rgba(46,134,222,0.12)',
  accentBorder: 'rgba(46,134,222,0.5)',
  // Ljusare systerton till accenten — staplar, diagram och wrapped-siffror.
  accentSoft: '#5ba8f5',
  accentSoftTint: 'rgba(91,168,245,0.2)',
  accentPale: '#7ab8f5',
  // Text/ikon ovanpå en accentfylld yta. Vit i båda lägena: accenten byter
  // aldrig ton, så det som ligger på den byter aldrig heller.
  onAccent: '#ffffff',

  // Rummets kulör — se ROOMS längre ner. Förvalet *är* accenten, så varje
  // skärm utanför flikarna ser ut precis som förut.
  hue: '#2e86de',
  hueTint: 'rgba(46,134,222,0.16)',

  // ── Modalytan ───────────────────────────────────────────────────────────
  // Varje modal i appen ligger på den här, och den är **blå i alla rum** —
  // till skillnad från `surface`, som rummet byter. Det är avsiktligt: en
  // modal är inte en del av rummet bakom sig utan ett lager framför det, och
  // en egen kulör är vad som säger det. Att den dessutom är *ljusare* än varje
  // rums botten och yta är hela kontrasten — en modal som är lika mörk som
  // sidan under den ser ut som en del av sidan.
  //
  // Ljusare och blå gäller båda lägena: i mörkt läge en tydligt uppljusad
  // navy, i ljust läge nästan vitt med en blå ton, ljusare än varje ljus
  // rumsbotten.
  modalSurface: '#3a2e3b',

  // Stödets egen kulör och dess systrar. Var lila (`#a29bfe`) och är varm
  // kakaobrun sedan Friends-rummet blev varmt — den bär stöd-storyn, plusset,
  // ringarna och pillren för svarsformat, och alla de ytorna bor i det rummet.
  // Nyckeln heter fortfarande `community` av samma skäl som förr: det är en
  // kulör och inte en rubrik, och ett namnbyte hade rört varenda stödyta utan
  // att någon läst något nytt.
  //
  // Den är **brunare och mörkare än rummets `hue`** (dE ≈ 16) så att en
  // story-ring har en egen kant mot en terrakotta sektionsrubrik. Det gamla
  // lila paret behövde ingen sådan marginal — i ljust läge var `community`
  // och rummets hue *samma* `#6c5ce7` — men två bruna toner intill varandra
  // smälter ihop på ett sätt två lila inte gjorde.
  community: '#bf8469',
  communityTint: 'rgba(191,132,105,0.15)',
  communitySoft: '#d9a991',
  // Vänner/stöd: dämpad grön för "din egen" story, röd för avböj.
  peer: '#7aaa8a',
  peerDeep: '#5a8a6a',

  success: '#27ae60',
  danger: '#e74c3c',
  dangerSoft: '#ff7675',
  warning: '#f39c12',
  highlight: '#f9ca24',

  textPrimary: '#fbf4ee',
  textSecondary: darkInk(0.6),
  // Var 0.40 och gav 3.42:1 mot den ljusaste ytan i appen — under AA, och
  // rapporterat som text "som försvinner lite i bakgrunden". 0.52 är det
  // första steget som klarar 4.5:1 överallt (4.77 i värsta fallet).
  // Starkare bläck, inte mörkare: i mörkt läge betyder "tydligare" ljusare.
  textTertiary: darkInk(0.52),
  textDisabled: darkInk(0.2),
  // Dämpad blågrå brödtext som låg som #5a7fa8/#7a9aba ute i skärmarna.
  textMuted: '#5a7fa8',
  textFaint: '#555',

  divider: darkInk(0.09),
  // Bakgrunden bakom en modal. Mörkare än bg i båda lägena.
  scrim: 'rgba(0,0,0,0.6)',
  scrimStrong: 'rgba(0,0,0,0.72)',
  // Skuggfärg. Var en glödande accent i mörkt läge — en blå dis under varje
  // kort. Med plommonbotten är den en riktig skugga i båda lägena: nästan
  // svart med en droppe plommon i, så att den mörknar botten i stället för
  // att lägga en andra kulör ovanpå den.
  shadow: '#0d080d',
  shadowOpacity: 0.18,

  // Fältkanterna i tonade "status"-ytor (klart/pågår/misslyckat) som förr
  // stod som egna nästan-svarta hexar per skärm.
  tintBlue: '#0d1a2a',
  tintGreen: '#0d1a14',
  tintPurple: '#1a0d20',
  tintNeutral: '#13131f',

  // Wrapped-sidorna och circle-wrapped är helsidor med var sin egen ton. De
  // har ingen roll utöver 'den här sidans färg', men behöver ändå namn: i
  // ljusläget måste varenda en av dem mörkna för att synas mot blekt.
  slideAccent: {
    green: '#2ecc71',
    violet: '#9b59b6',
    teal: '#4fc3c7',
    orchid: '#d98cf0',
    rose: '#e8567c',
  },
  // Svara-knappen i ett inkommande samtal. Grönt betyder 'svara' överallt och
  // är undantaget från regeln att grönt hör lådan till.
  callAccept: '#2ecc71',

  ...darkInks,
};



const lightBase: typeof darkBase = {
  mode: 'light',

  // Varmt papper i stället för rent vitt: samma plommon som mörkläget, bara
  // uttvättat. Rent vitt sparas åt korten så de kan lyfta från bakgrunden.
  bg: '#f8f2f0',
  surface: '#ffffff',
  surfaceAlt: '#f1e8e6',
  surfaceBorder: lightInk(0.1),
  sunken: '#ebe0de',

  accent: '#2e86de',
  accentTint: 'rgba(46,134,222,0.1)',
  accentBorder: 'rgba(46,134,222,0.45)',
  // Systertonerna går åt andra hållet i ljusläget: mörkare än accenten, inte
  // ljusare, annars försvinner de mot vitt.
  accentSoft: '#1b6fc2',
  accentSoftTint: 'rgba(27,111,194,0.14)',
  accentPale: '#4a97e6',
  onAccent: '#ffffff',

  // Se mörklägets hue. Alfan är 0.13 och inte 0.16 av samma skäl som
  // ink-skalan är asymmetrisk: en ton biter hårdare på vitt än på svart.
  hue: '#2e86de',
  hueTint: 'rgba(46,134,222,0.13)',

  // Se mörkläget. Rent vitt hade inte varit blått, och en ljus rumsbotten är
  // redan nästan vit — den här är vitare än alla fyra, med en blå ton kvar.
  modalSurface: '#fffdfd',

  // Se mörkläget. Kastanjebrun, dE ≈ 18 från rummets `#9d5520`.
  community: '#80522f',
  communityTint: 'rgba(128,82,47,0.12)',
  communitySoft: '#9c6a45',
  peer: '#337555',
  peerDeep: '#2f6b4a',

  success: '#178549',
  danger: '#d0362a',
  dangerSoft: '#e05a53',
  warning: '#a8660a',
  highlight: '#8f6708',

  textPrimary: '#2a1f28',
  textSecondary: lightInk(0.64),
  // Se mörkläget. Ljust läge behöver mer: plommonbläck på ljust papper når
  // 4.5:1 först vid 0.66, så 0.68 (5.00:1 i värsta fallet).
  textTertiary: lightInk(0.68),
  textDisabled: lightInk(0.28),
  textMuted: '#4a6d94',
  textFaint: lightInk(0.45),

  divider: lightInk(0.1),
  scrim: lightInk(0.35),
  scrimStrong: lightInk(0.5),
  shadow: '#3c2836',
  shadowOpacity: 0.1,

  tintBlue: '#e4eefb',
  tintGreen: '#e2f2e9',
  tintPurple: '#eeeafc',
  tintNeutral: '#eceff5',

  slideAccent: {
    green: '#1e9e55',
    violet: '#7d4a9e',
    teal: '#17808a',
    orchid: '#a14fc0',
    rose: '#c8375e',
  },
  callAccept: '#1e9e55',

  ...lightInks,
};

// Härledda bitar som bara är färg satt i en form: de bor på paletten så att
// `...Palette.eyebrow` ska fungera inne i en makeStyles utan att skärmen
// behöver veta vilket läge som gäller.
/**
 * Samma kulör, svagare. Finns för alla tonade ytor som låg som en handskriven
 * `rgba(162,155,254,0.15)` ute i skärmarna: skrivet så följer tonen med när
 * grundfärgen byter läge, i stället för att frysa fast mörklägets kulör.
 * Tar `#rgb`/`#rrggbb`; allt annat (redan-rgba, namngivna färger) går igenom
 * orört hellre än att kasta mitt i en render.
 */
export const alpha = (color: string, a: number): string => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const derive = <T extends typeof darkBase>(p: T) => ({
  ...p,
  // Bokstavsmellanrum + versaler för små etiketter (eyebrows, sektionsrubriker).
  //
  // Kulören är rummets och inte `textTertiary`: sektionsrubrikerna är det som
  // säger vilket rum man står i, och de står på varje panel. Utanför flikarna
  // är `hue` accenten, så där blir de blå.
  // Designsystemets kicker: Arial Black, +0.2em.
  eyebrow: {
    fontSize: 12,
    fontWeight: '900' as const,
    color: p.hue,
    letterSpacing: 2.4,
    textTransform: 'uppercase' as const,
  },
  // Kräver en **opak** bakgrund på ytan den läggs på. Ligger den på ett
  // halvgenomskinligt fyll syns skuggan genom ytan i stället för under den, och
  // Android ritar därtill elevation som en fylld rektangel. Se modeButtonSelected
  // i app/pause.tsx, som fick skuggan borttagen av just det skälet.
  // Modalens hårstreck. Härledd ur `hue` och inte skriven per läge: då följer
  // den rummet av sig själv, och ett nytt rum kan inte glömma den. Starkare i
  // mörkt läge av samma skäl som ink-skalan är asymmetrisk.
  modalBorder: alpha(p.hue, p.mode === 'dark' ? 0.22 : 0.16),
  // Den tomma delen av en stapel som fylls (vätskestaplarna på Hem och i
  // Kretsen): rummets kulör, svag. Härledd av samma skäl som modalBorder.
  hueTrack: alpha(p.hue, 0.15),
  cardShadow: {
    shadowColor: p.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: p.shadowOpacity,
    shadowRadius: 16,
    elevation: 6,
  },
});

export const darkPalette = derive(darkBase);
export type AppPalette = typeof darkPalette;
export const lightPalette: AppPalette = derive(lightBase);

export const palettes = { dark: darkPalette, light: lightPalette };
export type ThemeMode = keyof typeof palettes;

// Modulnivåns förval. Finns kvar för kod som läser en färg utanför React
// (och som därför inte kan fråga efter läget) — allt som renderar ska gå via
// usePalette() i stället.
export const Palette = darkPalette;

// ---------------------------------------------------------------------------
// Rummen
//
// Varje flik har en egen kulör — sitt *rum* — och rummet byter exakt tre
// saker: `hue`, `bg` och `surface`. Allt annat är delat mellan rummen.
//
// `hue` är det som säger vilket rum man står i: logotypen, sektionsrubrikerna
// (`eyebrow`), den aktiva flikikonen, tonade ytor och förloppsstaplarna.
// **Accenten byter aldrig.** `#2e86de` är fortfarande färgen på det som är
// *ifyllt* — PAUSE-knappen, brickorna, dagsringen, de fyrkantiga ikonknapparna
// — i alla tre rummen och i båda lägena. Rummet är väggarna, accenten är
// möblerna, och det är den skillnaden som gör att appen känns som samma app
// trots att varje flik har sin färg.
//
// Förvalet (ingen room) är accenten rakt av, så varje skärm *utanför* flikarna
// ser ut precis som förut. Det är därför `hue` finns som en egen nyckel på
// bastabellen i stället för att rummen patchar `accent`: en ändring av
// accenten hade följt med in i de fyllda knapparna och tagit bort det enda
// som är gemensamt.
// ---------------------------------------------------------------------------

export type RoomName = 'pause' | 'circle' | 'friends' | 'study' | 'night';

type RoomTokens = {
  hue: string;
  bg: string;
  surface: string;
  /**
   * Den sekundära ytan, och den **måste** ligga i rummet.
   *
   * Basens `surfaceAlt` är plommon (`#2f2630` mörkt, `#f1e8e6` ljust — en
   * ljusbrun i ljusläget), och så länge rummen bara bytte `bg` och `surface`
   * satt den kvar som varma fläckar mitt i ett blått, grönt eller lila rum:
   * temaväljaren och kategoripillren i Settings, `declineBtn` och avatarernas
   * reservyta i Kretsen. Det var rapporterat som "ljusbruna färgkoder i
   * botten", och det var precis vad det var.
   *
   * Lutningsordningen är densamma i varje rum som i basen, och den är inte
   * densamma i de två lägena: mörkt går `sunken < bg < surface < surfaceAlt`
   * (den sekundära ytan är *ljusast*), ljust går
   * `sunken < surfaceAlt < bg < surface` (där är rent vitt högst och
   * surfaceAlt en indragen ton under botten). Bryts ordningen i ett rum ser
   * det ut som att två ytor bytt plats.
   */
  surfaceAlt: string;
  /** Den djupaste ytan. Oanvänd idag, men den får inte bli den enda nyckeln
   *  som halkar tillbaka till plommon den dag någon tar den i bruk. */
  sunken: string;
  /**
   * Modalernas yta, och den hör till rummet.
   *
   * Den var **en enda blå för hela appen**, med motiveringen att en modal är
   * ett lager framför rummet och inte en del av det. Det föll när Friends blev
   * varmt: en blå sheet med bruna valrader ovanpå ett varmbrunt rum hade tre
   * temperaturer i samma bild, och stödflödets egen kulör tappade dessutom
   * kontrast mot den. Logiken är i stället: **en modal tillhör rummet man
   * öppnade den från.**
   *
   * Det som bar den gamla motiveringen bärs redan av `Palette.scrim` — det är
   * mörkningen bakom kortet som säger "det här ligger framför", inte kulören.
   * Kvar av regeln är bara måttet: modalytan är **ljusare** än sitt eget rums
   * `bg` och (i mörkt läge) även än dess `surfaceAlt`, för en modal i samma
   * ton som sidan under ser ut som en del av sidan.
   */
  modalSurface: string;
};

/**
 * `night` är rummet medan en paus faktiskt pågår ([app/pausing.tsx](../app/pausing.tsx)),
 * och det enda rummet som **inte byter läge**: det är mörkt även i ljusläget.
 * Natten är själva poängen — skärmen säger "lägg ifrån dig mig" — och en ljus
 * variant hade varit ett annat rum. Därför läser `roomPalette` och
 * bakgrunden det alltid genom `roomMode()`, som svarar `dark`; annars hade
 * ljuslägets plommonbruna bläck hamnat på en marinblå botten.
 *
 * Ordningen följer mörklägets regel (`sunken < bg < surface < surfaceAlt`,
 * modalen ljusast). `hue` är ljusare än pause-rummets för att bära mot den
 * djupare botten. Accenten är densamma som överallt.
 */
const NIGHT: RoomTokens = {
  hue: '#8cbcff', bg: '#0b1630', surface: '#16244a', surfaceAlt: '#1d2d58', sunken: '#070f22', modalSurface: '#22346a',
};

/** Läget ett rum ritas i. Alltid `mode`, utom för `night` — se NIGHT. */
export const roomMode = (mode: ThemeMode, room: RoomName | null): ThemeMode =>
  room === 'night' ? 'dark' : mode;

const ROOMS: Record<ThemeMode, Record<RoomName, RoomTokens>> = {
  dark: {
    // PausePod-designsystemets natt: Navy 900 botten, Navy 800 paneler, Navy 700
    // linjer, Navy 950 djup och Sky 300 som rummets ljus.
    pause: { hue: '#9ccbff', bg: '#0a1330', surface: '#111c3f', surfaceAlt: '#1c2b58', sunken: '#060c1d', modalSurface: '#22346a' },
    circle: { hue: '#6cc99a', bg: '#141714', surface: '#1f2420', surfaceAlt: '#28302a', sunken: '#0d0f0d', modalSurface: '#324539' },
    friends: { hue: '#e8a87c', bg: '#1f1613', surface: '#2e211b', surfaceAlt: '#392a21', sunken: '#140e0b', modalSurface: '#4a3628' },
    study: { hue: '#9ccbff', bg: '#0b1221', surface: '#131d33', surfaceAlt: '#1b2742', sunken: '#070c17', modalSurface: '#213353' },
    night: NIGHT,
  },
  light: {
    pause: { hue: '#2e86de', bg: '#eaf2fc', surface: '#ffffff', surfaceAlt: '#dce8f8', sunken: '#cfdff3', modalSurface: '#fbfdff' },
    circle: { hue: '#23845a', bg: '#f2f3ea', surface: '#ffffff', surfaceAlt: '#e6e9d9', sunken: '#d9dec8', modalSurface: '#fdfefb' },
    friends: { hue: '#9d5520', bg: '#fbf3ec', surface: '#ffffff', surfaceAlt: '#f4e7da', sunken: '#ead9c9', modalSurface: '#fffdfa' },
    study: { hue: '#2e86de', bg: '#dde8f6', surface: '#ffffff', surfaceAlt: '#cfdef2', sunken: '#c1d4ec', modalSurface: '#f7fbff' },
    // Läses aldrig — se roomMode(). Står här för att tabellen ska vara hel.
    night: NIGHT,
  },
};

/**
 * **Friends är varmt, och det är inte en avvikelse utan en hemkomst.**
 *
 * Rummet var lila (`#b3a6ff` / `#6c5ce7`) och är nu mjuk terrakotta
 * (`#e8a87c` / `#9d5520`) på en varmbrun botten. Det ligger närmare basens
 * "Plommon härd" än lilan gjorde: bläcket *är* gräddvitt, och gräddvit text på
 * varmbrunt är det paret paletten redan bygger på. Att de tre andra rummen är
 * svala (blått, grönt, blått) ger dessutom Friends en egen temperatur snarare
 * än bara en egen kulör — det är den tydligaste skillnad en flik kan ha.
 *
 * I ljusläget är den varma brunen dessutom den **mest läsbara** `hue` i appen
 * (5.10:1 mot sin botten, mot 3.0–4.3 för de svala), eftersom en mättad brun
 * måste vara mörk för att vara brun.
 *
 * Två rollfärger inne i fliken är fortfarande svala och rördes inte:
 * `Palette.community` (lilan på stöd-storyn) och `Palette.peer` (den dämpade
 * grönan på din egen). De är *roller* och inte rum — de följer funktionen till
 * support-skärmarna utanför fliken — men de står nu mot ett varmt rum i
 * stället för ett lila. Ska de bytas är det en egen ändring som rör varje
 * stödyta i appen, inte den här fliken.
 */

/**
 * `study` är inte en fjärde kulör utan **Pause-rummet en trappa djupare in**.
 *
 * Statistiken, inställningarna och profilen nås alla från ikonerna i Hems
 * topbar, och de tre har samma ärende: din egen bokföring och dina egna
 * reglage. De ska därför kännas som samma rum man kom från — `hue` är
 * *identisk* med `pause`, för det är den som säger vilken färg rummet har —
 * men botten och ytan är mörkare, så att man märker att man gått in i något
 * bakom huvudrummet i stället för att byta hus.
 *
 * I ljusläget är "mörkare" ett djupare papper (`bg`) medan `surface` förblir
 * rent vitt: samma regel som basens ljusläge står under, att vitt sparas åt
 * korten så de kan lyfta från bakgrunden. Blir båda mörkare försvinner lyftet.
 *
 * Himlen i [components/screen-background.tsx](../components/screen-background.tsx)
 * är densamma som `pause` och ska vara det. Den ligger på 0.30 alfa, så en
 * mörkare botten under samma himmel ger ett mörkare resultat av sig själv —
 * en egen uppsättning himmelskulörer hade varit två tal att hålla i takt för
 * en skillnad botten redan gör.
 */

// Rummets kulör som tonad yta. Inte samma alfa i de två lägena, av samma skäl
// som ink-skalan är asymmetrisk: en ton biter hårdare på vitt än på svart.
const HUE_TINT_ALPHA: Record<ThemeMode, number> = { dark: 0.16, light: 0.13 };

/**
 * Paletten för ett rum, eller basen om `room` är null.
 *
 * **Cachen är inte en optimering utan ett krav.** Varje skärm bygger sin
 * StyleSheet med `useMemo(() => makeStyles(Palette), [Palette])`, så ett nytt
 * palettobjekt per render hade byggt om varenda StyleSheet i appen vid varje
 * omrendering — samma skäl som `value` i ThemeContext är memoiserad. Nyckeln
 * är `mode:room`, och det finns nio kombinationer totalt (natten har bara
 * ett läge).
 *
 * `derive` körs om på den rumsjusterade basen och inte bara spreds över: det
 * är så `eyebrow.color` (som läser `hue`) och `cardShadow` får rummets
 * värden i stället för basens.
 */
const roomCache = new Map<string, AppPalette>();

export const roomPalette = (requested: ThemeMode, room: RoomName | null): AppPalette => {
  if (!room) return palettes[requested];
  const mode = roomMode(requested, room);
  const key = `${mode}:${room}`;
  const hit = roomCache.get(key);
  if (hit) return hit;
  const t = ROOMS[mode][room];
  const next = derive({
    ...palettes[mode],
    ...t,
    hueTint: alpha(t.hue, HUE_TINT_ALPHA[mode]),
  });
  roomCache.set(key, next);
  return next;
};

export const Radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  pill: 999,
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

// Bakåtkompatibla modulnivå-former av det härledda. Samma villkor som
// `Palette` ovan: bara för kod som inte kan fråga efter läget.
export const eyebrow = darkPalette.eyebrow;
export const cardShadow = darkPalette.cardShadow;
