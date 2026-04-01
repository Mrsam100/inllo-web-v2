// INLLO — CSV Export Edge Function
// Exports all subscribers as CSV in paginated batches (handles 1M+ rows)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function escCsv(val: string): string {
  return '"' + String(val || "").replace(/"/g, '""') + '"';
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Verify auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  // Build CSV in batches to handle 1M+ rows without memory overflow
  const BATCH = 5000;
  const BOM = "\uFEFF";
  const header = '"Nombre","Email","Idioma","Newsletter","Estado","Fecha"\n';
  const parts: string[] = [BOM, header];
  let offset = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from("subscribers")
      .select("name, email, lang, newsletter, status, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + BATCH - 1);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
    if (!rows || rows.length === 0) break;

    for (const s of rows) {
      const date = s.created_at ? s.created_at.split("T")[0] : "";
      parts.push(
        `${escCsv(s.name)},${escCsv(s.email)},${escCsv((s.lang || "").toUpperCase())},${escCsv(s.newsletter ? "Sí" : "No")},${escCsv(s.status === "active" ? "Activa" : "Baja")},${escCsv(date)}\n`
      );
    }

    offset += BATCH;
    if (rows.length < BATCH) break;
  }

  return new Response(parts.join(""), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=inllo-suscriptoras-${new Date().toISOString().split("T")[0]}.csv`,
    },
  });
});
