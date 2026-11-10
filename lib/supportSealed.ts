import { supabase } from './supabase';

/**
 * Stöd som öppnas efter en paus. Schemat och skälen står i
 * [supabase/support_sealed.sql](../supabase/support_sealed.sql).
 */

/**
 * Hur lång pausen måste vara för att öppna ett förseglat kuvert, i minuter.
 * Speglar `support_unlock_min_seconds()` (120 s) i supabase/support_sealed.sql
 * — ändras det ena ska det andra följa med, annars lovar kuvertet fel tid.
 */
export const SUPPORT_UNLOCK_MIN_MINUTES = 2;

export type SealedSupport = {
  responseId: string;
  createdAt: string;
  senderId: string;
  username: string;
  avatarUrl: string | null;
};

/**
 * *PAUSE TO OPEN* på kuvertet (app/support-arrived.tsx) lämnar en lapp här, och
 * en paus som slutar och är lång nog att låsa upp det går tillbaka till
 * kuvertet i stället för till Hem (app/pausesummary.tsx) — man pausade för
 * att få öppna det. Lappen lever i minnet och i högst `RETURN_MAX_MS`: avbryts
 * pausen och startas en annan senare samma kväll låser den ändå upp kuvertet,
 * och då är vägen tillbaka dit fortfarande rätt.
 */
const RETURN_MAX_MS = 6 * 60 * 60 * 1000;
let envelopeAfterPause: { responseId: string; at: number } | null = null;

export function setEnvelopeAfterPause(responseId: string): void {
  envelopeAfterPause = { responseId, at: Date.now() };
}

/** Lappen, en gång. `null` om ingen finns eller om den är för gammal. */
export function takeEnvelopeAfterPause(): string | null {
  const r = envelopeAfterPause;
  envelopeAfterPause = null;
  if (!r || Date.now() - r.at > RETURN_MAX_MS) return null;
  return r.responseId;
}

/** Förseglade svar som väntar på mig — vem och när, inget innehåll. */
export async function fetchSealedSupport(): Promise<SealedSupport[]> {
  const { data, error } = await supabase.rpc('get_sealed_support');
  if (error || !data) return [];
  return (data as any[]).map(r => ({
    responseId: r.response_id,
    createdAt: r.created_at,
    senderId: r.sender_id,
    username: r.username ?? 'A friend',
    avatarUrl: r.avatar_url ?? null,
  }));
}
