import { supabase } from './supabase';
import { unopenedResponsesQuery } from './supportStories';

/**
 * Stöd som öppnas efter en paus. Schemat och skälen står i
 * [supabase/support_sealed.sql](../supabase/support_sealed.sql).
 */

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

/**
 * Hur många förseglade svar som låsts upp av en paus men inte öppnats än —
 * *Your envelope is ready* på Hem. Noll om SQL:en inte körts.
 */
export async function countReadyEnvelopes(userId: string): Promise<number> {
  const { count, error } = await unopenedResponsesQuery(userId, 'id', { count: 'exact', head: true })
    .eq('opens_after_pause', true)
    .not('unlocked_at', 'is', null);
  return error ? 0 : (count ?? 0);
}
