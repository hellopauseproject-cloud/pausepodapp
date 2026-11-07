import { supabase } from './supabase';

/**
 * Hjärtat tillbaka för ett stödsvar. Schemat och skälen står i
 * [supabase/support_thanks.sql](../supabase/support_thanks.sql).
 */

export type SupportThanks = {
  responseId: string;
  thankedAt: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  activity: string | null;
};

/** Hjärtar (eller tar tillbaka) ett svar man fått. `true` om det gick. */
export async function thankSupportResponse(responseId: string, on = true): Promise<boolean> {
  const { data, error } = await supabase.rpc('thank_support_response', {
    p_response_id: responseId, p_on: on,
  });
  return !error && data === true;
}

/** Hjärtan på mina svar som jag inte sett än. Tom lista om SQL:en saknas. */
export async function fetchUnseenThanks(): Promise<SupportThanks[]> {
  const { data, error } = await supabase.rpc('get_unseen_support_thanks');
  if (error || !data) return [];
  return (data as any[]).map(r => ({
    responseId: r.response_id,
    thankedAt: r.thanked_at,
    userId: r.user_id,
    username: r.username ?? 'A friend',
    avatarUrl: r.avatar_url ?? null,
    activity: r.activity ?? null,
  }));
}

export async function markThanksSeen(responseIds: string[]): Promise<void> {
  if (responseIds.length === 0) return;
  await supabase.rpc('mark_support_thanks_seen', { p_response_ids: responseIds });
}
