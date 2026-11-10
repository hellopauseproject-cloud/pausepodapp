import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteDoc } from './docStore';

/**
 * Det som ligger på telefonen men hör till ett *konto*, inte till enheten.
 *
 * Filerna har inget användar-id, så utan rivningen följde profilbilden,
 * namnet och intentionerna med till nästa konto som loggade in på samma
 * telefon — introduktionen förifyller ur den lokala profilen, och
 * pausskärmen läser kategorierna rakt ur filerna.
 *
 * Kvar står det som är enhetens: temat, händelsekön (töms av sig själv, se
 * lib/analytics.ts), lådans session-kö (sessionOutbox — en olevererad paus
 * får inte försvinna) och pausens checkpoint (bär sitt eget `userId`).
 *
 * Intentionerna är inte borta efter en utloggning: filerna är bara en cache
 * av `user_intentions`, och hämtas ner igen vid inloggning
 * (`syncIntentions` i app/pauseLogger.ts).
 */
const ACCOUNT_DOCS = [
  'userProfile.json',
  'profilePhoto.jpg',
  'selectedCategories.json',
  'customCategories.json',
  'pauseLogs.json',
];

const ACCOUNT_KEYS = [
  'intro_pending_daily_goal_seconds',
  'intro_deferred',
  'pending_circle_welcome_id',
  'circle_tab_selected',
  'intentions_dirty',
];

/** Får aldrig kasta — anropas från utloggningen. */
export async function clearLocalAccountData(): Promise<void> {
  await Promise.all([
    ...ACCOUNT_DOCS.map(name => deleteDoc(name).catch(() => {})),
    AsyncStorage.multiRemove(ACCOUNT_KEYS).catch(() => {}),
  ]);
}
