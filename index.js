// server/index.js
/**
 * Resumail backend (clean, single-file)
 *
 * Required env vars:
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *  - OPENAI_API_KEY
 *  - STRIPE_SECRET_KEY
 *  - STRIPE_WEBHOOK_SECRET
 *
 * Optional (if you want the server to update user credits in Supabase):
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import Stripe from "stripe";
import bodyParser from "body-parser";
import { supabase } from "./supabaseClient.js";
import reportsRouter from "./routes/reports.js";

dotenv.config();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OPENAI_API_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
 SERVER_ROOT_URL="https://resumail-backend.onrender.com",
FRONTEND_URL="https://resumail.vercel.app",
  PORT = 3000,
  TOKENS_FILE = "tokens.json",
  BATCH_SIZE = "10",
} = process.env;

// sanity checks
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}
if (!STRIPE_SECRET_KEY) {
  console.warn("STRIPE_SECRET_KEY not set. Billing endpoints will fail if used.");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("STRIPE_WEBHOOK_SECRET not set. Webhook signature validation disabled (not recommended).");
}

const app = express();
// allow large JSON bodies (emails can be sizable)

app.use(cors());
app.use("/reports", reportsRouter); 

// 🔧 augmenter la limite du body parser
app.use(express.json({ limit: "10mb" }));   // JSON jusqu’à 10 Mo
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
});

// Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Google OAuth client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${SERVER_ROOT_URL}/auth/callback`
);

// --- tokens file (stores Gmail tokens keyed by gmail address) ---
const tokensPath = path.resolve(process.cwd(), TOKENS_FILE);
if (!fs.existsSync(tokensPath)) fs.writeFileSync(tokensPath, JSON.stringify({}), "utf8");
function readTokensFile() {
  try {
    return JSON.parse(fs.readFileSync(tokensPath, "utf8") || "{}");
  } catch (e) {
    return {};
  }
}
function writeTokensFile(obj) {
  fs.writeFileSync(tokensPath, JSON.stringify(obj, null, 2), "utf8");
}

// --- helpers ---
function getOAuth2Url() {
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ];
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });
}

async function getUserEmailFromTokens(tokens) {
  const client = new google.auth.OAuth2();
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const res = await oauth2.userinfo.get();
  return res.data.email;
}

function decodeBase64UrlToString(b64url) {
  if (!b64url) return "";
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function extractPlainTextFromPayload(payload) {
  if (!payload) return "";
  let text = "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    text += decodeBase64UrlToString(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    text += decodeBase64UrlToString(payload.body.data);
  } else if (payload.parts && payload.parts.length) {
    for (const p of payload.parts) {
      text += extractPlainTextFromPayload(p);
    }
  }
  return text;
}

function parseHeaders(headers = [], name) {
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : null;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// --- routes ---
// health
app.get("/", (req, res) => {
  res.send("🚀 Resumail backend is running. Use /auth/google to login.");
});

// Stripe checkout session creation
// body: { userId: "<supabase-user-id-or-your-id>", credits: <number>, price: <cents> (optional) }
// frontend should call this and redirect to returned url

// --- (near top) ensure credits file exists
const creditsPath = path.resolve(process.cwd(), "credits.json");
if (!fs.existsSync(creditsPath)) fs.writeFileSync(creditsPath, JSON.stringify({}), "utf8");

function readCreditsFile() {
  try {
    return JSON.parse(fs.readFileSync(creditsPath, "utf8") || "{}");
  } catch (e) {
    return {};
  }
}

function writeCreditsFile(obj) {
  fs.writeFileSync(creditsPath, JSON.stringify(obj, null, 2), "utf8");
}

// GET current credits for user
app.get("/credits", async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "Missing userId param" });

  if (!supabase) {
    console.error("Supabase client not configured for /credits");
    return res.status(500).json({ error: "Supabase not configured" });
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("credits")
      .eq("id", userId)
      .limit(1);

    if (error) {
      // don't auto-create profile in case of supabase error — surface the error
      console.error("/credits supabase select error:", error);
      return res.status(500).json({ error: "Failed to fetch profile", detail: error.message });
    }

    if (!data || data.length === 0) {
      // if the user truly does not exist, create with sensible default (10) — but only if no error
      const { data: newProfile, error: insertErr } = await supabase
        .from("profiles")
        .insert({ id: userId, credits: 10 })
        .select()
        .limit(1);

      if (insertErr) {
        console.error("Failed to create profile in /credits:", insertErr);
        return res.status(500).json({ error: "Failed to create profile", detail: insertErr.message });
      }

      return res.json({ credits: newProfile[0].credits });
    }

    // success
    return res.json({ credits: data[0].credits });
  } catch (err) {
    console.error("/credits unexpected error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// POST consume credits { user, amount }
app.post("/consume", async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || typeof amount !== "number") {
    return res.status(400).json({ error: "Missing params" });
  }
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });

  const { data: profile, error: selErr } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", userId)
    .single();

  if (selErr || !profile) {
    return res.status(404).json({ error: "User not found" });
  }

  if (profile.credits < amount) {
    return res.status(402).json({ error: "Insufficient credits" });
  }

  const { data, error: updErr } = await supabase
    .from("profiles")
    .update({ credits: profile.credits - amount })
    .eq("id", userId)
    .select("credits")
    .single();

  if (updErr) {
    console.error("Supabase /consume update error:", updErr);
    return res.status(500).json({ error: "Failed to update credits" });
  }

  res.json({ credits: data.credits });
});

// POST add credits (for testing or webhook use)
app.post("/credits/add", (req, res) => {
  const { user, amount } = req.body;
  if (!user || typeof amount !== "number") return res.status(400).json({ error: "Missing params" });
  const store = readCreditsFile();
  store[user] = (Number(store[user] || 0) + amount);
  writeCreditsFile(store);
  return res.json({ credits: store[user] });
});

// Stripe envoie du raw body

app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        // 🔑 Metadata envoyée depuis le frontend
        const userId = session.metadata?.userId;
        const creditsPurchased = parseInt(session.metadata?.credits || "0", 10);

        if (!userId || !creditsPurchased) {
          throw new Error("userId ou credits manquants dans metadata Stripe");
        }

        // 1️⃣ Enregistrer le paiement dans Supabase
        const { error: payErr } = await supabase.from("payments").insert([
          {
            user_id: userId,
            stripe_session_id: session.id,
            amount: session.amount_total / 100, // montant en euros
            credits_added: creditsPurchased,
            status: "succeeded",
          },
        ]);

        if (payErr) throw payErr;

        // 2️⃣ Ajouter les crédits dans profiles
        const { data: profile, error: selErr } = await supabase
          .from("profiles")
          .select("credits")
          .eq("id", userId)
          .single();

        if (selErr || !profile) throw new Error("Utilisateur non trouvé dans profiles");

        const { error: updErr } = await supabase
          .from("profiles")
          .update({ credits: profile.credits + creditsPurchased })
          .eq("id", userId);

        if (updErr) throw updErr;

        console.log(`✅ User ${userId} : +${creditsPurchased} crédits (total ${profile.credits + creditsPurchased})`);
      } catch (err) {
        console.error("⚠️ Erreur traitement webhook:", err);
        return res.status(500).send("Erreur serveur webhook");
      }
    }

    res.json({ received: true });
  }
);

const CREDIT_PACKS = {
  100: 500,   // 100 crédits → 6,00 €
  500: 2000,  // 500 crédits → 25,00 €
  2000: 7000, // 2000 crédits → 80,00 €
};

app.use((req, res, next) => {
  console.log("📥 Reçu:", req.method, req.url, req.body);
  next();
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    let { userId, credits } = req.body;

    // sécuriser le type
    credits = parseInt(credits, 10);

    if (!userId || isNaN(credits)) {
      return res.status(400).json({ error: "userId et credits requis" });
    }

    const amount = CREDIT_PACKS[credits];
    if (!amount) {
      return res.status(400).json({ error: "Pack de crédits invalide" });
    }

    // debug log
    console.log("➡️ create-checkout-session:", { userId, credits, amount });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: `${credits} crédits Resumail`,
            },
            unit_amount: amount, // montant en CENTIMES
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "http://localhost:5173/dashboard?success=true",
      cancel_url: "http://localhost:5173/dashboard?canceled=true",
      metadata: {
        userId,
        credits,
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erreur création checkout:", err);
    res.status(500).json({
      error: "Impossible de créer la session Stripe",
      detail: err.message,
    });
  }
});

// Google OAuth bootstrap
app.get("/auth/google", (req, res) => {
  res.redirect(getOAuth2Url());
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const { tokens } = await oauth2Client.getToken(code);
    // store tokens in memory client for subsequent Gmail calls
    oauth2Client.setCredentials(tokens);

    const email = await getUserEmailFromTokens(tokens);
    if (!email) return res.status(500).send("Could not determine Gmail address");

    // persist tokens to tokens.json
    const tokensStore = readTokensFile();
    tokensStore[email] = tokens;
    writeTokensFile(tokensStore);

    // redirect to frontend filters page (so frontend picks user from URL)
    const frontUrl = `${FRONTEND_URL}/filters?user=${encodeURIComponent(email)}`;
    console.log("OAuth callback, redirect to:", frontUrl);
    res.redirect(frontUrl);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Auth callback error");
  }
});

// List messages and decode
app.get("/emails", async (req, res) => {
  try {
    const user = req.query.user;
    if (!user) return res.status(400).json({ error: "Missing user param (email)" });

    const tokens = readTokensFile()[user];
    if (!tokens) return res.status(404).json({ error: "No tokens for this user. Authenticate via /auth/google" });

    const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: client });

    const maxResults = Math.min(parseInt(req.query.maxResults || "100", 10), 500);
    const q = req.query.q || undefined;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q,
    });

    const messages = listRes.data.messages || [];
    const out = [];

    for (const m of messages) {
      try {
        const got = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const msg = got.data;
        const headers = msg.payload?.headers || [];
        const subject = parseHeaders(headers, "Subject") || "(no subject)";
        const from = parseHeaders(headers, "From") || "(unknown)";
        const date = parseHeaders(headers, "Date") || null;
        const body = extractPlainTextFromPayload(msg.payload) || msg.snippet || "";
        out.push({
          id: m.id,
          threadId: msg.threadId,
          subject,
          from,
          snippet: msg.snippet || "",
          body,
          date,
        });
      } catch (e) {
        console.warn("Failed to fetch message", m.id, e?.message);
      }
    }

    res.json({ messages: out, nextPageToken: listRes.data.nextPageToken || null });
  } catch (err) {
    console.error("/emails error:", err);
    res.status(500).json({ error: "Server error", detail: err.message || String(err) });
  }
});

// Analyze route with batching + OpenAI calls
const CREDITS_PER_EMAIL = 1;

// --- /analyze V2 :

function safeParseJson(str, fallbackTotal = 0) {
  try {
    const m = str.match(/\{[\s\S]*\}/m);
    if (!m) throw new Error("No JSON found");
    const parsed = JSON.parse(m[0]);
    if (!parsed.total_emails) parsed.total_emails = fallbackTotal;
    if (!parsed.classification) parsed.classification = { positive:0, negative:0, neutral:0, other:0 };
    if (!parsed.highlights) parsed.highlights = [];
    if (!parsed.summary) parsed.summary = "";
    return parsed;
  } catch {
    return {
      total_emails: fallbackTotal,
      
      classification: { positive:0, negative:0, neutral:0, other:0 },
      highlights: [],
      summary: str.slice(0, 1000),
    };
  }
  parsed.sentiment_overall = parsed.classification;
}

app.post("/analyzev2", async (req, res) => {
  try {
    const { userId, emails } = req.body;
    if (!userId || !Array.isArray(emails) || emails.length === 0)
      return res.status(400).json({ error: "Missing userId or emails" });
    if (!supabase)
      return res.status(500).json({ error: "Supabase not configured" });

    const BATCH_SIZE = 50;
    const MERGE_BATCH_SIZE = 5;
    const CREDITS_PER_EMAIL = Number(process.env.CREDITS_PER_EMAIL || "1");
    const neededCredits = emails.length * CREDITS_PER_EMAIL;

    // --- 1) Décrémenter crédits ---
    let newBalance = null;
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "decrement_credits",
        { p_user_id: userId, p_amount: neededCredits }
      );
      if (rpcErr) return res.status(402).json({ error: "Not enough credits" });
      newBalance =
        typeof rpcData === "number"
          ? rpcData
          : rpcData?.[0]?.credits ?? null;
    } catch {
      // fallback manuel
      const { data: profile, error: selErr } = await supabase
        .from("profiles")
        .select("credits")
        .eq("id", userId)
        .single();
      if (selErr || !profile)
        return res.status(404).json({ error: "User not found" });
      if (profile.credits < neededCredits)
        return res.status(402).json({ error: "Not enough credits" });
      const { data: updated } = await supabase
        .from("profiles")
        .update({ credits: profile.credits - neededCredits })
        .eq("id", userId)
        .select("credits")
        .single();
      newBalance = updated.credits;
    }

    // --- 2) Découpage des emails ---
    const chunkArray = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
      return out;
    };
    const batches = chunkArray(emails, BATCH_SIZE);

    const miniReportIds = [];
    const partialJsons = [];

    // --- 3) Analyse IA par batch ---
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const text = batch
        .map(
          (e, idx) =>
            `Email ${idx + 1} (from: ${e.from}, subject: ${e.subject}): ${
              e.body || ""
            }`
        )
        .join("\n\n");

      const systemPrompt = `You are an assistant that MUST output JSON only. Format:
{
  "total_emails": integer,
  "classification": {"positive": integer,"negative": integer,"neutral": integer,"other": integer},
  "highlights": ["short string", ...],
  "summary": "max 5 sentences"
}`;

      const userPrompt = `Analyze the following ${batch.length} emails:\n\n${text.slice(
        0,
        15000
      )}`;

      let aiRaw = "";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 800,
        });
        aiRaw = completion.choices?.[0]?.message?.content || "";
      } catch (err) {
        console.error("AI call failed for batch", i, err);
      }

      const parsed = safeParseJson(aiRaw, batch.length);

      // --- Sauvegarde du mini-rapport ---
      const { data: insertedMini, error: miniErr } = await supabase
        .from("reports")
        .insert([
          {
            user_id: userId,
            total_emails: parsed.total_emails,
            report_text: parsed.summary,
            summary: parsed.summary,
            classification: parsed.classification,
            highlights: parsed.highlights,
            sentiment_overall: parsed.classification,
            is_final: false,
          },
        ])
        .select("*")
        .single();

      if (!miniErr && insertedMini) {
        miniReportIds.push(insertedMini.id);
        partialJsons.push(parsed);
        console.log(`✅ Mini-rapport créé : ${insertedMini.id}`);
      } else {
        console.error("Insert mini report error:", miniErr);
      }
    }

    // --- 4) Fusion des rapports ---
    async function mergeReports(jsonList) {
      if (jsonList.length === 1) return jsonList[0];
      const groups = chunkArray(jsonList, MERGE_BATCH_SIZE);
      const merged = [];

      for (const group of groups) {
        const mergePrompt = `
You are an assistant that MUST merge multiple JSON reports into one final JSON.
Format:
{
  "total_emails": integer,
  "classification": {"positive": integer,"negative": integer,"neutral": integer,"other": integer},
  "highlights": [{"text": "string","count": integer,"pct": "xx%"}, ...],
  "summary": "max 8 sentences"
}`;
        const mergeInput = group
          .map((p, i) => `REPORT ${i + 1}:\n${JSON.stringify(p)}`)
          .join("\n\n");

        try {
          const merge = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: mergePrompt },
              { role: "user", content: mergeInput },
            ],
            temperature: 0.2,
            max_tokens: 1000,
          });
          const mergedJson = safeParseJson(
            merge.choices?.[0]?.message?.content || "",
            0
          );
          merged.push(mergedJson);
        } catch (err) {
          console.error("Merge failed:", err);
          merged.push(group[0]);
        }
      }

      if (merged.length > 1) return mergeReports(merged);
      return merged[0];
    }

    const finalJson = await mergeReports(partialJsons);

    // --- 5) Sauvegarde du rapport final ---
    const { data: insertedFinal, error: finalErr } = await supabase
      .from("reports")
      .insert([
        {
          user_id: userId,
          total_emails: finalJson.total_emails,
          report_text: finalJson.summary,
          summary: finalJson.summary,
          classification: finalJson.classification,
          highlights: finalJson.highlights,
          sentiment_overall: finalJson.classification,
          mini_report_ids: miniReportIds, // JSON array propre
          is_final: true,
        },
      ])
      .select("*")
      .single();

    if (finalErr) {
      console.error("❌ Insert final report error:", finalErr);
      return res.status(500).json({ error: "Failed to save final report" });
    }

    console.log(`🏁 Rapport final créé : ${insertedFinal.id}`);

    const { data: profileAfter } = await supabase
      .from("profiles")
      .select("credits")
      .eq("id", userId)
      .single();

    return res.json({
      ok: true,
      userId,
      creditsLeft: profileAfter?.credits ?? newBalance,
      totalEmails: emails.length,
      mini_report_ids: miniReportIds,
      finalReportId: insertedFinal.id,
      finalReport: finalJson,
    });
  } catch (err) {
    console.error("/analyzev2 error:", err);
    return res.status(500).json({ error: "IA analysis failed", detail: err.message });
  }
});

// Optional: delete stored tokens for a user (logout)
app.delete("/tokens", (req, res) => { 
  try {
    const user = req.query.user;
    if (!user) return res.status(400).json({ error: "Missing user param" });
    const tokensStore = readTokensFile();
    if (tokensStore[user]) {
      delete tokensStore[user];
      writeTokensFile(tokensStore);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /tokens error:", err);
    return res.status(500).json({ error: "Failed to delete tokens" });
  }
});

// ✅ Route pour récupérer les rapports d'un utilisateur

app.get('/reports', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // 🔹 On sélectionne explicitement toutes les colonnes utiles
    const { data, error } = await supabase
      .from('reports')
      .select(`
        id,
        user_id,
        created_at,
        total_emails,
        sentiment_overall,
        classification,
        is_final,
        highlights,
        report_text,
        summary,
        mini_report_ids
      `)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('/reports error', error);
      return res.status(500).json({ error: error.message });
    }

    // ✅ Normalisation complète
    const normalized = (data || []).map((r) => ({
      id: r.id,
      report_text: r.report_text || '',
      sentiment_overall: r.sentiment_overall || r.classification || {},
      total_emails: r.total_emails || 0,
      created_at: r.created_at,
      is_final: r.is_final || false,
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
      summary: r.summary || '',
      mini_report_ids: Array.isArray(r.mini_report_ids) ? r.mini_report_ids : [],
    }));

    res.json(normalized);
  } catch (err) {
    console.error('/reports route error', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// Route stats
app.get('/stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const { data: reports, error } = await supabase
      .from('reports')
      .select('id, report_text, report_text, sentiment_overall, classification, total_emails, created_at, is_final')
      .eq('user_id', userId)
      .eq('is_final', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!reports || !reports.length) {
      return res.json({ total_emails: 0, avg: { positive:0, neutral:0, negative:0, other:0 }, last_summary: "" });
    }

    const totalEmails = reports.reduce((sum, r) => sum + (r.total_emails || 0), 0);

    const avg = { positive:0, neutral:0, negative:0, other:0 };
    reports.forEach((r) => {
      const s = r.sentiment_overall ?? r.classification ?? {};
      avg.positive += Number(s.positive || 0);
      avg.neutral += Number(s.neutral || 0);
      avg.negative += Number(s.negative || 0);
      avg.other += Number(s.other || 0);
    });

    const count = reports.length;
    Object.keys(avg).forEach(k => { avg[k] = Math.round(avg[k] / count); });

    const last_summary = (reports[0]?.reports_text ?? reports[0]?.report_text) || "";

    res.json({ total_emails: totalEmails, avg, last_summary });
  } catch (err) {
    console.error('/stats/:userId error', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

app.listen(PORT, () => console.log(`🚀 Resumail backend running on port ${PORT}`));

// contact@hozana.org, newsletter@mag.genealogie.com, emails@hamza-ahmed.co.uk, hello@chess.com, News@insideapple.apple.com, mj@thefastlaneforum.com