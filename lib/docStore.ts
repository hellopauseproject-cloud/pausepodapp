import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * Små JSON-dokument på enheten — profilen, kategorivalen, pausloggen.
 *
 * **Finns för att `expo-file-system` inte har någon webbimplementation.**
 * `writeAsStringAsync` kastar "not available on web" så fort man rör den, och
 * eftersom profilen sparas i steg två av introduktionen tog hela flödet slut
 * där när man körde appen i en webbläsare. Appen är native (BLE,
 * accelerometer, kamera) och webben är bara ett utvecklingsfönster — men ett
 * utvecklingsfönster som kraschar på andra skärmen är inget fönster.
 *
 * **På native är beteendet oförändrat, med flit.** Samma filer, samma
 * sökvägar, samma innehåll. Att flytta allt till AsyncStorage hade varit
 * enklare men hade lämnat varje befintlig installations profil och
 * kategorival kvar i en fil som ingenting längre läser — en tyst
 * dataförlust vid uppdatering. Webben har ingen historik att förlora och får
 * därför AsyncStorage, som där är `localStorage`.
 */
const isWeb = Platform.OS === 'web';

const webKey = (name: string) => `doc:${name}`;

export async function writeDoc(name: string, contents: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(webKey(name), contents);
    return;
  }
  await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + name, contents);
}

/**
 * Kastar när dokumentet saknas, precis som `readAsStringAsync` gör.
 *
 * Det är inte slarv utan hela poängen: varje anropare här omkring är skriven
 * som `try { läs; tolka } catch { förval }`, och ett `null` hade runnit vidare
 * in i `JSON.parse` och gett en tom lista i stället för förvalet. Samma signal
 * på båda plattformarna betyder att ingen av dem behöver ett eget specialfall.
 */
export async function readDoc(name: string): Promise<string> {
  if (isWeb) {
    const value = await AsyncStorage.getItem(webKey(name));
    if (value === null) throw new Error(`No such document: ${name}`);
    return value;
  }
  return FileSystem.readAsStringAsync(FileSystem.documentDirectory + name);
}

/** Tar bort dokumentet; ett som inte finns är ingen felsituation. */
export async function deleteDoc(name: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(webKey(name));
    return;
  }
  await FileSystem.deleteAsync(FileSystem.documentDirectory + name, { idempotent: true });
}
