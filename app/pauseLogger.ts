import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteDoc, readDoc, writeDoc } from '../lib/docStore';
import { supabase } from '../lib/supabase';

const LOG_PATH = 'pauseLogs.json';
const CATEGORIES_PATH = 'selectedCategories.json';

const SESSION_CHECKPOINT_KEY = 'active_pause_session_checkpoint';

export interface SessionCheckpoint {
  startedAt: string;
  /** ISO — senaste gången appen bevisligen levde under pausen. Skrivs om med
   *  jämna mellanrum och en sista gång när appen lämnar förgrunden. Vid en
   *  tvångsstängning finns ingen kod kvar att köra, så det här är det enda
   *  vi vet om när pausen faktiskt tog slut. */
  lastAliveAt: string;
  /** Räknad pauslängd vid pulsslaget, i ms. Lagras i stället för att räknas
   *  ut ur tidsstämplarna vid återställning: klockan kan ha stått frusen
   *  (telefonen uppåtvänd) delar av tiden, och den tiden är inte paus. */
  elapsedMs: number;
  userId: string;
  category?: string;
  pauseType: 'session' | 'regulate' | 'sleep';
  targetSeconds?: number;
  sharedSessionId?: string;
  /** Värd (bjöd in) eller gäst (hängde på). Avgör om återställningen stänger
   *  inbjudningarna eller markerar den egna som slutförd
   *  (lib/pauseInvites.ts). */
  sharedRole?: 'host' | 'guest';
  // ── Bara en natt (pauseType 'sleep') ──
  /** ISO — första gången telefonen lades ner, läggdags. */
  firstRestAt?: string;
  wakeCount?: number;
  awakeMs?: number;
  /** Gick klockan när appen lämnades (nedåtvänd och still)? Då sov
   *  användaren vidare efter den sista pulsen, och återställningen räknar
   *  fram till att appen öppnades igen i stället för att stanna vid pulsen. */
  runningAtLeave?: boolean;
  // ── En dagpaus som blivit en natt vid midnatt (app/pausing.tsx) ──
  /** ISO — där natten började (midnatt, eller när telefonen lades ner efter
   *  den). Dagdelen är då `dayMs`, och `elapsedMs` räknar båda. Saknas den
   *  och pausen ändå passerade midnatt kapas den där vid återställningen. */
  nightStartAt?: string;
  dayMs?: number;
}

