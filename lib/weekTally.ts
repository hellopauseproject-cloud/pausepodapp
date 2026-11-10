import { type Category, getAllCategories } from '../app/pauseLogger';
import { supabase } from './supabase';

/**
 * Veckans taggar som streck på Hem (components/week-tally.tsx): de egna
 * pauserna sedan måndag 00:00 i telefonens tid, grupperade på intention, ett
 * streck per paus. Ingen målsiffra och inget tak — det är en spegel av vad
 * man gjort, inte en uppgift. Den ersatte vanemålen, som nästan ingen satte.
 *
 * Bara `kind = 'pause'`: en natt är ingen paus (supabase/sleep.sql).
 * Intentionen ligger som etikett (`READING`) eller id (`read`, lådflödets
 * kö), så båda matchas — samma regel som statistiken och habits.sql.
 *
 * **De otaggade står sist, som en egen rad** (`untagged: true`), och ritas
 * tonade. De räknas från en minut — samma gräns som taggkortet frågar vid —
 * så att en paus som aldrig fick frågan inte står som en lucka.
 */

export type TallyRow = { category: Category; count: number; untagged?: boolean };

/** Raden för pauser utan intention. */
export const UNTAGGED: Category = { id: 'untagged', label: 'UNTAGGED', emoji: '⏸️' };
// Samma gräns som taggkortet på Hem (`TAG_MIN_SECONDS`).
const UNTAGGED_MIN_SECONDS = 60;

/** Måndag 00:00 i telefonens tid, samma vecka som habits.sql räknar. */
export function weekStart(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export async function getWeekTally(userId: string): Promise<TallyRow[]> {
  const [{ data, error }, cats] = await Promise.all([
    supabase
      .from('pause_sessions')
      .select('intention, ended_at, duration_seconds')
      .eq('user_id', userId)
      .eq('kind', 'pause')
      .gte('ended_at', weekStart().toISOString()),
    getAllCategories(),
  ]);
  if (error) {
    console.log('[weekTally] error:', error.message);
    return [];
  }
  const find = (intention: string) => {
    const key = intention.trim().toUpperCase();
    return cats.find(c => c.label.toUpperCase() === key || c.id.toUpperCase() === key);
  };
  const rows = new Map<string, TallyRow & { last: string }>();
  let untagged = 0;
  for (const s of data ?? []) {
    if (!s.intention?.trim()) {
      if ((s.duration_seconds ?? 0) >= UNTAGGED_MIN_SECONDS) untagged += 1;
      continue;
    }
    const cat = find(s.intention);
    // En egen intention som tagits bort finns inte längre att visa.
    if (!cat) continue;
    const row = rows.get(cat.id);
    if (row) {
      row.count += 1;
      if (s.ended_at > row.last) row.last = s.ended_at;
    } else {
      rows.set(cat.id, { category: cat, count: 1, last: s.ended_at });
    }
  }
  // Flest först; vid lika den senast använda. De otaggade alltid sist.
  const tagged: TallyRow[] = [...rows.values()]
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
    .map(({ category, count }) => ({ category, count }));
  return untagged > 0 ? [...tagged, { category: UNTAGGED, count: untagged, untagged: true }] : tagged;
}
