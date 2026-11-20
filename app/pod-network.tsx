import { FontAwesome5 } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PodBoxIcon } from '../components/pod-box-icon';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { useBLEControl } from '../context/BLEContext';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';

/**
 * Hör till **pause-rummet**, se ROOMS i constants/appTheme.ts.
 *
 * Lådans läge. Ingången är PausePod-delen i Settings
 * ([app/onboarding.tsx](onboarding.tsx)), bredvid *How it works ›*.
 *
 * **Sidan är ett svar och inte en rapport.** Den som går hit har en fråga —
 * fungerar lådan? — och svaret står i ett enda ord, stort, i rummets kulör
 * när allt är bra och i `warning` när det inte är det. Allt annat på sidan
 * är detaljer under det svaret. Första versionen var en rubrik på två rader,
 * en ledtext, ett kort med en ram och två etikettrader med en förklarande
 * fotnot under — fem lager prosa för tre fakta, och ingen av dem svarade på
 * frågan förrän man läst alltihop.
 *
 * **Inget kort och ingen ram.** Ytan skiljer sig redan från bakgrunden, och
 * en ruta runt sidans enda innehåll är en andra gräns för samma kant — samma
 * regel som kretsflikens layoutspråk (*Inga kantlinjer*). Luft i stället.
 *
 * **Sidan påstår aldrig något den inte vet.** Allt kommer ur lådans
 * `net`-meddelande (firmware v8.5+), som skickas vid anslutning och när
 * läget ändras. Är lådan inte ansluten över Bluetooth finns ingen uppgift
 * alls, och då säger sidan just det i stället för att visa ett gammalt läge
 * som om det gällde nu. Samma skäl som `netStatus` nollas i
 * `resetConnectionState` ([context/BLEContext.tsx](../context/BLEContext.tsx)).
 *
 * **Den säger inte varför wifi inte fungerar.** Lådan vet oftast inte om det
 * är lösenordet, routern eller internet, och en gissning här hade varit
 * sämre än ingenting.
 *
 * **Kön är ingen oro.** Att pauser väntar är hur lådan är byggd: den sparar
 * dem i flashminnet och skickar upp dem när nätet är tillbaka. Raden står
 * därför i vanligt bläck, och först från tre och uppåt — samma tröskel som
 * lådans egen NO WIFI-skärm (`WIFI_NOTICE_MIN_QUEUE` i firmware) — får den
 * `warning`.
 *
 * **Wifi-inställningen hör hit när den byggs**: appen skickar nätets namn
 * och lösenord till lådan över Bluetooth, så att lådans eget inställningsnät
 * kan tas bort. Knappen *Set up Wi-Fi* är platsen den ska sitta på — den
 * leder till `/pod` tills dess. Skrivningen måste grindas av något fysiskt
 * (locket öppet och en känd tagg), för BLE-länken är oautentiserad och vem
 * som helst inom räckvidd kan annars peka lådan mot sitt eget nät. Se
 * PAUSPOST_KONTRAKT.md i firmware-mappen.
 */
export default function PodNetworkRoom() {
  return (
    <RoomProvider room="pause">
      <View style={roomShell}>
        <ScreenBackground room="pause" />
        <PodNetworkScreen />
      </View>
    </RoomProvider>
  );
}

/** Från och med den här siffran är kön något användaren bör agera på. */
const QUEUE_NOTICE_FROM = 3;

function PodNetworkScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { isConnected, serverBoxId, netStatus, connectToPausePod, isScanning } = useBLEControl();

  // Ett läge, ett svar. Ordningen är sidans: det första som inte stämmer är
  // det som står stort, så användaren aldrig får två problem att väga.
  const state = !isConnected
    ? 'away' as const
    : netStatus === null
      ? 'old' as const
      : !netStatus.networkSaved
        ? 'nowifi' as const
        : !netStatus.wifiUp
          ? 'offline' as const
          : 'good' as const;

  // Raden under ordet finns bara när den säger något ordet inte gör. Här
  // stod en rad per läge — *Your pauses are safe*, *Your pod sends your
  // pauses on its own* — och de var tröst och inte upplysning: statusordet
  // hade redan sagt saken, och knappen säger vad man gör åt den. Kvar står
  // en instruktion (lådan svarar inte) och ett faktum om mekaniken (kön
  // töms av sig själv), båda utan ett ord om hur användaren bör känna.
  const COPY = {
    away:    { word: 'NOT NEARBY', line: 'Open the lid, stay close.' },
    old:     { word: 'NEARBY',     line: 'Older firmware.' },
    nowifi:  { word: 'NO WI-FI',   line: '' },
    offline: { word: 'NO SIGNAL',  line: "Pauses go up when it's back." },
    good:    { word: 'ALL GOOD',   line: '' },
  }[state];

  const loud = state === 'nowifi' || state === 'offline';
  const queued = netStatus?.queued ?? 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.gutter}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          activeOpacity={0.7}
          accessibilityLabel="Back"
        >
          <FontAwesome5 name="arrow-left" size={16} color={Palette.hue} />
        </TouchableOpacity>

        <Text style={styles.title}>{'PAUSE POD\nSTATUS'}</Text>

        {/* Svaret. Lådan vid sidan om, så att det syns vad ordet gäller. */}
        <View style={styles.answer}>
          <PodBoxIcon width={52} />
          <View style={styles.answerText}>
            <Text style={[styles.word, loud && { color: Palette.warning }]}>{COPY.word}</Text>
            <Text style={styles.id}>{serverBoxId ?? 'YOUR POD'}</Text>
          </View>
        </View>

        {!!COPY.line && <Text style={styles.line}>{COPY.line}</Text>}

        {/* Detaljerna, bara de som finns. Nätets namn när lådan har ett, och
            kön bara när något faktiskt väntar — "Waiting: none" är en rad som
            säger ingenting. */}
        {netStatus !== null && (
          <View style={styles.facts}>
            {!!netStatus.ssid && <Fact styles={styles} label="Wi-Fi" value={netStatus.ssid} />}
            {queued > 0 && (
              <Fact
                styles={styles}
                label="Waiting"
                value={`${queued} ${queued === 1 ? 'pause' : 'pauses'}`}
                tone={queued >= QUEUE_NOTICE_FROM ? Palette.warning : undefined}
              />
            )}
          </View>
        )}

        {state === 'away' && (
          <TouchableOpacity
            style={styles.btn}
            onPress={connectToPausePod}
            disabled={isScanning}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            <Text style={styles.btnText}>{isScanning ? 'Looking…' : 'Find my pod'}</Text>
          </TouchableOpacity>
        )}

        {(state === 'nowifi' || state === 'offline') && (
          <TouchableOpacity
            style={[styles.btn, styles.btnQuiet]}
            onPress={() => router.push('/pod' as never)}
            activeOpacity={0.8}
            accessibilityRole="button"
          >
            <Text style={styles.btnQuietText}>Set up Wi-Fi</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

function Fact({
  styles,
  label,
  value,
  tone,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  gutter: { paddingHorizontal: Spacing.xl },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 12, paddingRight: 12, marginBottom: 4 },
  title: {
    fontSize: 30, lineHeight: 34, fontWeight: '900', letterSpacing: -0.4,
    color: Palette.textPrimary,
  },
  answer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginTop: 36 },
  answerText: { flex: 1 },
  // Svaret är display och ska läsas före allt annat på sidan — därför
  // rummets kulör och inte brödtextens bläck.
  word: { fontSize: 28, lineHeight: 32, fontWeight: '900', color: Palette.hue },
  id: { ...Palette.eyebrow, marginTop: 4 },
  line: {
    fontSize: 16, lineHeight: 24, color: Palette.textSecondary, marginTop: Spacing.md,
  },
  facts: { marginTop: 36 },
  fact: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.md, borderTopWidth: 1, borderTopColor: Palette.ink08,
    gap: Spacing.md,
  },
  factLabel: { fontSize: 15, color: Palette.textSecondary },
  factValue: { fontSize: 15, fontWeight: '600', color: Palette.textPrimary, flexShrink: 1 },
  btn: {
    marginTop: 36, backgroundColor: Palette.accent, borderRadius: Radius.pill,
    paddingVertical: 14, alignItems: 'center',
  },
  btnText: { fontSize: 15, fontWeight: '600', color: Palette.onAccent },
  btnQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Palette.ink20 },
  btnQuietText: { fontSize: 15, fontWeight: '600', color: Palette.hue },
});
