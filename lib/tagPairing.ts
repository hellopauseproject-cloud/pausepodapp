import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

/**
 * Kopplar en Pause-tagg (NFC-klistermärket på telefonen) till kontot.
 *
 * Lådan läser taggen, frågar edge-funktionen `box-tag` och visar en
 * engångskod som QR (`https://joinpausepod.com/pair?code=…`, som skickar
 * vidare till `pauseapp://pair?code=…`). Appen tar koden här och anropar
 * `claim-tag`. Appen skriver aldrig själv i `pause_tags` — koden är beviset
 * på att man står vid lådan med taggen, och den kan bara lösas in på servern.
 *
 * Schemat och funktionerna ligger i supabase/tag_pairing.sql och
 * supabase/functions/{box-tag,claim-tag}.
 */

export type PairError =
  | 'code_not_found'
  | 'code_expired'
  | 'code_used'
  | 'tag_taken'
  | 'not_signed_in'
  | 'network';

export type PairPreview = { ok: true; boxName: string } | { ok: false; error: PairError };
export type PairResult = { ok: true; alreadyYours: boolean } | { ok: false; error: PairError };

/** Koden är 6 tecken ur ett alfabet utan 0/O och 1/I/L. */
export const normalizePairCode = (raw: string) =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

export const PAIR_ERROR_TEXT: Record<PairError, string> = {
  code_not_found: "That code doesn't exist. Check the box screen.",
  code_expired: 'The code has expired. Lift your phone and place it again.',
  code_used: 'That code has already been used.',
  tag_taken: 'This tag belongs to someone else.',
  not_signed_in: 'Log in first.',
  network: 'No connection. Try again.',
};

type ClaimResponse = {
  ok: boolean;
  status?: 'valid' | 'claimed' | 'already_yours';
  box_name?: string;
  error?: PairError;
};

async function invokeClaim(code: string, preview: boolean): Promise<ClaimResponse> {
  const { data, error } = await supabase.functions.invoke<ClaimResponse>('claim-tag', {
    body: { code, preview },
  });
  if (data) return data;
  // Vid 4xx lägger supabase-js svaret i `error.context`, inte i `data`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context = (error as any)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as ClaimResponse;
      if (body?.error) return body;
    } catch {
      // faller igenom till nätverksfel
    }
  }
  return { ok: false, error: 'network' };
}

export async function previewTagPairing(code: string): Promise<PairPreview> {
  const res = await invokeClaim(code, true);
  if (res.ok) return { ok: true, boxName: res.box_name ?? 'PausePod' };
  return { ok: false, error: res.error ?? 'network' };
}

export async function claimTagPairing(code: string): Promise<PairResult> {
  const res = await invokeClaim(code, false);
  if (res.ok) return { ok: true, alreadyYours: res.status === 'already_yours' };
  return { ok: false, error: res.error ?? 'network' };
}

/* ---------- En kod som kom in medan ingen var inloggad ----------
 *
 * Länken kan öppna appen innan någon loggat in, och grinden i app/_layout.tsx
 * skickar då till inloggningen. Koden parkeras här och tas upp av grinden när
 * routningen väl sker. Den gäller bara några minuter på servern, så en
 * gammal lapp kastas.
 */

const PENDING_KEY = 'pause.pendingPairCode';
const PENDING_MAX_MS = 10 * 60 * 1000;

export async function setPendingPairCode(code: string) {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // Går lappen förlorad får man skanna igen.
  }
}

export async function takePendingPairCode(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    await AsyncStorage.removeItem(PENDING_KEY);
    const { code, at } = JSON.parse(raw) as { code: string; at: number };
    if (Date.now() - at > PENDING_MAX_MS) return null;
    return normalizePairCode(code) || null;
  } catch {
    return null;
  }
}

/* ---------- De egna taggarna (Settings) ----------
 *
 * Läses direkt mot `pause_tags`: RLS släpper bara igenom egna rader, och
 * klienten får bara uppdatera `label` och `deactivated_at`. En borttagen tagg
 * raderas inte utan inaktiveras, så att lådan slutar känna igen den men
 * historiken står kvar — och taggen kan registreras igen, av en själv eller
 * någon annan.
 */

export type MyTag = { id: string; tagUid: string; label: string | null; createdAt: string };

export async function fetchMyTags(): Promise<MyTag[] | null> {
  const { data, error } = await supabase
    .from('pause_tags')
    .select('id, tag_uid, label, created_at')
    .is('deactivated_at', null)
    .order('created_at', { ascending: true });
  if (error) return null;
  return (data ?? []).map(r => ({
    id: r.id as string,
    tagUid: r.tag_uid as string,
    label: (r.label as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

/** Sant om raden faktiskt ändrades (RLS som nekar ger inget fel, bara noll rader). */
export async function removeMyTag(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('pause_tags')
    .update({ deactivated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  return !error && (data?.length ?? 0) > 0;
}

/** `9B3C31CA` → `9B 3C 31 CA`, som lådan och testkoden skriver det. */
export const formatTagUid = (uid: string) => uid.match(/.{1,2}/g)?.join(' ') ?? uid;
