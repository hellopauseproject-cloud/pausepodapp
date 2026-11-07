import { ArchivoBlack_400Regular } from '@expo-google-fonts/archivo-black';
import * as Font from 'expo-font';

/**
 * Displaytypsnittet: samma typsnitt som på joinpausepod.com, där displaytexten
 * är Arial Black. Arial Black finns varken på Android eller iOS och får inte
 * följa med appen, så det här är **Archivo Black**, det fria typsnittet som är
 * ritat som dess motsvarighet.
 *
 * Det sätts inte för hand någonstans. Textomslaget i
 * [fontScaleCap.ts](./fontScaleCap.ts) ger det till varje `Text` med
 * `fontWeight: '900'` och ingen egen `fontFamily`, för `'900'` är appens
 * displaykonvention, och en skärm som glömde ett anrop hade fått fel typsnitt
 * utan att något felade. Typsnittet har bara en vikt, så omslaget sätter
 * `fontWeight: 'normal'` bredvid: en vikt ovanpå en egen familj ger fel snitt
 * på Android.
 *
 * `DISPLAY_FONT = false` ger tillbaka systemets tunga snitt överallt.
 */
export const DISPLAY_FONT = true;
export const DISPLAY_FAMILY = 'ArchivoBlack_400Regular';

// En laddning för hela appen, startad när modulen importeras (från
// index.js, före allt annat). Text som renderats innan den landat får
// typsnittet i samma stund, genom prenumerationen nedan.
let ready = Font.isLoaded(DISPLAY_FAMILY);
const listeners = new Set<() => void>();

if (DISPLAY_FONT && !ready) {
  Font.loadAsync({ [DISPLAY_FAMILY]: ArchivoBlack_400Regular })
    .then(() => {
      ready = true;
      listeners.forEach(l => l());
      listeners.clear();
    })
    .catch(e => { console.warn('displayFont: could not load Archivo Black', e); });
}

export function isDisplayFontReady() {
  return DISPLAY_FONT && ready;
}

/** För `useSyncExternalStore`: gratis när typsnittet redan finns. */
export function subscribeDisplayFont(listener: () => void) {
  if (ready || !DISPLAY_FONT) return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
