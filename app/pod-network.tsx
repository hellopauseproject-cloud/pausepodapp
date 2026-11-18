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
 * Lådans nätverksläge. Ingången är PausePod-delen i Settings
 * ([app/onboarding.tsx](onboarding.tsx)), bredvid *How it works ›*.
 *
 * **Sidan påstår aldrig något den inte vet.** Allt den visar kommer ur
 * lådans `net`-meddelande (firmware v8.5+), som skickas vid anslutning och
 * när läget ändras. Är lådan inte ansluten över Bluetooth finns ingen
 * uppgift alls, och då säger sidan just det — i stället för att visa ett
 * gammalt läge som om det gällde nu. Samma skäl som `netStatus` nollas i
 * `resetConnectionState` ([context/BLEContext.tsx](../context/BLEContext.tsx)).
 *
 * **Den säger inte varför wifi inte fungerar.** Lådan vet oftast inte om det
 * är lösenordet, routern eller internet, och en gissning här hade varit
 * sämre än ingenting. Lådan knackar (NO WIFI på displayen), appen visar
 * läget, och användaren får veta vad hen kan göra.
 *
 * **Kön är ingen oro.** Att pauser väntar är hur lådan är byggd: den sparar
 * dem i flashminnet och skickar upp dem när nätet är tillbaka. Därför står
 * raden i vanligt bläck, och först från tre och uppåt — samma tröskel som
 * lådans egen NO WIFI-skärm (`WIFI_NOTICE_MIN_QUEUE` i firmware) — får den
 * varningsfärgen (`Palette.warning`) som betyder *observera*.
 *
 * **Wifi-inställningen hör hit när den byggs**: appen skickar nätverkets
 * namn och lösenord till lådan över Bluetooth, så att lådans eget
 * inställningsnät kan tas bort. Knappen nedan är platsen den ska sitta på.
 * Se PAUSPOST_KONTRAKT.md i firmware-mappen.
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

  const queueLoud = netStatus !== null && netStatus.queued >= QUEUE_NOTICE_FROM;

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
        <Text style={styles.kicker}>PAUSEPOD</Text>
        <Text style={styles.title}>{'Your pod\nand the net'}</Text>
        <Text style={styles.lead}>
          Your pod sends your pauses on its own. Here is how it is doing.
        </Text>
      </View>

      <View style={styles.gutter}>
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <PodBoxIcon width={40} />
            <Text style={styles.cardTitle}>{serverBoxId ?? 'Your pod'}</Text>
          </View>

          {!isConnected || netStatus === null ? (
            <>
              <Row
                styles={styles}
                label="Pod"
                value={isConnected ? 'Connected' : 'Not nearby'}
              />
              <Text style={styles.note}>
                {isConnected
                  ? 'This pod runs older firmware and does not report its network yet.'
                  : 'Open the lid and stay close, then come back here.'}
              </Text>
              {!isConnected && (
                <TouchableOpacity
                  style={styles.btn}
                  onPress={connectToPausePod}
                  disabled={isScanning}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={styles.btnText}>{isScanning ? 'Looking…' : 'Look for my pod'}</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Row
                styles={styles}
                label="Wi-Fi"
                value={
                  netStatus.wifiUp
                    ? netStatus.ssid || 'Connected'
                    : netStatus.networkSaved
                      ? 'No connection'
                      : 'Not set up'
                }
                tone={netStatus.wifiUp ? undefined : Palette.warning}
              />
              <Row
                styles={styles}
                label="Pauses waiting"
                value={netStatus.queued === 0 ? 'None' : String(netStatus.queued)}
                tone={queueLoud ? Palette.warning : undefined}
              />
              <Text style={styles.note}>
                {netStatus.wifiUp
                  ? 'Your pauses go straight to your circle.'
                  : netStatus.networkSaved
                    ? 'Your pod remembers a network but cannot reach it. Your pauses are saved and will be sent when it is back.'
                    : 'Your pod has no network yet. Your pauses are saved in the pod until it has one.'}
              </Text>
              {!netStatus.wifiUp && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnQuiet]}
                  onPress={() => router.push('/pod' as never)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                >
                  <Text style={styles.btnQuietText}>See how to set up Wi-Fi</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function Row({
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
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  gutter: { paddingHorizontal: Spacing.xl },
  backBtn: { alignSelf: 'flex-start', paddingVertical: 12, paddingRight: 12, marginBottom: 4 },
  kicker: { ...Palette.eyebrow, marginBottom: Spacing.sm },
  title: {
    fontSize: 34, lineHeight: 38, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.textPrimary, textTransform: 'uppercase',
  },
  lead: {
    fontSize: 16, lineHeight: 24, color: Palette.textSecondary,
    marginTop: Spacing.sm, marginBottom: Spacing.xl,
  },
  card: {
    backgroundColor: Palette.surface, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Palette.ink08, padding: Spacing.lg,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg },
  cardTitle: { fontSize: 16, fontWeight: '900', color: Palette.textPrimary, textTransform: 'uppercase' },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.md, borderTopWidth: 1, borderTopColor: Palette.ink08, gap: Spacing.md,
  },
  rowLabel: { fontSize: 15, color: Palette.textSecondary },
  rowValue: { fontSize: 15, fontWeight: '600', color: Palette.textPrimary, flexShrink: 1 },
  note: {
    fontSize: 14, lineHeight: 21, color: Palette.textTertiary,
    marginTop: Spacing.md,
  },
  btn: {
    marginTop: Spacing.lg, backgroundColor: Palette.accent, borderRadius: Radius.pill,
    paddingVertical: 14, alignItems: 'center',
  },
  btnText: { fontSize: 15, fontWeight: '600', color: Palette.onAccent },
  btnQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: Palette.ink20 },
  btnQuietText: { fontSize: 15, fontWeight: '600', color: Palette.hue },
});
