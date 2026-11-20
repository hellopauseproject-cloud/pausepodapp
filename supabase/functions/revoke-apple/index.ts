// Tar bort kopplingen mellan ett Apple-ID och PausePod när kontot raderas.
// Apple kräver det (guideline 5.1.1(v)): den som raderar sitt konto ska inte
// stå kvar under Inställningar → Sign in with Apple. Anropas av
// `deleteAccount` i contexts/AuthContext.tsx, före raderingen. Deployas med:
//
//   npx supabase functions deploy revoke-apple
//
// JWT-kontrollen står på: anroparen är en inloggad användare.
//
// Hemligheterna (Edge Functions → Secrets i Supabase):
//   APPLE_TEAM_ID      lagets id, FP3247F8DV
//   APPLE_KEY_ID       nyckelns id (Keys i Apples utvecklarportal)
//   APPLE_CLIENT_ID    iOS bundle-id:t, com.pauseprojectmaja.Pauseapp
//   APPLE_PRIVATE_KEY  hela .p8-filen, med BEGIN/END-raderna
//
// Flödet är Apples eget: appen ber Apple om en färsk engångskod
// (authorization code, giltig i fem minuter), den här funktionen byter koden
// mot en refresh token och återkallar den. Nyckeln lämnar aldrig servern.
//
// Den talar inte med databasen. Koden är bunden till den som loggade in i
// Apples ark, så det finns inget id att kontrollera här.

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Apples client secret är en JWT signerad med ES256. WebCrypto ger
 * signaturen som r‖s (64 byte), vilket är exakt det JWS vill ha — ingen
 * DER-omkodning behövs.
 */
async function appleClientSecret(teamId: string, keyId: string, clientId: string, pem: string) {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')),
    c => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({
    iss: teamId, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: clientId,
  }));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const teamId = Deno.env.get('APPLE_TEAM_ID');
  const keyId = Deno.env.get('APPLE_KEY_ID');
  const clientId = Deno.env.get('APPLE_CLIENT_ID');
  const privateKey = Deno.env.get('APPLE_PRIVATE_KEY');
  if (!teamId || !keyId || !clientId || !privateKey) {
    console.error('revoke-apple: hemligheterna saknas');
    return json({ error: 'not_configured' }, 500);
  }

  let code = '';
  try {
    code = String((await req.json())?.authorization_code ?? '');
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!code) return json({ error: 'missing_code' }, 400);

  let clientSecret: string;
  try {
    clientSecret = await appleClientSecret(teamId, keyId, clientId, privateKey);
  } catch (e) {
    console.error('revoke-apple: nyckeln gick inte att läsa', e);
    return json({ error: 'bad_key' }, 500);
  }

  const tokenRes = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  const token: string | undefined = tokens.refresh_token ?? tokens.access_token;
  if (!tokenRes.ok || !token) {
    // Felkoden räcker för att felsöka; tokens loggas aldrig.
    console.error('revoke-apple: kodbytet nekades', tokenRes.status, tokens.error);
    return json({ error: 'token_exchange_failed' }, 502);
  }

  const revokeRes = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
      token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
    }),
  });
  if (!revokeRes.ok) {
    console.error('revoke-apple: återkallelsen nekades', revokeRes.status);
    return json({ error: 'revoke_failed' }, 502);
  }

  return json({ revoked: true });
});
