import { useSyncExternalStore } from 'react';

import { track } from './analytics';
import { isPausingNow } from './pausingFlag';
import { supabase } from './supabase';

/**
 * Pausinbjudningar — "jag pausar, häng med".
 *
 * Schemat och reglerna bor i [supabase/pause_invites.sql](../supabase/pause_invites.sql);
 * den här filen är allt klienten gör med dem. Kort:
 *
 * - **Man väljer vänner på Hem, och inbjudan går ut när pausen startar.**
 *   Ingen väntar på ett ja. Valet ligger i butiken nedan tills pausskärmen
 *   tar det (`takePauseInviteSelection`), så det följer med oavsett vilken
 *   väg pausen startas — direkt från Hem eller via valskärmen.
 * - **Dörren står öppen så länge värden pausar, högst 30 minuter.** Spärren
 *   sitter i SQL; klienten gömmer bara utgångna kort.
 * - **Att inte hänga på syns inte för någon.** Det finns inget nej.
 */

export type InvitableFriend = {
  id: string;
  username: string;
  avatar_url: string | null;
  /** `profiles.is_pausing` — en vän som redan pausar kan inte bjudas in. */
  is_pausing: boolean;
};

/** En inbjudan som väntar på mig, för Friends. */
export type IncomingPauseInvite = {
  id: string;
  sharedId: string;
  host: { id: string; username: string; avatar_url: string | null };
  expiresAt: string;
};

/** En annan person i samma paus, för sammanfattningen. */
export type SharedPausePerson = {
  user_id: string;
  username: string;
  avatar_url: string | null;
  is_host: boolean;
  still_pausing: boolean;
  seconds: number | null;
  joined_after_seconds: number;
};

/**
 * Hur länge dörren står öppen, högst — `pause_invite_window()` i SQL.
 * Klienten använder talet bara för att visa när värden började; spärren
 * sitter i `join_pause_invite`. Ändras det ena ska det andra följa med.
 */
export const PAUSE_INVITE_WINDOW_MS = 30 * 60_000;

/** Samma tak som `send_pause_invites` — en krets, inte ett utskick. */
export const MAX_PAUSE_INVITEES = 8;

// ── Valet på Hem ──────────────────────────────────────────────────────────
//
// En delad butik och inte skärmens tillstånd, av samma skäl som
// lib/homeMode.ts: Hem väljer, pausskärmen tar. Den lever bara i minnet —
// ett val som överlevde en omstart hade bjudit in folk till en paus någon
// annan dag än den man valde dem för.

