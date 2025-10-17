// routes/stats.js
import express from "express";
import { supabase } from "../../server/supabaseClient.js";
const router = express.Router();

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: reports, error } = await supabase
      .from("reports")
      .select("id, report_text, sentiment_overall, classification, total_emails, created_at")
      .eq("user_id", userId)
      .eq("is_final", true)
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!reports || !reports.length)
      return res.json({ total_emails: 0, avg: {}, last_summary: "" });

    const totalEmails = reports.reduce((a, r) => a + (r.total_emails || 0), 0);
    const avgSentiments = { positive: 0, negative: 0, neutral: 0, other: 0 };

    reports.forEach((r) => {
      const snts = r.sentiment_overall || r.classification || {};
      Object.entries(snts).forEach(([k, v]) => {
        avgSentiments[k] += v || 0;
      });
    });

    const count = reports.length;
    Object.keys(avgSentiments).forEach((k) => {
      avgSentiments[k] = Math.round(avgSentiments[k] / count);
    });

    res.json({
      total_emails: totalEmails,
      avg: avgSentiments,
      last_summary: reports[0]?.reports_text || "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

export default router;