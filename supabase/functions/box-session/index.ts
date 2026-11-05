// box-session: lådan skickar en färdig paus som den själv startat (NFC-taggen
// + locket), via WiFi. Pauser som appen startat går fortfarande via Bluetooth
// och appens outbox — lådan skickar aldrig samma paus båda vägarna.
//
// POST { "tag_uid": "9B3C31CA", "seq": 12, "duration_ms": 1847000,
//        "completed": true, "ended_ago_ms": 0 }
// Header: x-box-id, x-box-key (samma som box-tag)
//
// Svar: { status: "saved" | "duplicate" | "unknown_tag" | "invalid" }
//   "duplicate" är ett lyckat svar: pausen fanns redan, lådan kan ta bort den
//   ur sin kö. Lådan tar bort posten vid alla fyra; vid 5xx eller nätfel
//   ligger den kvar och skickas om.
//
// Själva skrivningen sker i record_box_session() (supabase/box_sessions_nfc.sql).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const boxId = req.headers.get("x-box-id") ?? "";
  const boxKey = req.headers.get("x-box-key") ?? "";
  if (!boxId || !boxKey) return json({ error: "missing_box_credentials" }, 401);

  const { data: box, error: boxError } = await admin
    .from("boxes")
    .select("id, key_hash, active")
    .eq("id", boxId)
    .maybeSingle();
  if (boxError) {
    console.error("box-session: kunde inte läsa boxes", boxError);
    return json({ error: "db_error" }, 500);
  }
  if (!box || !box.active || box.key_hash !== (await sha256Hex(boxKey))) {
    console.warn(`box-session: nekad låda ${boxId}`);
    return json({ error: "invalid_box" }, 401);
  }
  await admin.from("boxes").update({ last_seen_at: new Date().toISOString() }).eq("id", boxId);

  let body: {
    tag_uid?: string;
    seq?: number;
    duration_ms?: number;
    completed?: boolean;
    ended_ago_ms?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const tagUid = (body.tag_uid ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
  const seq = Number(body.seq);
  const durationMs = Number(body.duration_ms);
  if (tagUid.length < 8 || tagUid.length > 20 || !Number.isInteger(seq) || seq <= 0 ||
      !Number.isFinite(durationMs) || durationMs <= 0) {
    return json({ status: "invalid" });
  }

  const { data, error } = await admin.rpc("record_box_session", {
    p_box_id: boxId,
    p_tag_uid: tagUid,
    p_seq: seq,
    p_duration_ms: Math.round(durationMs),
    p_completed: body.completed === true,
    p_ended_ago_ms: Math.max(0, Math.round(Number(body.ended_ago_ms) || 0)),
  });
  if (error) {
    console.error("box-session: record_box_session", error);
    return json({ error: "db_error" }, 500);
  }

  console.log(`box-session: ${boxId} seq ${seq} → ${data?.status}`);
  return json({ status: data?.status ?? "invalid" });
});
