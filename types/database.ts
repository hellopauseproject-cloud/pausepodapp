export type Profile = {
  id: string;
  username: string;
  avatar_url: string | null;
  show_stats: boolean;
  is_pausing: boolean;
  onboarding_completed: boolean;
  created_at: string;
  /**
   * De tre kolumnerna nedan hörde till den gamla notiskedjan, som revs
   * (supabase/notifications-teardown.sql). **Två av dem är i bruk igen**, och
   * inte som ett återställande utan för en ny funktion: kretsens
   * dagsmålsnotis i supabase/circle_goal_notify.sql.
   *
   * - `push_token` — skrivs av `registerPushToken()` i lib/notifications.ts
   *   vid varje appstart, och nollas av `clearPushToken()` vid utloggning.
   *   Läses bara av `notify_circle_goal_reached` i SQL, aldrig av en klient.
   *   Att nollningen vid utloggning finns är hela lärdomen ur teardown-filen:
   *   en kvarlämnad token tar emot push långt efter att klienten slutat bry
   *   sig.
   * - `tz_offset_minutes` — skrivs på samma ställe och bär **bara**
   *   nattfönstret 08–21 i mottagarens tid. Den styr inget "idag" i appen;
   *   varje dygnsgräns räknas fortfarande ur klientens egen
   *   `getTimezoneOffset()` som RPC-parameter.
   * - `notify_friend_pausing` — står fortfarande helt oläst och oskriven.
   *   Den hörde till vän-notisen på `is_pausing` false → true, och den
   *   funktionen finns inte och ska inte komma tillbaka i den formen: den
   *   fyrade N vänner × M pauser om dagen, vilket var vad som pepprade.
   *   Kretsnotisen fick finnas just för att dess tak är strukturellt.
   */
  push_token: string | null;
  notify_friend_pausing: boolean;
  tz_offset_minutes: number | null;
  /**
   * Dagsmålet i sekunder — appens enda källa till sanning för talet, med
   * eller utan krets. Låg förr på `circle_members`, vilket gjorde ett
   * personligt mål till något bara en grupp kunde ha; se
   * supabase/dailygoal.sql. Kretsen läser det härifrån.
   *
   * `null` = inget mål satt, och det är inte samma sak som noll: noll vore
   * ett mål på ingenting. Ringen på Hem skiljer på de två.
   */
  daily_target_seconds: number | null;
};

/**
 * Dagens två tal för den inloggade, oberoende av krets —
 * `get_daily_goal_progress()`.
 *
 * Dagen räknas ur de egna `pause_sessions`, inte ur `circle_pause_ledger`
 * som kretsens siffra gör. Skillnaden syns bara samma dag man går med i en
 * krets: ledgern räknar bara det som hänt medan man varit medlem.
 */
export type DailyGoalProgress = {
  today_seconds: number;
  daily_target_seconds: number | null;
};

/**
 * En natt, så som `get_sleep_nights()` och `get_night_progress()` räknar den
 * (supabase/sleep.sql). En natt hör till kvällen den började — gränsen går
 * vid lokal middag.
 */
export type SleepNight = {
  /** 'YYYY-MM-DD', kvällens datum. */
  night_of: string;
  /** Tiden telefonen låg ner, alltså utan uppvaknandena. */
  sleep_seconds: number;
  wake_count: number;
  awake_seconds: number;
  /** ISO — första gången telefonen lades ner. Null för en natt utan rad. */
  bedtime: string | null;
  /** ISO — lyftet som avslutade natten. */
  woke_at: string | null;
};

/** `get_night_progress()`: natten som gäller nu. Det finns inget nattmål —
 *  natten spåras, den mäts inte mot något (supabase/sleep.sql). */
export type NightProgress = SleepNight;

export type FriendshipStatus = 'pending' | 'accepted';

export type Friendship = {
  id: string;
  requester_id: string;
  receiver_id: string;
  status: FriendshipStatus;
  created_at: string;
};

export type PauseSession = {
  id: string;
  user_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  intention: string | null;
  is_shared: boolean;
  shared_session_id: string | null;
  invite_status: 'sent' | 'pending' | 'accepted' | 'declined' | null;
  with_pod: boolean;
  completed: boolean;
  box_id: string | null;
  box_seq: string | null;
  /** `'sleep'` för en natt (supabase/sleep.sql). Allt som räknar pauser
   *  filtrerar på `'pause'`; vänner kan inte läsa sömnrader alls. */
  kind: 'pause' | 'sleep';
  /** Bara sömnrader. */
  wake_count: number | null;
  awake_seconds: number | null;
  /** En paus taggad som natt i efterhand (supabase/sleep_tag.sql). */
  tagged_as_sleep?: boolean;
};

export type MessageType = 'voice' | 'video' | 'text';

export type PauseMessage = {
  id: string;
  sender_id: string;
  receiver_id: string;
  session_id: string | null;
  message_type: MessageType;
  content_url: string | null;
  text_content: string | null;
  delivered: boolean;
  created_at: string;
};

export type Circle = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

export type CircleMemberRole = 'owner' | 'member';

export type CircleMember = {
  id: string;
  circle_id: string;
  user_id: string;
  role: CircleMemberRole;
  joined_at: string;
  /** Dagsmålet: hur mycket paustid personen siktar på per dag. Veckans
   *  ribba är detta gånger sju. */
  daily_target_seconds: number | null;
  /** Kvar i tabellen men oanvända: den parkerade sänkningen finns inte mer. */
  pending_target_seconds: number | null;
  target_week: string | null;
};

