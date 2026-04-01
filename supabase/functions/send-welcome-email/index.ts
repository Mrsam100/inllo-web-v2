// INLLO — Welcome Email Edge Function
// Triggered via database webhook on new subscriber insert
// Sends a branded welcome email with PDF download link via Resend

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async (req) => {
  try {
    // Verify webhook secret to prevent unauthorized calls
    const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") || "";
    if (WEBHOOK_SECRET) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader || authHeader !== `Bearer ${WEBHOOK_SECRET}`) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
    }

    const { record } = await req.json();
    if (!record || !record.email) {
      return new Response(JSON.stringify({ error: "No record" }), { status: 400 });
    }

    // Get PDF URL from config (language-specific)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const pdfKey = record.lang === "en" ? "pdf_url_en" : "pdf_url_es";
    const { data: cfg } = await supabase
      .from("config")
      .select("value")
      .eq("key", pdfKey)
      .single();
    const pdfUrl = cfg?.value || "";

    const isEn = record.lang === "en";
    const escHtml = (s: string) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const firstName = escHtml(record.name.split(" ")[0]);
    const safePdfUrl = escHtml(pdfUrl);

    if (!RESEND_API_KEY) {
      console.warn("RESEND_API_KEY not set — skipping email");
      return new Response(JSON.stringify({ skipped: true }), { status: 200 });
    }

    // Send via Resend
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "INLLO — Instituto Liliana Lorna <onboarding@resend.dev>",
        to: [record.email],
        subject: isEn
          ? `${firstName}, your free meditation guide is here!`
          : `${firstName}, tu guía gratuita de meditación está aquí!`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;">
            <h1 style="color:#b8943a;font-size:24px;font-weight:300;">INLLO</h1>
            <p style="color:#6b5d4f;font-size:12px;letter-spacing:3px;text-transform:uppercase;">Instituto Liliana Lorna</p>
            <hr style="border:none;border-top:1px solid #e8dfd0;margin:24px 0;">
            <h2 style="color:#2e2820;font-weight:300;">${isEn ? `Hi ${firstName}!` : `Hola ${firstName}!`}</h2>
            <p style="color:#6b5d4f;line-height:1.7;">
              ${isEn
                ? "Thank you for downloading our meditation guide. We hope it helps you find peace and balance in your daily life."
                : "Gracias por descargar nuestra guía de meditación. Esperamos que te ayude a encontrar paz y equilibrio en tu vida diaria."}
            </p>
            ${safePdfUrl ? `
            <p style="text-align:center;margin:32px 0;">
              <a href="${safePdfUrl}" style="display:inline-block;padding:14px 32px;background:#b8943a;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;letter-spacing:1px;">
                ${isEn ? "DOWNLOAD YOUR GUIDE" : "DESCARGAR TU GUÍA"}
              </a>
            </p>` : ""}
            <p style="color:#9e8e7e;font-size:13px;line-height:1.6;">
              ${isEn ? "With love," : "Con amor,"}
              <br><strong>Liliana Lorna</strong>
            </p>
            <hr style="border:none;border-top:1px solid #e8dfd0;margin:24px 0;">
            <p style="color:#9e8e7e;font-size:11px;text-align:center;">INLLO — Instituto Liliana Lorna</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error("Resend error:", errText);
      return new Response(JSON.stringify({ error: errText }), { status: 500 });
    }

    // Mark email as sent
    await supabase
      .from("subscribers")
      .update({ email_sent: true })
      .eq("id", record.id);

    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
