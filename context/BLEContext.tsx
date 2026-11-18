import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import { ConnectionPriority, manager } from './bleManager';
import { track } from '../lib/analytics';
import { BoxMessage, encodePhoneDown, encodePhoneUp, encodeSessionAck, encodeSetMode, parseBoxMessage } from '../lib/bleProtocol';

const SERVICE_UUID = '12345678-1234-1234-1234-123456789012';
const CHARACTERISTIC_UUID = 'abcdefab-cdef-abcd-efab-cdefabcdefab';

// Vilken låda den här telefonen senast parades med. Ett riktigt
// parningsflöde (byta låda från profilen) är utanför scope här —
// första lådan som säger hello blir "vår" tills vidare.
const PAIRED_BOX_KEY = 'paired_box_id';

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
  /** Id på den låda vi just nu är anslutna till, om någon. */
  boxId: string | null;
  /** Är den anslutna lådan samma som senast parades med den här telefonen?
   *  Styr om lådans `state`-meddelande får kapa skärmen (se BLEContext). */
  isPairedBox: boolean;
  /** Samma värde som isPairedBox, men läsbart synkront (ref, inte state).
   *  hello och state kommer i snabb följd vid varje ny anslutning — ett
   *  React-state-baserat isPairedBox hinner inte alltid uppdateras innan
   *  state-meddelandet redan processats, vilket tyst kastar RESTORE.
   *  SessionContext läser den här istället för isPairedBox-booleanen. */
  isPairedBoxRef: React.RefObject<boolean>;
  /** Lådans serverkända id (BOX001), ur `boxid`. Null i äldre firmware. */
  serverBoxId: string | null;
  /** Lådans nätverksläge, ur `net`. Null i äldre firmware. */
  netStatus: BoxNetStatus | null;
} | null>(null);

export const BLEMessageContext = createContext<{
  /** Prenumerera på varje meddelande från lådan. Returnerar avregistreraren.
   *  Handlers anropas synkront från BLE-callbacken — se motiveringen vid
   *  messageHandlersRef i BLEProvider för varför det inte är en state-slot. */
  subscribeToBoxMessages: (handler: (message: BoxMessage) => void) => () => void;
  sendSessionAck: (seq: string) => Promise<void>;
  sendSetMode: (mode: string, direction: 'UP' | 'DOWN', seconds: number) => Promise<void>;
  sendPhoneDown: () => Promise<void>;
  sendPhoneUp: () => Promise<void>;
} | null>(null);

const isConnectingRef = { current: false };
const isConnectedRef = { current: false };
const subscriptionRef = { current: null as any };

