import { type Category, DEFAULT_CATEGORIES } from '../app/pauseLogger';
import { supabase } from './supabase';

/**
 * Kretsens intentioner (supabase/circle_intentions.sql): tiden per medlem
 * och intention för en period, och taggen på flödets pausrader läst ur
 * pausen nu, så att en tagg som sätts efteråt syns.
 *
 * Nycklarna är de inbyggda intentionernas id (`read`, `walk` …) eller
 * `other` — en egen intention lämnas aldrig ut med namn. Den regeln sitter i
 * SQL (`circle_intention_key`), inte här.
 */

export type IntentionKey = string;

/** Allt som inte är en inbyggd intention. Ingen ton och ingen verbfras av sitt eget. */
export const OTHER_INTENTION: Category = { id: 'other', label: 'OTHER', emoji: '✨' };
/** Pauser utan intention. Står sist och tonad, så att raderna går ihop med potten. */
export const UNTAGGED_KEY = 'untagged';
const UNTAGGED_INTENTION: Category = { id: UNTAGGED_KEY, label: 'UNTAGGED', emoji: '⏸️' };

export function intentionCategory(key: IntentionKey): Category {
  if (key === UNTAGGED_KEY) return UNTAGGED_INTENTION;
  return DEFAULT_CATEGORIES.find(c => c.id === key) ?? OTHER_INTENTION;
}

export type CircleIntentionRow = { user_id: string; intention: IntentionKey; seconds: number };

export async function getCircleIntentions(
  circleId: string, mode: 'week' | 'day', date: string,
): Promise<CircleIntentionRow[] | null> {
  const { data, error } = await supabase.rpc('get_circle_intentions', {
    p_circle_id: circleId,
    p_mode: mode,
    p_date: date,
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
  });
  if (error) {
    console.log('[circleIntentions] get error:', error.message);
    return null;
  }
  return (data as CircleIntentionRow[]) ?? [];
}

/** Flödesradens id → intentionens nyckel. Tomt vid fel: flödet faller då tillbaka på det som valdes före pausen. */
export async function getCircleActivityTags(circleId: string): Promise<Record<string, IntentionKey>> {
  const { data, error } = await supabase.rpc('get_circle_activity_tags', { p_circle_id: circleId });
  if (error) {
    console.log('[circleIntentions] tags error:', error.message);
    return {};
  }
  return (data as Record<string, IntentionKey>) ?? {};
}

/** Summerar till en rad per intention, flest sekunder först och de otaggade sist. `userId` null = hela kretsen. */
export function sumIntentions(rows: CircleIntentionRow[], userId: string | null): { key: IntentionKey; seconds: number }[] {
  const by = new Map<IntentionKey, number>();
  for (const r of rows) {
    if (userId && r.user_id !== userId) continue;
    by.set(r.intention, (by.get(r.intention) ?? 0) + r.seconds);
  }
  return [...by.entries()]
    .map(([key, seconds]) => ({ key, seconds }))
    .filter(r => r.seconds > 0)
    .sort((a, b) => Number(a.key === UNTAGGED_KEY) - Number(b.key === UNTAGGED_KEY) || b.seconds - a.seconds);
}
