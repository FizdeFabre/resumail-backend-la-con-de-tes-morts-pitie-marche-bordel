import express from "express";
import OpenAI from "openai";

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // ⚠️ ta clé doit être dans .env
});

// Petit utilitaire pour découper en batchs
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ----------- ROUTE /analyze -------------
router.post("/analyze", async (req, res) => {
  try {
    const { user, emails } = req.body;
    if (!user || !emails || !emails.length)
      return res.status(400).json({ error: "Missing user or emails" });

    const text = emails
      .map((e, i) => `Email ${i + 1} (de: ${e.from}, sujet: ${e.subject}): ${e.snippet}`)
      .join("\n\n");

    const prompt = `
      Tu es un assistant d'analyse d'emails. Analyse le lot ci-dessous :
      1. Nombre total d'emails
      2. Pourcentage positifs / négatifs / neutres
      3. Points récurrents
      4. Résumé global (5 phrases max)
      
      Emails :
      ${text}
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: prompt }],
      max_tokens: 800,
    });

    const analysis = completion.choices[0].message.content;

    res.json({ user, totalEmails: emails.length, analysis });
  } catch (err) {
    console.error("/analyze error:", err);
    res.status(500).json({ error: "IA analysis failed" });
  }
});

export default router;