let selection: InvitableFriend[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getPauseInviteSelection(): InvitableFriend[] {
  return selection;
}

export function usePauseInviteSelection(): InvitableFriend[] {
  return useSyncExternalStore(subscribe, getPauseInviteSelection, getPauseInviteSelection);
}

export function setPauseInviteSelection(next: InvitableFriend[]) {
  selection = next.slice(0, MAX_PAUSE_INVITEES);
  emit();
}

/**
 * Tömmer valet och lämnar det till den som ska skicka. Anropas av
 * pausskärmen när en paus startar — **valet följer med en paus, inte flera**:
 * nästa ensamma paus ska inte tyst bjuda in samma personer igen.
 */
export function takePauseInviteSelection(): InvitableFriend[] {
  const taken = selection;
  if (taken.length === 0) return taken;
  selection = [];
  emit();
  return taken;
}

// ── Vänlistan för väljaren ────────────────────────────────────────────────

export async function fetchInvitableFriends(userId: string): Promise<InvitableFriend[]> {
  const { data, error } = await supabase
    .from('friendships')
    .select(`
      requester_id,
      requester:profiles!requester_id(id, username, avatar_url, is_pausing, pausing_until),
      receiver:profiles!receiver_id(id, username, avatar_url, is_pausing, pausing_until)
    `)
    .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
    .eq('status', 'accepted');
  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((f: any) => (f.requester_id === userId ? f.receiver : f.requester))
    .filter((p: any) => !!p)
    .map((p: any) => ({
      id: p.id,
      username: p.username ?? '?',
      avatar_url: p.avatar_url?.startsWith('https://') ? p.avatar_url : null,
      is_pausing: isPausingNow(p),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ── Värden ────────────────────────────────────────────────────────────────

/** Samma form som `pause_sessions.shared_session_id`. */
export function newSharedId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Skickar inbjudningarna. Väntas inte in av pausen: den har redan börjat,
 * och en inbjudan som inte gick fram får aldrig hindra den. Följden av ett
 * fel är bara att ingen kan hänga på — sammanfattningen visar då ingen.
 */
export async function sendPauseInvites(sharedId: string, inviteeIds: string[]): Promise<void> {
  if (inviteeIds.length === 0) return;
  const { error } = await supabase.rpc('send_pause_invites', {
    p_shared_id: sharedId,
    p_invitee_ids: inviteeIds,
  });
  if (error) {
    console.log('[pauseInvites] send error:', error.message);
    return;
  }
  track('shared_pause_invite_sent', { invitees: inviteeIds.length });
}

/**
 * Värden slutar. `seconds` null betyder att pausen övergavs (bakåtknappen):
 * dörren stängs, men ingen längd påstås.
 */
export async function closePauseInvites(sharedId: string, seconds: number | null): Promise<void> {
  try {
    await supabase.rpc('close_pause_invites', { p_shared_id: sharedId, p_seconds: seconds });
  } catch {
    // Faller den stänger `expires_at` dörren i stället.
  }
}

// ── Gästen ────────────────────────────────────────────────────────────────

/**
 * Öppna inbjudningar till mig, nyaste först. "Öppen" räknas här på samma sätt
 * som `join_pause_invite` gör, så att kortet aldrig erbjuder något servern
 * säger nej till — utom i sekunden då värden hinner sluta emellan.
 *
 * Samma villkor som flikbrickan (`countOpenPauseInvites`): brickan räknar det
 * fliken visar.
 */
export async function fetchIncomingPauseInvites(userId: string): Promise<IncomingPauseInvite[]> {
  const { data, error } = await supabase
    .from('pause_invites')
    .select('id, shared_id, expires_at, host:profiles!host_id(id, username, avatar_url)')
    .eq('invitee_id', userId)
    .is('joined_at', null)
    .is('dismissed_at', null)
    .is('closed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) return [];

  // En värd med två öppna inbjudningar (en paus som övergavs och en ny) visas
  // en gång — den nyaste är den som gäller.
  const seen = new Set<string>();
  const out: IncomingPauseInvite[] = [];
  for (const r of (data ?? []) as any[]) {
    if (!r.host || seen.has(r.host.id)) continue;
    seen.add(r.host.id);
    out.push({
      id: r.id,
      sharedId: r.shared_id,
      expiresAt: r.expires_at,
      host: {
        id: r.host.id,
        username: r.host.username ?? '?',
        avatar_url: r.host.avatar_url?.startsWith('https://') ? r.host.avatar_url : null,
      },
    });
  }
  return out;
}

export async function countOpenPauseInvites(userId: string): Promise<number> {
  return (await fetchIncomingPauseInvites(userId)).length;
}

/** Kastar med serverns mening om dörren hunnit stängas. */
export async function joinPauseInvite(inviteId: string): Promise<{ sharedId: string; hostName: string }> {
  const { data, error } = await supabase.rpc('join_pause_invite', { p_invite_id: inviteId });
  if (error) throw new Error(error.message);
  const d = data as { shared_id: string; host_name: string | null };
  track('shared_pause_joined');
  return { sharedId: d.shared_id, hostName: d.host_name ?? 'your friend' };
}

export async function dismissPauseInvite(inviteId: string): Promise<void> {
  await supabase.rpc('dismiss_pause_invite', { p_invite_id: inviteId });
  track('shared_pause_dismissed');
}

/** `seconds` null: gästen gav upp pausen, och ingen längd påstås. */
export async function finishPauseInvite(sharedId: string, seconds: number | null): Promise<void> {
  try {
    await supabase.rpc('finish_pause_invite', { p_shared_id: sharedId, p_seconds: seconds });
  } catch {
    // Raden står då kvar som "still pausing" hos de andra. Ingen skada på
    // pausen själv, som redan är sparad.
  }
}

// ── Sammanfattningen ──────────────────────────────────────────────────────

export async function getSharedPausePeople(sharedId: string): Promise<SharedPausePerson[]> {
  const { data, error } = await supabase.rpc('get_shared_pause_people', { p_shared_id: sharedId });
  if (error || !Array.isArray(data)) return [];
  return data as SharedPausePerson[];
}