export function BLEProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [serverBoxId, setServerBoxId] = useState<string | null>(null);
  const [netStatus, setNetStatus] = useState<BoxNetStatus | null>(null);
  const [isPairedBox, setIsPairedBox] = useState(false);
  const isPairedBoxRef = useRef(false);
  const deviceRef = useRef<Device | null>(null);

  // Ett lyssnarregister, inte en useState-slot. Lådan skickar flera notiser
  // i samma andetag (checkin_complete + session_started; hello + state +
  // battery). Med en enda state-slot hann de krocka i React: passiva
  // effekter kör efter commit, så meddelande nr 2 kunde sättas innan nr 1:s
  // effekt hunnit köra sin resetMessage() — nollställningen lades då sist i
  // kön och skrev över nr 2, som aldrig nådde reducern. Det var därför
  // session_started tystnade och appen fastnade i 'checked_in'. Handlers
  // anropas synkront härifrån; ingenting kan skrivas över på vägen.
  const messageHandlersRef = useRef(new Set<(message: BoxMessage) => void>());

  const subscribeToBoxMessages = useCallback((handler: (message: BoxMessage) => void) => {
    messageHandlersRef.current.add(handler);
    return () => { messageHandlersRef.current.delete(handler); };
  }, []);

  // Förladdad en gång vid mount, långt innan någon BLE-anslutning hinner bli
  // klar — annars skulle handleHello() behöva invänta AsyncStorage varje
  // gång, vilket är precis den lucka som orsakar race:en beskriven ovan.
  const pairedBoxIdRef = useRef<string | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(PAIRED_BOX_KEY).then(v => { pairedBoxIdRef.current = v; });
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
    }
  };

  const sendRaw = async (message: string) => {
    if (!deviceRef.current) {
      console.log('BLE: Kan inte skicka (ingen ansluten enhet):', message);
      return;
    }
    const base64 = btoa(message);
    // Diagnostik för trunkerings-buggen: jämför tecken-antalet här mot vad
    // lådans seriemonitor loggar att den tog emot. Padding ska alltid landa
    // på ett '=' -antal så att base64-längden är delbar med 4.
    console.log(
      `BLE: Skickar "${message}" (${message.length} tecken rått) -> base64 "${base64}" (${base64.length} tecken, %4=${base64.length % 4})`
    );
    try {
      await manager.writeCharacteristicWithResponseForDevice(
        deviceRef.current.id,
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        base64
      );
      console.log('BLE: Skickade', message);
    } catch (e) {
      console.log('BLE: Fel vid skrivning av', message, e);
    }
  };

  // hello konsumeras här internt — den blir aldrig ett boxMessage som
  // vidarebefordras till SessionContext. Lådan tar emot time_sync men
  // ignorerar det — skickas inte längre.
  //
  // Måste vara synkron. state kommer direkt efter hello vid varje ny
  // anslutning — om den här hade väntat på AsyncStorage (som tidigare)
  // hinner monitorCharacteristicForService-callbacken för state redan
  // köras med det gamla (stale) isPairedBox-värdet, och RESTORE kastas
  // tyst. pairedBoxIdRef är därför förladdad vid mount istället.
  const handleHello = (boxIdFromDevice: string) => {
    setBoxId(boxIdFromDevice);
    if (!pairedBoxIdRef.current) {
      pairedBoxIdRef.current = boxIdFromDevice;
      AsyncStorage.setItem(PAIRED_BOX_KEY, boxIdFromDevice).catch(() => {});
    }
    const paired = pairedBoxIdRef.current === boxIdFromDevice;
    isPairedBoxRef.current = paired;
    setIsPairedBox(paired);
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
              // skickar hello+state+battery direkt vid anslutning
              // (onConnectedHandshake i .ino) — notiser som kommer innan vi
              // hunnit skriva CCCD (dvs innan monitorCharacteristicForService
              // är klar) tappas helt av BLE-stacken, ingen kö, inget
              // ombesänt. Låg vi kvar bakom requestMTU + requestConnectionPriority
              // (två extra tur-och-retur) missade vi ofta hela handskakningen.
              // Ofarligt vid en förstagångsanslutning (state är bara 'idle'
              // då), men dödligt vid återanslutning mitt i en session — state
              // är appens ENDA sätt att återfå fasen, och utan den fastnar
              // appen på skärmen den hade före tappet medan lådan fortsätter
              // räkna för sig själv.
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

                  if (parsed.type === 'hello') {
                    handleHello(parsed.boxId);
                    return;
                  }
                  // boxid och net är lådans *tillstånd* och inte händelser i
                  // ritualen: de hamnar i state här istället för hos
                  // prenumeranterna, på samma sätt som hello.
                  if (parsed.type === 'boxid') {
                    setServerBoxId(parsed.serverBoxId);
                    return;
                  }
                  if (parsed.type === 'net') {
                    setNetStatus({
                      wifiUp: parsed.wifiUp,
                      networkSaved: parsed.networkSaved,
                      queued: parsed.queued,
                      ssid: parsed.ssid,
                    });
                    return;
                  }
                  messageHandlersRef.current.forEach(handler => handler(parsed));
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
    setBoxId(null);
    setIsPairedBox(false);
    isPairedBoxRef.current = false;
    // Nätverksläget gäller den låda vi var anslutna till. Stod det kvar
    // skulle statussidan visa en annan lådas wifi som om det var den här.
    setServerBoxId(null);
    setNetStatus(null);
  };

  const disconnect = () => {
    deviceRef.current?.cancelConnection();
    resetConnectionState();
  };

  const sendSessionAck = (seq: string) => sendRaw(encodeSessionAck(seq));
  const sendSetMode = (mode: string, direction: 'UP' | 'DOWN', seconds: number) =>
    sendRaw(encodeSetMode(mode, direction, seconds));
  const sendPhoneDown = () => sendRaw(encodePhoneDown());
  const sendPhoneUp = () => sendRaw(encodePhoneUp());

  const controlValue = {
    connectToPausePod, disconnect, isConnected, isScanning, boxId, isPairedBox,
    isPairedBoxRef, serverBoxId, netStatus,
  };
  const messageValue = { subscribeToBoxMessages, sendSessionAck, sendSetMode, sendPhoneDown, sendPhoneUp };

  return (
    <BLEControlContext.Provider value={controlValue}>
      <BLEMessageContext.Provider value={messageValue}>
        {children}
      </BLEMessageContext.Provider>
    </BLEControlContext.Provider>
  );
}

export function useBLE() {
  const ctx = useContext(BLEMessageContext);
  if (!ctx) throw new Error('useBLE måste användas inom BLEProvider');
  return ctx;
}

export function useBLEControl() {
  const ctx = useContext(BLEControlContext);
  if (!ctx) throw new Error('useBLEControl måste användas inom BLEProvider');
  return ctx;
}
