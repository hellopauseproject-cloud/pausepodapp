import { track } from './analytics';
import { supabase } from './supabase';

/**
 * Vanorna: en intention och ett antal dagar i veckan (*📖 Reading · 3× a
 * week*). Räkningen och reglerna — dagar och inte pauser, lokal måndag,
 * golvet på fem minuter, bara pauser — bor i supabase/habits.sql. Klienten
 * räknar ingenting själv.
 *
 * **Vilande sedan november 2026:** ingen yta i appen läser eller sätter dem
 * längre. Hems hörn visar i stället veckans taggar utan mål
 * (lib/weekTally.ts). Filen, components/habit-goals-editor.tsx och
 * supabase/habits.sql står kvar så att vanemålen går att ta tillbaka.
 */

/** Speglar taket i `set_habit_goals` — de två måste stämma. */
export const MAX_HABITS = 3;
/** Förvalet när en vana läggs till: tre dagar är en vana men inget krav. */
export const DEFAULT_HABIT_TIMES = 3;

export type HabitGoal = {
  category_id: string;
  /** Intentionens etikett vid sparningen (`READING`), se habits.sql. */
  label: string;
  times_per_week: number;
};

export type HabitProgress = HabitGoal & { done_this_week: number };

export async function getHabitProgress(): Promise<HabitProgress[]> {
  const { data, error } = await supabase.rpc('get_habit_progress', {
    p_tz_offset_minutes: new Date().getTimezoneOffset(),
  });
  if (error) {
    console.log('[habits] getHabitProgress error:', error.message);
    return [];
  }
  return (data as HabitProgress[]) ?? [];
}

export async function setHabitGoals(goals: HabitGoal[]): Promise<void> {
  const { error } = await supabase.rpc('set_habit_goals', {
    p_goals: goals.map(g => ({
      category_id: g.category_id, label: g.label, times_per_week: g.times_per_week,
    })),
  });
  if (error) throw new Error(error.message);
  track('habit_goals_set', {
    count: goals.length,
    habits: goals.map(g => `${g.category_id}:${g.times_per_week}`).join(','),
  });
}

/** Har användaren ändrat något jämfört med det som sparats? */
export function habitsChanged(a: HabitGoal[], b: HabitGoal[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((g, i) => g.category_id !== b[i].category_id || g.times_per_week !== b[i].times_per_week);
}
