// INLLO — Newsletter Batch Send Edge Function
// Sends an email to all active newsletter subscribers via Resend

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 500, headers: corsHeaders });
  }

  const { subject, htmlContent } = await req.json();
  if (!subject || !htmlContent) {
    return new Response(JSON.stringify({ error: "subject and htmlContent required" }), { status: 400, headers: corsHeaders });
  }

  // Resend supports up to 100 recipients per batch call
  const BATCH = 50;
  let sent = 0;
  let offset = 0;
  let errors: string[] = [];

  const unsubFooter = `
    <hr style="border:none;border-top:1px solid #e8dfd0;margin:32px 0 16px;">
    <p style="color:#9e8e7e;font-size:11px;text-align:center;line-height:1.6;">
      INLLO — Instituto Liliana Lorna<br>
      <a href="mailto:hola@inllo.com?subject=Unsubscribe&body=Please%20unsubscribe%20me" style="color:#9e8e7e;">Cancelar suscripción / Unsubscribe</a>
    </p>
  `;

  while (true) {
    const { data: subs, error } = await supabase
      .from("subscribers")
      .select("email, name")
      .eq("newsletter", true)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .range(offset, offset + BATCH - 1);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
    if (!subs || subs.length === 0) break;

    // Resend: send individually for personalization (or use batch endpoint)
    // Using Resend batch endpoint for efficiency
    const batch = subs.map((s: any) => ({
      from: "INLLO — Instituto Liliana Lorna <onboarding@resend.dev>",
      to: [s.email],
      subject,
      html: htmlContent + unsubFooter,
    }));

    const emailRes = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error("Resend batch error:", errText);
      errors.push(errText);
    }

    sent += subs.length;
    offset += BATCH;
    if (subs.length < BATCH) break;

    // Small delay to respect rate limits (Resend: 100 emails/sec on paid plan)
    await new Promise((r) => setTimeout(r, 600));
  }

  return new Response(
    JSON.stringify({ sent, errors: errors.length > 0 ? errors : undefined }),
    { status: 200, headers: corsHeaders }
  );
});
