import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Radius, Spacing } from '../../constants/appTheme';
import { IntroStep, useIntroStyles } from './intro-chrome';

/**
 * Lådans ritual, och framför allt tummarna.
 *
 * Incheckningen är en grind, inte en ceremoni: lådan har ingen sensor för om
 * det ligger en telefon i den, så en paus börjar aldrig av sig själv — håller
 * ingen tummarna inom 30 sekunder faller lådan tillbaka till vila och ingen
 * paus räknas. Den som inte fått veta det står framför en stängd låda och
 * undrar varför ingenting händer, och det är därför steget finns: det är enda
 * stället i appen som hinner berätta det innan telefonen ligger inne i en
 * stängd låda.
 *
 * **Bilden bär stegen, inte texten.** Sidan hade förut tre stycken prosa
 * bredvid en ritning, och prosan förklarade det ritningen redan visade. Nu
 * spelar lådan upp de tre momenten — telefonen ner, locket på, tummarna på
 * plattorna — och raderna under är tre ord långa. Det som står kvar i text är
 * bara det bilden omöjligt kan visa: att ingenting händer om man låter bli.
 */
// `display: null` betyder pausymbolen i stället för text — fjärde raden är
// inte ett moment man utför utan det som händer när de tre är gjorda, och
// lådan svarar med ett tecken i stället för med en uppmaning.
const MOVES = [
  { label: 'Phone in the box', display: 'PLACE PHONE IN BOX' },
  { label: 'Close the lid', display: 'CLOSE BOX' },
  { label: 'Hold both pads', display: 'HOLD TO START' },
  { label: 'Pause started', display: null },
];

/** Hur länge varje moment står innan bilden går vidare av sig själv. */
const DWELL_MS = 2200;