export const saveSessionCheckpoint = async (checkpoint: SessionCheckpoint): Promise<void> => {
  try {
    await AsyncStorage.setItem(SESSION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch (e) {}
};

export const loadSessionCheckpoint = async (): Promise<SessionCheckpoint | null> => {
  try {
    const raw = await AsyncStorage.getItem(SESSION_CHECKPOINT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

export const clearSessionCheckpoint = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(SESSION_CHECKPOINT_KEY);
  } catch (e) {}
};

export const DEFAULT_CATEGORIES = [
{ id: 'focus', label: 'FOCUS', emoji: '🎯' },
{ id: 'walk', label: 'WALK', emoji: '🚶' },
{ id: 'workout', label: 'WORKOUT', emoji: '💪' },
{ id: 'social', label: 'SOCIAL', emoji: '💬' },
{ id: 'clean', label: 'CLEAN', emoji: '🧹' },
{ id: 'meditate', label: 'MEDITATION', emoji: '🧘' },
{ id: 'read', label: 'READING', emoji: '📖' },
{ id: 'study', label: 'STUDY', emoji: '✏️' },
{ id: 'rest', label: 'REST', emoji: '😴' },
{ id: 'create', label: 'CREATE', emoji: '🎨' },
{ id: 'music', label: 'MUSIC', emoji: '🎵' },
{ id: 'nature', label: 'NATURE', emoji: '🌲' },
];

export interface Category {
  id: string;
  label: string;
  emoji: string;
}

export interface PauseLog {
  date: string;
  duration: number;
  mode: 'session';
  category?: string;
}

const CUSTOM_CATEGORIES_PATH = 'customCategories.json';

// ── Intentionerna i Supabase ─────────────────────────────────────────────
//
// Källan är `user_intentions` (supabase/intentions.sql); de två filerna är en
// cache, så att pausskärmen läser direkt och utan nät. Varje skrivning går
// till filen först och sedan upp, och vid inloggning hämtas raden ner
// (`syncIntentions`). Filerna rivs vid utloggning (lib/localAccountData.ts).
//
// Uppskickningen läser filerna när den körs, inte när den köades, och
// köerna körs i tur och ordning — två snabba tryck kan alltså inte landa i
// fel ordning, och den sista skrivningen är alltid den som står kvar.
// Misslyckas den ligger `INTENTIONS_DIRTY_KEY` kvar, och nästa appstart
// skickar upp i stället för att hämta ner.
export const INTENTIONS_DIRTY_KEY = 'intentions_dirty';

const readJson = async <T,>(name: string): Promise<T | null> => {
  try { return JSON.parse(await readDoc(name)) as T; } catch { return null; }
};

let pushChain: Promise<void> = Promise.resolve();

const pushIntentions = () => {
  AsyncStorage.setItem(INTENTIONS_DIRTY_KEY, '1').catch(() => {});
  pushChain = pushChain.then(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user.id;
    if (!userId) return;
    const selected = await readJson<string[]>(CATEGORIES_PATH);
    const custom = (await readJson<Category[]>(CUSTOM_CATEGORIES_PATH)) ?? [];
    const { error } = await supabase
      .from('user_intentions')
      .upsert({ user_id: userId, selected, custom, updated_at: new Date().toISOString() });
    if (error) {
      console.warn('[intentions] kunde inte sparas:', error.message);
      await AsyncStorage.setItem(INTENTIONS_DIRTY_KEY, '1');
      return;
    }
    await AsyncStorage.removeItem(INTENTIONS_DIRTY_KEY);
  }).catch(() => {});
};

/**
 * Vid inloggning (contexts/AuthContext.tsx). Finns en rad hämtas den ner över
 * filerna. Finns ingen är det en installation från före tabellen, och det som
 * ligger lokalt skickas upp. Ett nätfel lämnar filerna som de är.
 */
export const syncIntentions = async (userId: string) => {
  try {
    if (await AsyncStorage.getItem(INTENTIONS_DIRTY_KEY)) { pushIntentions(); return; }
    const { data, error } = await supabase
      .from('user_intentions')
      .select('selected, custom')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) { console.warn('[intentions] kunde inte hämtas:', error.message); return; }
    if (!data) {
      const hasLocal = (await readJson(CATEGORIES_PATH)) !== null || (await readJson(CUSTOM_CATEGORIES_PATH)) !== null;
      if (hasLocal) pushIntentions();
      return;
    }
    // null = aldrig valt; filen tas bort så att getSelectedCategories ger förvalet.
    if (data.selected === null) await deleteDoc(CATEGORIES_PATH);
    else await writeDoc(CATEGORIES_PATH, JSON.stringify(data.selected));
    await writeDoc(CUSTOM_CATEGORIES_PATH, JSON.stringify(data.custom ?? []));
  } catch (e) {}
};

export const saveSelectedCategories = async (categoryIds: string[]) => {
  try {
    await writeDoc(CATEGORIES_PATH, JSON.stringify(categoryIds));
  } catch (e) {}
  pushIntentions();
};

/** Den sparade listan, eller `null` om inget val gjorts (förvalet gäller). */
export const getSelectedCategoryIds = () => readJson<string[]>(CATEGORIES_PATH);

export const getCustomCategories = async (): Promise<Category[]> =>
  (await readJson<Category[]>(CUSTOM_CATEGORIES_PATH)) ?? [];

export const saveCustomCategories = async (cats: Category[]) => {
  try {
    await writeDoc(CUSTOM_CATEGORIES_PATH, JSON.stringify(cats));
  } catch (e) {}
  pushIntentions();
};

export const getSelectedCategories = async (): Promise<Category[]> => {
  try {
    const saved = await readDoc(CATEGORIES_PATH);
    const ids: string[] = JSON.parse(saved);

    let customCats: Category[] = [];
    try {
      const custom = await readDoc(CUSTOM_CATEGORIES_PATH);
      customCats = JSON.parse(custom);
    } catch (e) {}

    const allCategories = [...DEFAULT_CATEGORIES, ...customCats];
    return allCategories.filter(c => ids.includes(c.id));
  } catch (e) {
    // Inget sparat val finns ännu — då gäller alla standardkategorier.
    //
    // Skillnaden mot att returnera [] är hela pausskärmens kategorirad:
    // introduktionen frågar inte längre om aktiviteter (se CLAUDE.md), så den
    // här grenen är numera vad *varje* ny användare möter. Tomt hade gett en
    // rubrik utan rad, och valet hade bara gått att nå via plusknappens modal.
    //
    // Att grenen sitter i catch och inte efter en längdkoll är poängen:
    // readDoc kastar när filen aldrig skrivits, medan ett sparat [] parsar
    // till en tom lista. Den som medvetet tömt sin lista i Settings behåller
    // alltså sitt val — bara den som aldrig valt får standarduppsättningen.
    return [...DEFAULT_CATEGORIES];
  }
};

export const getAllCategories = async (): Promise<Category[]> => {
  let customCats: Category[] = [];
  try {
    const custom = await readDoc(CUSTOM_CATEGORIES_PATH);
    customCats = JSON.parse(custom);
  } catch (e) {}
  return [...DEFAULT_CATEGORIES, ...customCats];
};

/**
 * En egen intention, skapad utanför profilen (vanornas väljare på Hem). Samma
 * form som `addCustom` i components/intention-settings.tsx: den sparas bland
 * de egna och läggs till bland de valda, så att den också erbjuds före pausen
 * — en vana man inte kan välja före pausen går bara att tagga efteråt.
 *
 * Har inget val sparats än börjar listan på alla standardintentioner, inte på
 * tomt: utan det hade den nya blivit den enda pausskärmen erbjöd (samma
 * skillnad som `getSelectedCategories` gör i sin catch).
 */
export const addCustomCategory = async (emoji: string, label: string): Promise<Category> => {
  const cat: Category = { id: 'custom_' + Date.now(), label: label.trim().toUpperCase(), emoji: emoji.trim() };
  let customCats: Category[] = [];
  try { customCats = JSON.parse(await readDoc(CUSTOM_CATEGORIES_PATH)); } catch (e) {}
  await writeDoc(CUSTOM_CATEGORIES_PATH, JSON.stringify([...customCats, cat]));
  let ids: string[];
  try { ids = JSON.parse(await readDoc(CATEGORIES_PATH)); } catch (e) { ids = DEFAULT_CATEGORIES.map(c => c.id); }
  await saveSelectedCategories([...ids, cat.id]);
  return cat;
};

export const findCategoryById = async (id: string): Promise<Category | null> => {
  let customCats: Category[] = [];
  try {
    const custom = await readDoc(CUSTOM_CATEGORIES_PATH);
    customCats = JSON.parse(custom);
  } catch (e) {}
  return [...DEFAULT_CATEGORIES, ...customCats].find(c => c.id === id) ?? null;
};

export const logPause = async (
  duration: number,
  mode: 'session',
  category?: string,
) => {
  try {
    let logs: PauseLog[] = [];
    try {
      const existing = await readDoc(LOG_PATH);
      logs = JSON.parse(existing);
    } catch (e) {}

    const newLog: PauseLog = {
      date: new Date().toISOString(),
      duration,
      mode,
      category,
    };

    logs.push(newLog);
    await writeDoc(LOG_PATH, JSON.stringify(logs));
  } catch (e) {}
};

export const getLogs = async (): Promise<PauseLog[]> => {
  try {
    const existing = await readDoc(LOG_PATH);
    return JSON.parse(existing);
  } catch (e) {
    return [];
  }
};
