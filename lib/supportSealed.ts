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
