/**
 * Baksidan av en paus kort i statistiken — det som står när man vänder det.
 *
 * Tre rader, uppifrån:
 *
 * 1. **En rekordrad** (`recordLine`) — den största saken som är *sann* om
 *    just den här pausen: längst hittills, längst den veckan, tredje
 *    promenaden den månaden, en tidig eller sen paus. Finns inget står
 *    ingenting. Räknas ur alla egna pauser, som statistiken redan hämtat
 *    (frågan där har inget tak), så "längst hittills" är faktiskt längst.
 * 2. **Ett citat** (`pauseQuote`), på varje kort, taggat eller inte.
 * 3. **När** (`contextLine`) — veckodag och klockslag.
 *
 * Det stod en gång två uppskattningar per tagg i mitten (18 min läsning ≈
 * 14 sidor) och dagens summa sist på raden. Båda togs bort på begäran:
 * citatet bär baksidan.
 *
 * Inga pronomen, ingen skuld, och ingenting här skrivs någonstans — det är
 * ren text ur rader som redan finns.
 */

export type FactSession = {
  id: string;
  durationSecs: number;
  /**
   * Taggen som en **nyckel**, inte som den står i raden: `intention` kan
   * vara en etikett (`FOCUS`) eller ett id (`focus`, i äldre rader), och
   * två pauser med samma tagg måste räknas ihop. Anroparen löser upp den
   * till kategorins id (stats.tsx, `factSessions`).
   */
  intention: string | null;
  startedAt: string;
  endedAt: string | null;
};

// ── 2. Citatet ─────────────────────────────────────────────────────────────
// Egna rader, inga tillskrivna — ett citat som läggs i någon kändis mun
// utan källa är just den sortens påstående appen inte gör. Inga pronomen
// för någon annan än läsaren, ingen skuld.
//
// UTKAST: listan väntar på godkännande. Stryk eller byt rader här — ordningen
// spelar ingen roll utöver att den avgör vilket kort som får vilket.
export const PAUSE_QUOTES = [
  'Taking a pause is not stopping. It is choosing what comes next.',
  'Nothing happened. That was the point.',
  'The world kept going. You got to stand still for a while.',
  'A pause is a small yes to yourself.',
  'Rest is not the opposite of doing. It is part of it.',
  'Proof that the phone can wait.',
  'Quiet minutes count too.',
  'You were somewhere else for a while. Good.',
  'The feed will still be there. This moment won’t.',
  'Some of the best minutes are the ones nobody sees.',
  'You looked up. That’s where life is.',
  'A little space goes a long way.',
  'Slow is a speed too.',
  'Not every minute needs a screen.',
  'Your attention is yours. You just took some back.',
  'Boredom is where ideas come from.',
  'The notifications didn’t miss you. You didn’t miss them either.',
  'Being here was enough.',
  'Time off the screen is time on your side.',
  'A pause makes the next thing better.',
  'Less scrolling, more living.',
  'Breathing room, earned.',
  'Sometimes the bravest thing is to do nothing.',
  'You gave your mind somewhere quiet to land.',
  'Every pause is practice.',
  'The best view is rarely on a screen.',
  'Stillness is a skill. You just trained it.',
  'Unplugged, unhurried, unbothered.',
  'Look at you, being a person.',
  'The phone was face down. You were face up.',
  'Minutes like these add up.',
  'You chose the real thing.',
  'Small pauses, big difference.',
  'Your thumbs got the afternoon off. Well, a few minutes.',
  'Nobody liked this. That’s what made it yours.',
  'A break is not a gap. It is a bridge.',
  'Here, now, offline.',
  'Having the world in your pocket can be exhausting. Good you took a pause.',
  'You deserve it.',
  'Calm is contagious. Start with yourself.',
  'That was time well kept.',
  'Not lost. Just offline for a bit.',
  'What you look at shapes how you feel. You looked away.',
  'A pause is how you hear yourself again.',
  'The screen can wait.',
  'Good things happen when the phone is face down.',
  'Fewer swipes, one moment gained.',
  'You stepped out of the noise for a while.',
  'Doing less, on purpose.',
  'A pause is a promise kept to yourself.',
];

