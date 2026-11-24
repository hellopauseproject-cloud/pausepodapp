// Säger till granskaren att en rapport kommit in (supabase/moderation.sql,
// triggern `reports_notify`). Deployas med:
//
//   npx supabase functions deploy notify-report --no-verify-jwt
//
// Samma spärr som notify-circle-goal-reached: `x-pause-secret` mot
// `PAUSE_NOTIFY_SECRET`, eftersom anroparen är Postgres och inte har någon
// användar-JWT. Hemligheten är redan satt för projektet.
//
// Två kanaler, och båda är valfria:
//
//   * **Push** till de tokens SQL:en skickar med (kontona i
//     `notify_config.report_admin_ids`). Bara orsak och sort — innehållet
//     står i mejlet och i tabellen, inte på en låsskärm.
//   * **Mejl** via Resend, om `RESEND_API_KEY` är satt. Till `REPORT_EMAIL`
//     (förval hellopauseproject@gmail.com) från `REPORT_EMAIL_FROM`.
//
//   npx supabase secrets set RESEND_API_KEY=re_... REPORT_EMAIL_FROM="PausePod <reports@joinpausepod.com>"
//
// Som notify-circle-goal-reached talar den aldrig med databasen.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const RESEND_URL = 'https://api.resend.com/emails';
const DASHBOARD_URL = 'https://supabase.com/dashboard/project/iwyumzgewiwvcbuqzjnk/editor';

/** Samma etiketter som REPORT_REASONS i lib/moderation.ts. */
const REASONS: Record<string, string> = {
  sexual: 'Nudity or sexual content',
  harassment: 'Harassment or bullying',
  hate: 'Hate',
  violence: 'Threats, violence or self-harm',
  spam: 'Spam or fake account',
  other: 'Something else',
};

const KINDS: Record<string, string> = {
  message: 'circle chat message',
  support: 'support',
  photo: 'photo',
  profile: 'profile',
};

type Report = {
  id?: string;
  content_type?: string;
  content_id?: string | null;
  reason?: string;
  details?: string | null;
  snapshot?: Record<string, unknown> | null;
  reporter?: string | null;
  reported?: string | null;
  reported_user_id?: string | null;
  created_at?: string;
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendPush(tokens: string[], r: Report): Promise<unknown> {
  if (tokens.length === 0) return null;
  const messages = tokens.map(to => ({
    to,
    title: 'New report',
    body: `${REASONS[r.reason ?? ''] ?? 'Report'} · ${KINDS[r.content_type ?? ''] ?? 'content'}`,
    data: { type: 'report', report_id: r.id },
    sound: 'default',
  }));
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  return res.json();
}

async function sendEmail(r: Report): Promise<unknown> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { skipped: 'RESEND_API_KEY is not set' };
  const to = Deno.env.get('REPORT_EMAIL') ?? 'hellopauseproject@gmail.com';
  const from = Deno.env.get('REPORT_EMAIL_FROM') ?? 'PausePod <onboarding@resend.dev>';

  const rows: [string, string][] = [
    ['Reason', REASONS[r.reason ?? ''] ?? String(r.reason)],
    ['Content', KINDS[r.content_type ?? ''] ?? String(r.content_type)],
    ['Reported user', `${r.reported ?? '?'} (${r.reported_user_id ?? '?'})`],
    ['Reported by', r.reporter ?? '?'],
    ['Details', r.details ?? '—'],
    ['Content id', r.content_id ?? '—'],
    ['Report id', r.id ?? '?'],
    ['Created', r.created_at ?? '?'],
  ];
  const snapshot = r.snapshot ? JSON.stringify(r.snapshot, null, 2) : '—';
  const html =
    `<h2>New report in PausePod</h2>` +
    `<table cellpadding="6">${rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>` +
    `<p><b>What was reported</b></p><pre>${escapeHtml(snapshot)}</pre>` +
    `<p>Review it in the <a href="${DASHBOARD_URL}">reports table</a> and set <code>status</code> ` +
    `to <code>reviewed</code> or <code>actioned</code>.</p>`;

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Report: ${REASONS[r.reason ?? ''] ?? 'Report'} (${r.reported ?? 'unknown user'})`,
      html,
    }),
  });
  return res.json();
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const secret = Deno.env.get('PAUSE_NOTIFY_SECRET');
  if (!secret) return json(500, { error: 'PAUSE_NOTIFY_SECRET is not set' });
  if (req.headers.get('x-pause-secret') !== secret) return json(401, { error: 'bad secret' });

  let payload: { tokens?: unknown; report?: Report };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'invalid json' });
  }
  const report = payload.report ?? {};
  const tokens = Array.isArray(payload.tokens)
    ? [...new Set(payload.tokens.filter((t): t is string => typeof t === 'string' && !!t))]
    : [];

  // Den ena kanalen får aldrig fälla den andra.
  const [push, email] = await Promise.all([
    sendPush(tokens, report).catch(e => ({ error: String(e) })),
    sendEmail(report).catch(e => ({ error: String(e) })),
  ]);

  console.log(`notify-report: ${report.id} push=${tokens.length}`);
  return json(200, { push, email });
});
