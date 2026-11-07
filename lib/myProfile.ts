/**
 * Senast kända namn och avatar för den inloggade, i minnet.
 *
 * Hem läser profilen vid varje fokus, och profilskärmen läste samma rad igen
 * från noll — namnet och fotot stod tomma i ett par sekunder varje gång den
 * öppnades. Nu visar skärmen det som redan hämtats direkt och läser om i
 * bakgrunden. Bara minnet, ingen lagring: en kallstart går alltid via Hem,
 * som fyller den.
 */

export type MyProfile = { username: string; avatar_url: string | null };

let cached: { userId: string; profile: MyProfile } | null = null;

export function getCachedMyProfile(userId: string): MyProfile | null {
  return cached?.userId === userId ? cached.profile : null;
}

export function setCachedMyProfile(userId: string, profile: MyProfile): void {
  cached = { userId, profile };
}