/**
 * Citatet för pausen med plats `index` i tidsordning (äldst = 0). Att det är
 * platsen och inte ett hash av id:t är vad som gör citaten **unika**: de
 * första 50 pauserna får 50 olika, och först därefter börjar listan om.
 * Äldst först, så att en ny paus aldrig flyttar de gamlas citat — bara en
 * raderad äldre paus gör det.
 */
export function pauseQuote(index: number): string {
  return PAUSE_QUOTES[((index % PAUSE_QUOTES.length) + PAUSE_QUOTES.length) % PAUSE_QUOTES.length];
}

// ── 1. Rekordraden ─────────────────────────────────────────────────────────
// Substantivet för "din tredje X den här månaden".
const NOUNS: Record<string, string> = {
  focus: 'focus session', walk: 'walk', workout: 'workout', social: 'catch-up',
  clean: 'tidy-up', meditate: 'meditation', read: 'read', study: 'study session',
  rest: 'rest', create: 'creative break', music: 'music break', nature: 'nature break',
};

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function ordinal(n: number): string {
  if (n === 1) return 'first';
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** Måndag 00:00 lokalt för veckan `d` ligger i. */
function weekStart(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.getTime();
}

/**
 * Den största sanna saken om pausen, i den här ordningen: längst hittills,
 * längst den veckan, N:te av sin tagg den månaden, tidig/sen. `null` om
 * inget av det gäller. `all` är alla egna pauser (inte nätter).
 *
 * `catId` är den inbyggda taggens id, eller null. `catLabel` används för
 * egna taggar ("your 2nd yoga pause").
 */
export function recordLine(
  s: FactSession, all: FactSession[], catId: string | null, catLabel: string | null,
): string | null {
  if (!s.startedAt) return null;
  const start = new Date(s.startedAt);
  const now = new Date();
  const others = all.filter(o => o.id !== s.id && o.startedAt);

  // Längst hittills — bara när det finns något att slå, och bara strikt.
  if (others.length >= 2 && others.every(o => o.durationSecs < s.durationSecs)) {
    return 'Your longest pause yet';
  }

  // Längst den veckan.
  const wk = weekStart(start);
  const sameWeek = others.filter(o => weekStart(new Date(o.startedAt)) === wk);
  if (sameWeek.length >= 1 && sameWeek.every(o => o.durationSecs < s.durationSecs)) {
    return wk === weekStart(now) ? 'Your longest this week' : 'Longest of its week';
  }

  // N:te av sin tagg den månaden, räknat fram till och med den här.
  if (s.intention) {
    const noun = catId ? NOUNS[catId] : catLabel ? `${catLabel.toLowerCase()} pause` : null;
    if (noun) {
      const n = all.filter(o => {
        if (!o.startedAt || o.intention !== s.intention) return false;
        const d = new Date(o.startedAt);
        return d.getFullYear() === start.getFullYear() && d.getMonth() === start.getMonth()
          && d.getTime() <= start.getTime();
      }).length;
      const thisMonth = start.getFullYear() === now.getFullYear() && start.getMonth() === now.getMonth();
      return `Your ${ordinal(n)} ${noun} ${thisMonth ? 'this month' : `in ${MONTHS_LONG[start.getMonth()]}`}`;
    }
  }

  const h = start.getHours();
  if (h >= 4 && h < 8) return 'An early one · before 8 am';
  if (h >= 22 || h < 4) return 'A late one · after 10 pm';
  return null;
}

// ── 3. När ─────────────────────────────────────────────────────────────────
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** `Tue 06:12 – 06:30`. */
export function contextLine(s: FactSession): string {
  if (!s.startedAt) return '';
  const start = new Date(s.startedAt);
  const end = s.endedAt ? new Date(s.endedAt) : new Date(start.getTime() + s.durationSecs * 1000);
  return `${DAYS[start.getDay()]} ${hhmm(start)} – ${hhmm(end)}`;
}
