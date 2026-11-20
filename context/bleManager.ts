// Den enda platsen i appen som importerar `react-native-ble-plx`.
//
// Skälet är webben: paketet finns inte där. `NativeModules.BlePlx` är
// `undefined` i en webbläsare, så `new BleManager()` kastar redan vid
// modulladdning — och eftersom BLEContext konstruerar sin manager på
// modulnivå dog hela bundlen innan en enda skärm hann renderas. Med
// importen isolerad hit kan `bleManager.web.ts` ta över på webben utan att
// den riktiga koden i BLEContext behöver ett enda `Platform.OS`-villkor.
//
// Webbvarianten finns för att kunna titta på UI:t i en webbläsare utan att
// bygga om appen. Den är ett granskningsverktyg, inte en andra plattform:
// lådans anslutning, sensorerna och kameran finns inte där.
import { BleManager } from 'react-native-ble-plx';

export { ConnectionPriority } from 'react-native-ble-plx';

export const manager = new BleManager();