export type CircleInviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export type CircleInvite = {
  id: string;
  circle_id: string;
  inviter_id: string;
  invitee_id: string;
  status: CircleInviteStatus;
  created_at: string;
};

/** En punkt på någons lista. Hette `circle_weekly_goals` och var varken
 *  veckovis eller mål — se supabase/wishlist.sql. Tillhör en person, inte en
 *  krets; vem som får se den avgörs av delat kretsmedlemskap vid läsning. */
export type WishlistItem = {
  id: string;
  user_id: string;
  text: string;
  /** Kvar som sorteringshjälp. Nya punkter sätter den inte. */
  position: number | null;
  done_at: string | null;
  /** Sätts när punkten aktiveras som story, inte när den skrivs. */
  tone: 'tillsagelse' | 'varme' | 'peptal' | 'annat' | null;
  story_expires_at: string | null;
  /** Inerta i v1 — utmaningsflödet är pausat. */
  private: boolean;
  open_for_challenges: boolean;
  /** Dold för kretsen (ögat med streck i att göra-arket). Inte `private`. */
  hidden_from_circle: boolean;
  created_at: string;
  updated_at: string;
};

/** En rad ur vyn `active_stories`: en punkt vars 24 timmar inte gått ut. */
export type ActiveStory = {
  id: string;
  user_id: string;
  text: string;
  tone: 'tillsagelse' | 'varme' | 'peptal' | 'annat' | null;
  story_expires_at: string;
  done_at: string | null;
  username: string;
  avatar_url: string | null;
};

/** En rad ur `circle_weekly_completions()`. */
export type CircleCompletion = {
  item_id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  item_text: string;
  done_at: string;
};

export type CircleActivityType =
  | 'member_joined'
  | 'member_left'
  | 'weekly_goal_updated'
  | 'wishlist_completed'
  | 'goal_set'
  | 'goal_adjusted'
  | 'goal_reached'
  | 'level_up'
  | 'pause_completed'
  // Veckan låstes, och belöningen som ledde med den — se supabase/circle_rewards.sql.
  | 'reward_unlocked'
  // Från första versionen av belöningen; skrivs inte längre.
  | 'reward_adopted';

export type CircleActivity = {
  id: string;
  circle_id: string;
  actor_id: string | null;
  type: CircleActivityType;
  metadata: Record<string, any>;
  created_at: string;
};

/**
 * Ett meddelande i kretsens chatt — se supabase/circle_chat.sql.
 *
 * `user_id` är nullbar av samma skäl som `CircleActivity.actor_id`: ett
 * raderat konto tar inte med sig samtalet, raden blir bara anonym.
 */
export type CircleMessage = {
  id: string;
  circle_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
};

/** En medlems rad i veckans pott, som get_circle_progress returnerar den. */
export type CircleMemberProgress = {
  user_id: string;
  /** Dagslöftet. Veckans ribba är detta gånger sju. */
  daily_target_seconds: number | null;
  /** Veckoribban, alltså daily_target_seconds * 7. */
  target_seconds: number | null;
  progress_seconds: number;
  /** Dagens paustid, räknad mot klientens egen midnatt. */
  today_seconds: number;
  met: boolean;
};

/** Hela cirkelfliken i ett anrop — se get_circle_progress i supabase/circles.sql. */
export type CircleProgress = {
  circle_id: string;
  week_start: string;
  members: CircleMemberProgress[];
  member_count: number;
  goals_set_count: number;
  met_count: number;
  /** Summan av allas mål. Potten kan vara nästan full och målet ändå
   *  olåst — målet kräver att VARJE medlem klarat sitt eget. */
  pot_target_seconds: number;
  pot_progress_seconds: number;
  goal_reached: boolean;
  achievements_count: number;
  lifetime_seconds: number;
  level: number;
  level_start_seconds: number;
  level_next_seconds: number;
  /** Dagar i veckan som räknas: 7, eller 5 för en krets som bara räknar vardagar. */
  count_days?: number;
};

/** Det ringen ritar — gemensamt för pågående period och en gången. */
export type CirclePotNumbers = Pick<
  CircleProgress,
  'members' | 'pot_target_seconds' | 'pot_progress_seconds' | 'goal_reached' | 'achievements_count'
>;

/** En medlem i en gången period — också någon som lämnat sedan dess. */
export type CirclePeriodMember = CircleMemberProgress & {
  username: string;
  avatar_url: string | null;
  /** false = har lämnat kretsen; timmarna står kvar och visas nedtonade. */
  is_member: boolean;
};

/**
 * En gången vecka eller dag — `get_circle_period` i supabase/circles.sql.
 * Samma form som `CircleProgress` där de överlappar. För en dag står dagens
 * sekunder i både `progress_seconds` och `today_seconds`.
 */
export type CirclePeriod = {
  circle_id: string;
  mode: 'week' | 'day';
  week_start: string;
  period_start: string;
  members: CirclePeriodMember[];
  member_count: number;
  goals_set_count: number;
  /** false för veckor innan målen började sparas — då visas timmarna utan ring. */
  goals_known: boolean;
  met_count: number;
  pot_target_seconds: number;
  pot_progress_seconds: number;
  goal_reached: boolean;
  /** Vunna veckor till och med den här — "WEEK N". */
  achievements_count: number;
  circle_started: string;
};
