import { track } from './analytics';
import { supabase } from './supabase';

/**
 * Rapportera och blockera. Schemat och reglerna bor i supabase/moderation.sql
 * — här ligger bara vägen dit. Krav från Google Plays regler för
 * användargenererat innehåll, och det ska stämma med villkoren på
 * {@link TERMS_URL}.
 *
 * **Blockeringen verkställs i databasen, inte här.** Att skriva raden i
 * `blocks` räcker: en trigger river vänskapen och inbjudningarna, och
 * policyerna gömmer resten åt båda hållen. Klienten behöver inte filtrera
 * något själv, och den blockerade får ingenting veta.
 */

export const TERMS_URL = 'https://joinpausepod.com/privacypolicy/#terms';
export const PRIVACY_URL = 'https://joinpausepod.com/privacypolicy/';

/** Vad som rapporteras. Samma värden som `reports.content_type`. */
export type ReportContentType = 'message' | 'support' | 'photo' | 'profile';

/** Orsakerna i den ordning arket visar dem. Id:na är `reports.reason`, och
 *  etiketterna står också i edge-funktionen notify-report. */
export const REPORT_REASONS = [
  { id: 'sexual', label: 'Nudity or sexual content' },
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'hate', label: 'Hate' },
  { id: 'violence', label: 'Threats, violence or self-harm' },
  { id: 'spam', label: 'Spam or fake account' },
  { id: 'other', label: 'Something else' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['id'];

export type ReportTarget = {
  contentType: ReportContentType;
  /** Raden som rapporteras. Null för en profil. */
  contentId: string | null;
  /** Krävs för en profil; annars slår servern upp vem som skrev innehållet. */
  userId?: string | null;
};

/**
 * Skickar en rapport. Kastar vid fel, så att arket kan säga det i stället
 * för att tacka för en rapport som aldrig kom fram.
 */
export async function sendReport(target: ReportTarget, reason: ReportReason, details: string): Promise<void> {
  const { error } = await supabase.rpc('report_content', {
    p_content_type: target.contentType,
    p_content_id: target.contentId,
    p_reported_user_id: target.userId ?? null,
    p_reason: reason,
    p_details: details.trim() || null,
  });
  if (error) throw new Error(error.message);
  // Ingen text i händelseloggen, bara sorten (se CLAUDE.md, *Ingen text, aldrig*).
  track('report_sent', { content_type: target.contentType, reason });
}

export async function blockUser(myId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('blocks').insert({ blocker_id: myId, blocked_id: userId });
  // 23505: redan blockerad — samma utfall som ett lyckat försök.
  if (error && error.code !== '23505') throw new Error(error.message);
  track('user_blocked');
}

/** Unblock lägger inte tillbaka vänskapen; den revs när blockeringen skrevs. */
export async function unblockUser(myId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('blocks').delete().eq('blocker_id', myId).eq('blocked_id', userId);
  if (error) throw new Error(error.message);
  track('user_unblocked');
}

export type BlockedUser = { id: string; username: string; avatarUrl: string | null; blockedAt: string };

/** Bara de man själv blockerat — RLS släpper aldrig igenom åt andra hållet. */
export async function fetchBlockedUsers(myId: string): Promise<BlockedUser[]> {
  const { data, error } = await supabase
    .from('blocks')
    .select('blocked_id, created_at, profile:profiles!blocked_id(username, avatar_url)')
    .eq('blocker_id', myId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    id: r.blocked_id,
    username: r.profile?.username ?? 'Someone',
    avatarUrl: r.profile?.avatar_url ?? null,
    blockedAt: r.created_at,
  }));
}

/** Servern sätter tiden. Kastar vid fel så att grinden står kvar. */
export async function acceptTerms(): Promise<void> {
  const { error } = await supabase.rpc('accept_terms');
  if (error) throw new Error(error.message);
  track('terms_accepted');
}

/**
 * Kryssrutan på registreringen gäller också Google och Apple, men där finns
 * ingen `user_metadata` att lägga godkännandet i innan kontot finns. Det
 * hålls i minnet tills AuthContext ser sessionen och skriver det med
 * {@link acceptTerms}. Startas appen om innan dess frågar grinden igen.
 */
let termsAgreedBeforeSignIn = false;

export function noteTermsAgreedBeforeSignIn(): void {
  termsAgreedBeforeSignIn = true;
}

export function takeTermsAgreedBeforeSignIn(): boolean {
  const v = termsAgreedBeforeSignIn;
  termsAgreedBeforeSignIn = false;
  return v;
}
