// Anslutningen till lådan, och allt lådan säger om sig själv.
//
// Sedan firmware v8.5 startar appen aldrig en lådpaus, så det här är inte
// längre en kanal appen *styr* lådan genom — den skickar ingenting. Lådan
// berättar vilken låda den är, om den har nät och hur mycket batteri den
// har; appen lyssnar. Det är därför den gamla BLEMessageContext med sina
// prenumeranter och sändare (`set_mode`, `phone_down`, `phone_up`,
// `session_ack`) är borta: det fanns ingen händelse kvar att prenumerera
// på, bara tillstånd, och tillstånd hör hemma i den här contexten.

import React, { createContext, useContext, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import { ConnectionPriority, manager } from './bleManager';
import { track } from '../lib/analytics';
import { parseBoxMessage } from '../lib/bleProtocol';

const SERVICE_UUID = '12345678-1234-1234-1234-123456789012';
const CHARACTERISTIC_UUID = 'abcdefab-cdef-abcd-efab-cdefabcdefab';

const REQUESTED_MTU = 185;
const RECONNECT_DELAY_MS = 1500;

/** Lådans nätverksläge, senast den sa något. Null tills ett `net` kommit. */
export interface BoxNetStatus {
  wifiUp: boolean;
  networkSaved: boolean;
  /** Pauser som väntar i lådans kö på att nå servern. */
  queued: number;
  ssid: string;
}

export const BLEControlContext = createContext<{
  connectToPausePod: () => void;
  disconnect: () => void;
  isConnected: boolean;
  isScanning: boolean;
  /** Lådans serverkända id (BOX001), ur `boxid`. Null i äldre firmware.
   *  Parningen i AsyncStorage är borta: den fanns bara för att hindra en
   *  främmande låda från att kapa skärmen med sitt `state`, och appen går
   *  inte in i någon lådas paus längre. Lådan säger vem den är vid varje
   *  anslutning, så det finns inget att minnas mellan dem. */
  serverBoxId: string | null;
  /** Lådans nätverksläge, ur `net`. Null i äldre firmware. */
  netStatus: BoxNetStatus | null;
  /** Lådans batteri i procent, ur `battery`. Null tills den sagt något. */
  batteryPercent: number | null;
} | null>(null);

const isConnectingRef = { current: false };
const isConnectedRef = { current: false };
const subscriptionRef = { current: null as any };

export function BLEProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [serverBoxId, setServerBoxId] = useState<string | null>(null);
  const [netStatus, setNetStatus] = useState<BoxNetStatus | null>(null);
  const [batteryPercent, setBatteryPercent] = useState<number | null>(null);
  const deviceRef = useRef<Device | null>(null);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
    }
  };

  const connectToPausePod = async () => {
    if (isConnectingRef.current || isConnectedRef.current) return;
    isConnectingRef.current = true;
    await requestPermissions();

    // Måste tas bort så fort den använts — annars staplas en ny lyssnare
    // för varje anrop av connectToPausePod() (nu även vid automatisk
    // återanslutning efter tapp signal), och en enda BT-tillståndsändring
    // längre fram skulle trigga flera parallella skanningar på en gång.
    const stateSub = manager.onStateChange((state) => {
      if (state === 'PoweredOn') {
        stateSub.remove();
        setIsScanning(true);
        console.log('BLE: Skannar efter PausePod...');
        // Lådans anslutningar lämnar inget spår i pause_sessions: en paus
        // som aldrig kom igång skriver ingen rad. Andelen box_connected mot
        // box_scan_started är det enda måttet på om hårdvaran hittas alls.
        track('box_scan_started');

        // Defensivt — om en tidigare skanning av någon anledning inte hann
        // stängas av (t.ex. snabb återanslutningscykel) kan Android annars
        // svara "Cannot start scanning operation" på nästa startDeviceScan.
        try { manager.stopDeviceScan(); } catch {}

        manager.startDeviceScan(null, null, async (error, device) => {
          if (error) {
            console.log('BLE scan-fel:', error);
            // Oftast Androids scan-throttling eller en nekad behörighet, och
            // båda ser likadana ut för användaren: lådan går inte att välja.
            track('box_scan_failed', { reason: String(error.message ?? error).slice(0, 120) });
            setIsScanning(false);
            isConnectingRef.current = false;
            return;
          }

          if (device?.name === 'PausePod') {
            manager.stopDeviceScan();
            setIsScanning(false);
            console.log('BLE: Hittade PausePod, ansluter...');

            try {
              const connected = await device.connect();
              await connected.discoverAllServicesAndCharacteristics();
              deviceRef.current = connected;
              isConnectedRef.current = true;
              setIsConnected(true);
              console.log('BLE: Ansluten till PausePod');
              track('box_connected');

              // Måste prenumereras INNAN MTU/prioritet förhandlas. Lådan
              // skickar hello+boxid+net+battery direkt vid anslutning
              // (onConnectedHandshake i .ino) — notiser som kommer innan vi
              // hunnit skriva CCCD (dvs innan monitorCharacteristicForService
              // är klar) tappas helt av BLE-stacken, ingen kö, inget
              // ombesänt. Låg vi kvar bakom requestMTU + requestConnectionPriority
              // (två extra tur-och-retur) missade vi ofta hela handskakningen,
              // och då stod statussidan tom för en låda som faktiskt svarade.
              subscriptionRef.current = connected.monitorCharacteristicForService(
                SERVICE_UUID,
                CHARACTERISTIC_UUID,
                (err, characteristic) => {
                  if (err) {
                    console.log('BLE monitor-fel:', err);
                    return;
                  }
                  if (!characteristic?.value) return;

                  const decoded = atob(characteristic.value);
                  const parsed = parseBoxMessage(decoded);
                  if (!parsed) return;

                  // Allt lådan säger är tillstånd, och allt tillstånd landar
                  // här. `hello` (chip-id), `state` och `ready_to_close` har
                  // ingen läsare än — se lib/bleProtocol.ts.
                  switch (parsed.type) {
                    case 'boxid':
                      setServerBoxId(parsed.serverBoxId);
                      break;
                    case 'net':
                      setNetStatus({
                        wifiUp: parsed.wifiUp,
                        networkSaved: parsed.networkSaved,
                        queued: parsed.queued,
                        ssid: parsed.ssid,
                      });
                      break;
                    case 'battery':
                      setBatteryPercent(parsed.percent);
                      break;
                  }
                }
              );

              // En stängd låda kan dämpa signalen tillräckligt för att tappa
              // länken helt utan att appen annars märker det — utan den här
              // lyssnaren fastnar isConnectedRef på true för alltid och
              // connectToPausePod() vägrar då någonsin skanna igen.
              connected.onDisconnected(() => {
                console.log('BLE: Lådan kopplade ner — försöker återansluta om', RECONNECT_DELAY_MS, 'ms');
                track('box_disconnected');
                resetConnectionState();
                // Fördröjning innan nytt startDeviceScan — kopplar lådan ner/upp
                // snabbt i cykler (svag signal) slår annars Androids interna
                // scan-throttling till efter ett fåtal försök på kort tid,
                // vilket gör att ALL framtida skanning nekas ("Cannot start
                // scanning operation") tills throttlingen släpper.
                setTimeout(() => connectToPausePod(), RECONNECT_DELAY_MS);
              });

              try {
                const negotiated = await connected.requestMTU(REQUESTED_MTU);
                // Lådans firmware sätter idag aldrig sin egen MTU (ingen
                // esp_ble_gatt_set_local_mtu i .ino) — negotiated.mtu kan
                // därför stanna på standardvärdet 23 även om denna lyckas.
                console.log(`BLE: MTU förhandlad till ${negotiated.mtu} (begärde ${REQUESTED_MTU})`);
              } catch (e) {
                console.log('BLE: MTU-förhandling misslyckades (ok, faller tillbaka på standard 23):', e);
              }

              // Android-only — begär kort connection interval under incheckning.
              // iOS saknar motsvarande API på central-sidan; där måste lådan
              // själv föreslå parametrarna (esp_ble_gap_update_conn_params).
              if (Platform.OS === 'android') {
                try {
                  await connected.requestConnectionPriority(ConnectionPriority.High);
                } catch (e) {
                  console.log('BLE: connection priority-förfrågan misslyckades:', e);
                }
              }
            } catch (e) {
              console.log('BLE anslutningsfel:', e);
              // Lådan hittades men gick inte att ansluta till — ett annat
              // fel än att den inte syns alls, och vyn
              // analytics.box_connections håller dem åtskilda.
              track('box_connect_failed', { reason: String((e as Error)?.message ?? e).slice(0, 120) });
              isConnectingRef.current = false;
            }
          }
        });
      }
    }, true);
  };

  const resetConnectionState = () => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    deviceRef.current = null;
    isConnectedRef.current = false;
    isConnectingRef.current = false;
    setIsConnected(false);
    // Allt lådan sagt om sig själv gäller den låda vi var anslutna till.
    // Stod det kvar skulle statussidan visa en annan lådas wifi och batteri
    // som om det var den här.
    setServerBoxId(null);
    setNetStatus(null);
    setBatteryPercent(null);
  };

  const disconnect = () => {
    deviceRef.current?.cancelConnection();
    resetConnectionState();
  };

  const controlValue = {
    connectToPausePod, disconnect, isConnected, isScanning,
    serverBoxId, netStatus, batteryPercent,
  };

  return (
    <BLEControlContext.Provider value={controlValue}>
      {children}
    </BLEControlContext.Provider>
  );
}

export function useBLEControl() {
  const ctx = useContext(BLEControlContext);
  if (!ctx) throw new Error('useBLEControl måste användas inom BLEProvider');
  return ctx;
}
