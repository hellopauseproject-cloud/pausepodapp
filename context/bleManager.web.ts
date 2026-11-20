// Webbvarianten av `bleManager.ts` — Metro väljer den här filen framför
// `.ts` när plattformen är `web`, så `react-native-ble-plx` aldrig laddas
// där. Se motiveringen i `bleManager.ts`.
//
// Stubben låtsas inte att en låda finns: den svarar på det lilla API som
// BLEContext faktiskt rör och låter bli att någonsin rapportera 'PoweredOn'.
// `connectToPausePod()` blir därmed en no-op, `isConnected` stannar på false,
// och appen beter sig precis som den gör i telefonen när ingen låda är i
// närheten — vilket är exakt det läget man vill granska UI:t i.
//
// Konsekvensen är att lådans anslutning inte går att testa på webben. Det är ingen
// brist i stubben: en webbläsare har ingen låda, ingen accelerometer och
// ingen Bluetooth-stack att erbjuda.

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.log('BLE: ingen Bluetooth på webben — lådan går inte att nå i den här vyn.');
}

type StateListener = (state: string) => void;

export function getManager() {
  return manager;
}

const manager = {
  onStateChange(_listener: StateListener, _emitCurrentState?: boolean) {
    warnOnce();
    // Anropas aldrig. BLEContext väntar på 'PoweredOn' innan den skannar,
    // så en lyssnare som aldrig fyrar stoppar hela kedjan på första steget.
    return { remove() {} };
  },
  startDeviceScan() {
    warnOnce();
  },
  stopDeviceScan() {},
  async writeCharacteristicWithResponseForDevice() {
    warnOnce();
    return null;
  },
};

// Bara `High` används, och bara i BLEContexts Android-gren — som webben
// aldrig når. Värdena speglar ändå bibliotekets egna, så att en framtida
// avläsning av dem inte får ett annat svar här än i telefonen.
export const ConnectionPriority = {
  Balanced: 0,
  High: 1,
  LowPower: 2,
} as const;
