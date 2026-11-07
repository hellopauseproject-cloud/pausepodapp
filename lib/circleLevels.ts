/**
 * Stegen — cirkelns nivåer, räknade på summan av alla medlemmars pauser genom
 * alla tider (`circle_pause_ledger`, exponerad som `lifetime_seconds`). Inte
 * ett snitt per medlem, inte veckans siffra.
 *
 * **Trösklarna här är en spegel, inte källan.** Nivånumret räknas i databasen
 * av `circle_level_for_seconds()` i [supabase/circles.sql], eftersom det är
 * där `circle_level_ups` och flödets `level_up`-händelser skrivs. Den här
 * filen finns för att appen ska kunna visa *hela* listan — namn, trösklar och
 * hur långt det är kvar till varje steg — utan en extra rundtur till servern.
 * Ändrar du en siffra här måste du ändra samma siffra i SQL-filen och köra om
 * den, annars visar stegen en nivå och flödet en annan.
 */

export type CircleLevel = {
  name: string;
  hoursRequired: number;
};

/**
 * Ordnad från nivå 1 och uppåt: index 0 är nivå 1. Nivå 1 ligger på 0 timmar
 * — man är med i stegen från första stunden, inte först när man förtjänat det.
 *
 * Det sista steget bryter mönstret med flit: *Masters of PausePod* saknar
 * `Pausers`-suffixet så att toppen sticker ut mot stegen under. Det hette
 * `MYTHICAL PAUSERS` och byttes på begäran — det lät som en spelrang.
 */
export const CIRCLE_LEVELS: readonly CircleLevel[] = [
  { name: 'New Pausers', hoursRequired: 0 },
  { name: 'Committed Pausers', hoursRequired: 5 },
  { name: 'Steady Pausers', hoursRequired: 12 },
  { name: 'Habitual Pausers', hoursRequired: 25 },
  { name: 'All In Pausers', hoursRequired: 50 },
  { name: 'Unshakeable Pausers', hoursRequired: 100 },
  { name: 'Veteran Pausers', hoursRequired: 200 },
  { name: 'Elite Pausers', hoursRequired: 400 },
  { name: 'Legendary Pausers', hoursRequired: 800 },
  { name: 'Masters of PausePod', hoursRequired: 1500 },
];

/** Högsta nivån. Stegen tar slut här — det finns inget elfte steg. */
export const MAX_CIRCLE_LEVEL = CIRCLE_LEVELS.length;

const HOUR = 3600;

/** Tröskeln för en nivå i sekunder. Nivåer utanför skalan klampas in i den. */
export function circleLevelStartSeconds(level: number): number {
  const i = Math.max(1, Math.min(MAX_CIRCLE_LEVEL, Math.round(level))) - 1;
  return CIRCLE_LEVELS[i].hoursRequired * HOUR;
}

/** Namnet på en nivå. Klampar på samma sätt som tröskeln ovan. */
export function circleLevelName(level: number): string {
  const i = Math.max(1, Math.min(MAX_CIRCLE_LEVEL, Math.round(level))) - 1;
  return CIRCLE_LEVELS[i].name;
}

/**
 * Nivån för ett antal sekunder, 1-baserad. Speglar
 * `circle_level_for_seconds()` — behåll de två i takt.
 */
export function circleLevelForSeconds(seconds: number): number {
  let level = 1;
  for (let i = 0; i < CIRCLE_LEVELS.length; i++) {
    if (seconds >= CIRCLE_LEVELS[i].hoursRequired * HOUR) level = i + 1;
  }
  return level;
}

/**
 * Sekunder kvar till nästa steg, eller `null` på sista nivån — där finns
 * inget kvar att räkna ner mot, och ett 0 hade lästs som "nästan framme".
 */
export function secondsToNextLevel(seconds: number, level: number): number | null {
  if (level >= MAX_CIRCLE_LEVEL) return null;
  return Math.max(0, circleLevelStartSeconds(level + 1) - seconds);
}

/**
 * Hur långt in på sin nivå en cirkel är, 0–1.
 *
 * På sista nivån finns inget steg att räkna mot, och svaret är 1 — *i mål*,
 * inte *inte påbörjad*. Utan det specialfallet hade stegen ritat en tom
 * stapel åt den cirkel som klättrat hela vägen.
 */
export function levelProgressFraction(seconds: number, level: number): number {
  if (level >= MAX_CIRCLE_LEVEL) return 1;
  const start = circleLevelStartSeconds(level);
  const next = circleLevelStartSeconds(level + 1);
  const span = next - start;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (seconds - start) / span));
}