export function StepBox({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { Palette, styles } = useIntroStyles();
  const [active, setActive] = useState(0);
  /** Rör man raderna tar man över — då ska bilden sluta röra sig under fingret. */
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setActive(i => (i + 1) % MOVES.length), DWELL_MS);
    return () => clearInterval(t);
  }, [auto]);

  const pick = (i: number) => {
    setAuto(false);
    setActive(i);
  };

  // Ingen underrubrik här: "Three moves, every time" sa exakt vad de tre
  // numrerade raderna under bilden redan säger, och kostade den höjd som
  // gjorde att tredje raden hamnade under skärmkanten.
  return (
    <IntroStep
      scroll
      title={'If you pause\nwith the pod'}
      titleSmall
      primaryLabel="Next →"
      onPrimary={onNext}
      onBack={onBack}
    >
      <Pod step={active} label={MOVES[active].label} display={MOVES[active].display} />

      <View style={local.moves}>
        {MOVES.map((m, i) => {
          const on = i === active;
          return (
            <Pressable
              key={m.label}
              onPress={() => pick(i)}
              style={[
                local.move,
                { borderColor: 'transparent' },
                on && { backgroundColor: Palette.accentTint, borderColor: Palette.accentBorder },
              ]}
            >
              <View
                style={[
                  local.moveMark,
                  { backgroundColor: Palette.ink08 },
                  on && { backgroundColor: Palette.accent },
                ]}
              >
                <Text
                  style={[
                    local.moveMarkText,
                    { color: Palette.textTertiary },
                    on && { color: Palette.onAccent },
                  ]}
                >
                  {i + 1}
                </Text>
              </View>
              <Text
                style={[
                  local.moveText,
                  { color: Palette.textTertiary },
                  on && { color: Palette.textPrimary },
                ]}
              >
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Raden under de fyra stegen finns för alla som läser dem utan att ha
          någon låda. Utan den läser sidan som en förutsättning — fyra moment
          med ett föremål man inte äger, mitt i en introduktion man inte kan
          hoppa över — och appen fungerar hela vägen utan den. */}
      <Text style={styles.hint}>
        {'Don\'t have a pod? Don\'t worry — pausing works just as well without one.'}
      </Text>
    </IntroStep>
  );
}

/**
 * Lådan rakt framifrån: lock överst, en tumplatta ute vid var sida och
 * displayen liten i mitten. Samma ordning och ungefär samma proportioner som
 * den riktiga lådan — står plattorna fel är illustrationen värre än ingen alls.
 *
 * **Träfärgerna och hudtonen är med flit inte palettstyrda.** Samma undantag
 * som regnbågen på kretsens tionde nivå: lådan är ett föremål av ek och ser
 * likadan ut oavsett om appen står i ljust eller mörkt läge. En låda som bytte
 * träslag med temat vore inte längre en bild av den låda man har hemma.
 */
const WOOD = {
  lid: '#d9c19b',
  lidEdge: '#b08f64',
  body: '#c9ad82',
  grain: '#b8996c',
  interior: '#6b573b',
  rim: '#d3b78d',
  screen: '#080e1c',
  screenGlow: '#4db8ff',
  pad: '#1f3a6b',
  padLit: '#4a8ede',
  padPins: '#0d1728',
  phone: '#12161f',
  phoneEdge: '#2b3242',
  // Handen är en enda jämn hudton: inga konturer, inga skuggningar. Formen
  // bärs av silhuetten själv, och den mörkare kantfärg som fanns här förut
  // är borta eftersom ingenting ritar en kant längre.
  skin: '#e2b189',
  nail: '#f0cdb2',
};

function Pod({ step, label, display }: { step: number; label: string; display: string | null }) {
  const lidOn = step >= 1;
  const thumbsOn = step === 2;

  const lid = useAnimatedFlag(lidOn, 380);
  const thumbs = useAnimatedFlag(thumbsOn, 360);
  const drop = usePhoneDrop(step === 0);

  const padColor = thumbs.interpolate({ inputRange: [0, 1], outputRange: [WOOD.pad, WOOD.padLit] });

  return (
    <View
      style={local.stage}
      accessible
      accessibilityLabel={`Step: ${label}. The pod shows ${display ?? 'a pause symbol'}.`}
    >
      <View style={local.pod}>
        {/* Öppet lock: man ser kanten och mörkret inuti. Locket nedan lägger
            sig över exakt den här ytan när det stängs. */}
        <View style={[local.rim, { backgroundColor: WOOD.rim }]}>
          <View style={[local.interior, { backgroundColor: WOOD.interior }]} />
        </View>

        {/* Telefonen på väg ner, liggande — så man lägger den, och så måste
            den ligga för att få plats. Den ritas FÖRE framsidan, vilket är
            hela tricket: framsidan målas ovanpå och slukar telefonen på
            vägen ner, i stället för att den ska tonas bort i tomma luften. */}
        {step === 0 && (
          <Animated.View
            style={[
              local.phone,
              {
                backgroundColor: WOOD.phone,
                borderColor: WOOD.phoneEdge,
                opacity: drop.interpolate({ inputRange: [0, 0.12, 1], outputRange: [0, 1, 1] }),
                transform: [
                  // Slutläget ligger helt innanför framsidan, så telefonen är
                  // borta för att den ÄR i lådan — inte för att den tonats ut.
                  { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-24, 32] }) },
                ],
              },
            ]}
          >
            <View style={[local.phoneSpeaker, { backgroundColor: WOOD.phoneEdge }]} />
          </Animated.View>
        )}

        {/* Stängt lock, med samma överhäng som det riktiga. */}
        <Animated.View
          style={[
            local.lid,
            {
              backgroundColor: WOOD.lid,
              borderBottomColor: WOOD.lidEdge,
              opacity: lid,
              transform: [{ translateY: lid.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
            },
          ]}
        />

        <View style={[local.body, { backgroundColor: WOOD.body }]}>
          <View style={[local.grain, local.grainA, { backgroundColor: WOOD.grain }]} />
          <View style={[local.grain, local.grainB, { backgroundColor: WOOD.grain }]} />

          <View style={local.front}>
            <View style={local.padSlot}>
              <Animated.View style={[local.pad, { backgroundColor: padColor }]}>
                <View style={[local.padPins, { backgroundColor: WOOD.padPins }]} />
              </Animated.View>
              <Hand side="left" anim={thumbs} />
            </View>

            <View style={[local.screen, { backgroundColor: WOOD.screen }]}>
              {display === null ? (
                // Pausen löper: lådan slutar be om något och visar bara
                // tecknet. Ritat som två staplar i stället för skrivet som ett
                // tecken — en glyf ur ett typsnitt hade varit tunn och
                // olikadan på iOS och Android, och det här ska läsas på en
                // liten display över ett rum.
                <View style={local.pauseGlyph}>
                  <View style={[local.pauseBar, { backgroundColor: WOOD.screenGlow }]} />
                  <View style={[local.pauseBar, { backgroundColor: WOOD.screenGlow }]} />
                </View>
              ) : (
                <Text style={[local.screenText, { color: WOOD.screenGlow }]} numberOfLines={2}>
                  {display}
                </Text>
              )}
            </View>

            <View style={local.padSlot}>
              <Animated.View style={[local.pad, { backgroundColor: padColor }]}>
                <View style={[local.padPins, { backgroundColor: WOOD.padPins }]} />
              </Animated.View>
              <Hand side="right" anim={thumbs} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * En hand som lägger tummen på sin platta.
 *
 * **Byggd efter fotot, och det ändrade allt.** De tidigare försöken kom in
 * vågrätt från sidan med tummen rakt fram, och det var därför de såg ut som
 * vad som helst utom händer. På fotot kommer händerna NERIFRÅN: handen som en
 * sluten näve nedanför plattan, och tummen som reser sig därifrån snett
 * uppåt-inåt och lägger kudden mot modulen. Riktningen var felet, inte
 * formerna.
 *
 * **Underarmen är borttagen.** Den fanns för att en hand som slutar i
 * ingenting svävar, men i den här skalan blev den inte en arm utan en liten
 * stump på sniskan bredvid lådan — den drog blicken till sig själv i stället
 * för till tummen på plattan, vilket är hela det som steget handlar om.
 * Näven är rundad hela vägen runt och slutar strax innanför gruppens nedre
 * kant, så det som står kvar är en sluten hand och inte ett avhugget parti.
 * Ska den någon gång tillbaka: den låg på `left: -34, top: 66`, 92 × 42,
 * radie 21, vriden 16°, och målades först av alla delarna.
 *
 * Silhuetten är fyra delar som överlappar varandra i måleriets ordning —
 * näve, pekfingrets knoge, tummens rot, tummens spets — så att varje ny del
 * täcker sömmen efter den förra. Tummen målas sist av alla, för det är den
 * som ligger främst och rör vid något.
 *
 * Högerhanden är vänsterhanden speglad med `scaleX: -1`, inte en egen
 * uppsättning mått. Två handskrivna spegelbilder glider isär vid första
 * justeringen; en spegling kan inte göra det. Därför ligger skjutningen på en
 * yttre vy och speglingen på en inre — annars hade `translateX` räknats i
 * spegelvänd riktning och handen åkt åt fel håll.
 *
 * Hela gruppen ligger INUTI plattans slot och sträcker sig utåt därifrån, så
 * att spetsen alltid landar på plattan oavsett hur bred lådan råkar bli på en
 * smal skärm — hade den positionerats i pixlar från lådans kant hade den glidit
 * av plattan på en iPhone SE.
 */
function Hand({ side, anim }: { side: 'left' | 'right'; anim: Animated.Value }) {
  const left = side === 'left';
  const slide = anim.interpolate({ inputRange: [0, 1], outputRange: [left ? -64 : 64, 0] });

  return (
    <Animated.View
      style={[
        local.hand,
        left ? local.handLeft : local.handRight,
        { opacity: anim, transform: [{ translateX: slide }] },
      ]}
      pointerEvents="none"
    >
      <View style={[local.handInner, !left && local.handMirror]}>
        {/* Näven: fingrarna krökta, handryggen mot betraktaren. Bredare uppe
            vid knogarna än nere vid handloven. */}
        <View style={[local.fist, { backgroundColor: WOOD.skin }]} />

        {/* De ihopknutna fingrarna ovanpå näven. Utan dem slutade handen
            tvärt under tummen och såg avhuggen ut — det är den här massan som
            gör att man läser en knuten hand och inte en stump. Samma hudton
            som resten, så den smälter in i silhuetten i stället för att bli
            ännu en form som syns. */}
        <View style={[local.fingers, { backgroundColor: WOOD.skin }]} />

        {/* Tummen i två leder, snett uppåt-inåt. Roten brantare, spetsen
            uppritad mot plattan: knycken mellan dem är vad som gör en tumme
            till en tumme i stället för till en pinne. */}
        <View style={[local.thumbBase, { backgroundColor: WOOD.skin }]} />
        <View style={[local.thumbTip, { backgroundColor: WOOD.skin }]}>
          <View style={[local.nail, { backgroundColor: WOOD.nail }]} />
        </View>
      </View>
    </Animated.View>
  );
}

/**
 * Telefonen faller, försvinner in i lådan, och gör om det.
 *
 * Loopen kör bara medan momentet visas. `Animated.loop` nollställer värdet
 * mellan varven, så telefonen dyker upp överst igen utan att någon behöver
 * återställa den för hand.
 */
function usePhoneDrop(on: boolean): Animated.Value {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!on) {
      v.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(280),
        Animated.timing(v, {
          toValue: 1,
          duration: 1150,
          // Accelererar nedåt: en telefon som läggs ner faller sista biten.
          easing: Easing.in(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.delay(520),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      v.setValue(0);
    };
  }, [on]);

  return v;
}

/** 0 → 1 när flaggan slås på, 1 → 0 när den slås av. */
function useAnimatedFlag(on: boolean, duration: number): Animated.Value {
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    // Färginterpolationen på plattorna kan inte köras av native-drivaren.
    Animated.timing(v, { toValue: on ? 1 : 0, duration, useNativeDriver: false }).start();
  }, [on]);
  return v;
}

// Lådan är nedskalad ett snäpp för att fjärde raden ska rymmas under den.
// De fyra talen hänger ihop och kan inte röras var för sig: telefonens
// slutläge måste ligga helt innanför framsidan (`POD_TOP` ≤ translateY ≤
// `POD_TOP + BODY_H − telefonens höjd`), annars sticker den ut nedtill när
// den ska vara nere i lådan.
const POD_TOP = 26;
const BODY_H = 108;
const PHONE_H = 96;
const PAD_W = 24;
const PAD_H = 44;
const HAND_W = 150;
const HAND_H = 112;
/** Hur långt handens inre kant sticker in förbi plattan. */
const PAD_OVERHANG = 6;

const local = StyleSheet.create({
  // Scenen klipper ingenting: telefonen sticker upp ovanför lådan och händerna
  // sträcker sig ut förbi dess kanter, precis som riktiga händer gör.
  stage: {
    width: '100%',
    maxWidth: 320,
    alignSelf: 'center',
    // Precis den luft telefonen behöver i sitt startläge, inte mer: varje
    // pixel här trycker fjärde raden mot skärmkanten. Talet måste vara minst
    // lika stort som telefonens startläge ovanför lådan (24), annars klipps
    // den mot scenens överkant just när den ska komma in i bild.
    paddingTop: 26,
    // Och nedtill precis den luft händerna behöver. De kommer nerifrån, som
    // på fotot, och hänger därför en bit under lådan — utan det här lägger
    // sig näven över första steget i listan.
    paddingBottom: 32,
  },
  pod: {
    width: '100%',
  },

  // ── Lock och öppning ──────────────────────────────────────────────────────
  rim: {
    height: POD_TOP,
    borderTopLeftRadius: Radius.sm,
    borderTopRightRadius: Radius.sm,
    paddingHorizontal: 12,
    justifyContent: 'flex-end',
  },
  interior: {
    height: POD_TOP - 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  lid: {
    position: 'absolute',
    top: -3,
    left: -5,
    right: -5,
    height: POD_TOP + 3,
    borderRadius: Radius.sm,
    borderBottomWidth: 2,
  },

  // ── Telefonen, liggande ───────────────────────────────────────────────────
  phone: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    // Nästan så bred som lådans öppning — en telefon som ser liten ut mot
    // lådan säger fel sak om hur mycket plats den tar.
    width: '78%',
    height: PHONE_H,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    paddingLeft: 11,
  },
  phoneSpeaker: {
    width: 3,
    height: 30,
    borderRadius: 2,
  },

  // ── Framsidan ─────────────────────────────────────────────────────────────
  body: {
    height: BODY_H,
    justifyContent: 'center',
    borderBottomLeftRadius: Radius.sm,
    borderBottomRightRadius: Radius.sm,
  },
  grain: {
    position: 'absolute',
    height: 1,
    left: 0,
    right: 0,
    opacity: 0.45,
  },
  grainA: { top: 24 },
  grainB: { bottom: 28 },
  front: {
    flexDirection: 'row',
    alignItems: 'center',
    // Plattorna ut mot sidorna, displayen liten i mitten. `space-between` med
    // två lika breda slots centrerar displayen exakt, utan att den behöver
    // veta hur bred lådan blev. Procent, inte pixlar: på en smal skärm ska
    // plattorna flytta in med kanten i stället för att klämma displayen.
    justifyContent: 'space-between',
    paddingHorizontal: '15%',
  },
  padSlot: {
    width: PAD_W,
    height: PAD_H,
  },
  pad: {
    width: PAD_W,
    height: PAD_H,
    borderRadius: 3,
    alignItems: 'center',
    paddingTop: 3,
  },
  padPins: {
    width: 15,
    height: 4,
    borderRadius: 1,
  },
  screen: {
    width: 96,
    height: 44,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  screenText: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.5,
    lineHeight: 14,
    textAlign: 'center',
  },
  // Paustecknet: två feta staplar. Tjockleken är poängen — en smal symbol på
  // en liten display läser som ett streck, inte som en paus.
  pauseGlyph: {
    flexDirection: 'row',
    gap: 10,
  },
  pauseBar: {
    width: 10,
    height: 26,
    borderRadius: 2,
  },

  // ── Händerna ──────────────────────────────────────────────────────────────
  // ── Handens koordinatsystem ───────────────────────────────────────────────
  // Gruppen är HAND_W × HAND_H och hänger i plattans slot med sin inre kant
  // PAD_OVERHANG utanför den. Med `top: -4` hamnar plattan (24 × 44) på
  // x 120…144, y 4…48 inne i gruppen, alltså med mitten i (132, 26).
  //
  // Alla mått nedan är satta mot den punkten. Vill man flytta en form är det
  // den kartan som gäller — inte magkänslan, för delarna överlappar varandra
  // med avsikt och ett löst tal river isär silhuetten.
  hand: {
    position: 'absolute',
    width: HAND_W,
    height: HAND_H,
    top: -4,
  },
  handLeft: { right: -PAD_OVERHANG },
  handRight: { left: -PAD_OVERHANG },
  handInner: {
    width: HAND_W,
    height: HAND_H,
  },
  /** Högerhanden är vänsterhanden speglad. Se kommentaren vid `Hand`. */
  handMirror: {
    transform: [{ scaleX: -1 }],
  },
  // **Ingen av delarna har kontur.** Med en kant på var och en syntes varje
  // skarv, och handen lästes som fem former ovanpå varandra i stället för som
  // en. Nu är de samma fyllning utan linje, så överlappen försvinner helt och
  // silhuetten blir en enda yta. Formen får i stället bäras av tonen på
  // undersidan och av knogen i skugga — ljus och skugga, inte streck.
  //
  // Näven nedanför plattan. Radierna är olika i alla fyra hörn med flit:
  // knogsidan (uppåt-inåt) är fyllig och rund, handloven (nedåt-utåt) smalare.
  // En symmetrisk kapsel är exakt vad som fick de tidigare försöken att läsa
  // som ett föremål i stället för som en hand.
  fist: {
    position: 'absolute',
    left: 40,
    top: 44,
    width: 76,
    height: 56,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 34,
    borderBottomRightRadius: 30,
    borderBottomLeftRadius: 22,
    transform: [{ rotate: '-14deg' }],
  },

  // De ihopknutna fingrarna, ovanpå näven och lutade i samma vinkel som den.
  // Knogsidan (uppåt-inåt) är rundast, precis som på en knuten hand. Den når
  // medvetet inte fram till plattan: det är bara tummen som rör vid modulen,
  // och fingrar som klev in på den hade sagt fel sak om gesten.
  fingers: {
    position: 'absolute',
    left: 50,
    top: 22,
    width: 64,
    height: 42,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 26,
    borderBottomRightRadius: 24,
    borderBottomLeftRadius: 18,
    transform: [{ rotate: '-14deg' }],
  },

  // Tummens två leder, snett uppåt-inåt mot plattan. Roten står brantare
  // (34°) och spetsen rätar upp sig (20°); skillnaden mellan vinklarna ÄR
  // leden. Överlappet är tilltaget så att knycken inte spricker när formerna
  // roterar kring sina egna mittpunkter.
  thumbBase: {
    position: 'absolute',
    left: 97,
    top: 32,
    width: 30,
    height: 50,
    borderRadius: 15,
    transform: [{ rotate: '34deg' }],
  },
  thumbTip: {
    position: 'absolute',
    left: 116,
    top: 9,
    width: 27,
    height: 42,
    borderRadius: 13,
    transform: [{ rotate: '20deg' }],
  },
  // Nageln sitter på tummens ovansida nära spetsen, inte mitt på den, och är
  // liten — en stor oval mitt i kudden läser som ett öga.
  nail: {
    position: 'absolute',
    top: 5,
    left: 7,
    width: 12,
    height: 15,
    borderRadius: 6,
    opacity: 0.7,
  },

  // ── Stegen ────────────────────────────────────────────────────────────────
  moves: {
    width: '100%',
    gap: 6,
  },
  move: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: Spacing.md,
  },
  moveMark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveMarkText: {
    fontSize: 12,
    fontWeight: '900',
  },
  moveText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
