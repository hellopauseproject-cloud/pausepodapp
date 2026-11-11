// claim-tag: anropas av appen när en inloggad användare har skannat
// QR-koden på boxen. Funktionen kontrollerar själv inloggningen
// (admin.auth.getUser), så den driftsätts utan gatewayns JWT-kontroll
// (--no-verify-jwt), som notify-circle-goal-reached.
//
// supabase.functions.invoke("claim-tag", { body: { code, preview } })
//
//   preview: true  -> kollar bara koden, kopplar inget (för "Är det här din telefon?")
//   preview: false -> kopplar taggen till den inloggade användaren
//
// Svar:
//   { ok: true, status: "valid", box_name }           (preview)
//   { ok: true, status: "claimed" }                   taggen är nu din
//   { ok: true, status: "already_yours" }             taggen var redan din
//   { ok: false, error: "code_not_found" | "code_expired" | "code_used"
//                     | "tag_taken" | "not_signed_in" }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // ---- Vem är inloggad? ----
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "not_signed_in" }, 401);
  const { data: userData } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return json({ ok: false, error: "not_signed_in" }, 401);

  let body: { code?: string; preview?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const code = (body.code ?? "").toUpperCase().trim();
  if (!code) return json({ ok: false, error: "code_not_found" }, 400);

  // ---- Kolla koden ----
  const { data: pairing } = await admin
    .from("tag_pairing_codes")
    .select("code, box_id, tag_uid, expires_at, claimed_at, claimed_by, boxes(name)")
    .eq("code", code)
    .maybeSingle();

  if (!pairing) return json({ ok: false, error: "code_not_found" }, 404);
  if (pairing.claimed_at) {
    if (pairing.claimed_by === user.id) return json({ ok: true, status: "already_yours" });
    return json({ ok: false, error: "code_used" }, 409);
  }
  if (new Date(pairing.expires_at) < new Date()) {
    return json({ ok: false, error: "code_expired" }, 410);
  }

  // ---- Är taggen redan någons? ----
  const { data: existingTag } = await admin
    .from("pause_tags")
    .select("user_id")
    .eq("tag_uid", pairing.tag_uid)
    .is("deactivated_at", null)
    .maybeSingle();
  if (existingTag && existingTag.user_id !== user.id) {
    return json({ ok: false, error: "tag_taken" }, 409);
  }

  // deno-lint-ignore no-explicit-any
  const boxName = (pairing as any).boxes?.name ?? "PausePod";
  if (body.preview) return json({ ok: true, status: "valid", box_name: boxName });

  // ---- Lås koden först, så att två telefoner inte kan ta samma kod ----
  const { data: locked } = await admin
    .from("tag_pairing_codes")
    .update({ claimed_at: new Date().toISOString(), claimed_by: user.id })
    .eq("code", code)
    .is("claimed_at", null)
    .select("code")
    .maybeSingle();
  if (!locked) return json({ ok: false, error: "code_used" }, 409);

  if (existingTag) return json({ ok: true, status: "already_yours" });

  const { error: insertError } = await admin
    .from("pause_tags")
    .insert({ tag_uid: pairing.tag_uid, user_id: user.id });
  if (insertError) {
    // Släpp koden igen om något gick fel
    await admin.from("tag_pairing_codes").update({ claimed_at: null, claimed_by: null }).eq("code", code);
    const taken = insertError.code === "23505";
    return json({ ok: false, error: taken ? "tag_taken" : "db_error" }, taken ? 409 : 500);
  }

  return json({ ok: true, status: "claimed" });
});
