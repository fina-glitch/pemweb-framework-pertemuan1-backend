const express = require("express");
const router = express.Router();
const db = require("../db");
const { generateInventoryInsight } = require("../services/aiService");

async function ensureAiInsightsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_insights (
      id INT AUTO_INCREMENT PRIMARY KEY,
      source VARCHAR(64) NOT NULL,
      focus_note VARCHAR(500) DEFAULT '',
      summary TEXT NOT NULL,
      insight_json JSON NOT NULL,
      is_verified TINYINT(1) NOT NULL DEFAULT 0,
      verified_by VARCHAR(120) DEFAULT NULL,
      verified_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function parseInsightJson(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// GET /api/ai/insights
router.get("/insights", async (req, res) => {
  try {
    await ensureAiInsightsTable();
    const [rows] = await db.query(
      `SELECT id, source, focus_note, summary, insight_json, is_verified, verified_by, verified_at, created_at
       FROM ai_insights
       ORDER BY id DESC
       LIMIT 20`
    );

    const data = rows.map((r) => ({
      ...r,
      is_verified: Boolean(r.is_verified),
      insight: parseInsightJson(r.insight_json),
    }));

    res.json({ insights: data });
  } catch (err) {
    console.error("GET /api/ai/insights error:", err);
    res.status(500).json({ message: "Gagal mengambil riwayat insight AI." });
  }
});

// POST /api/ai/insights
router.post("/insights", async (req, res) => {
  try {
    await ensureAiInsightsTable();
    const focusNote =
      typeof req.body?.focus_note === "string" ? req.body.focus_note : "";

    const [products] = await db.query(
      `SELECT id, name, stock, price FROM products ORDER BY id ASC LIMIT 100`
    );

    const [orders] = await db.query(
      `SELECT id, status, total_price AS total FROM orders ORDER BY id DESC LIMIT 50`
    );

    const result = await generateInventoryInsight({
      products,
      orders,
      focusNote,
    });

    const [insertRes] = await db.query(
      `INSERT INTO ai_insights (source, focus_note, summary, insight_json, is_verified)
       VALUES (?, ?, ?, ?, 0)`,
      [
        result.source,
        focusNote.slice(0, 500),
        result.data.summary,
        JSON.stringify(result.data),
      ]
    );

    res.status(201).json({
      id: insertRes.insertId,
      source: result.source,
      is_verified: false,
      insight: result.data,
    });
  } catch (err) {
    console.error("POST /api/ai/insights error:", err);
    res
      .status(500)
      .json({ message: err.message || "Gagal membuat insight AI." });
  }
});

// PATCH /api/ai/insights/:id/verify
router.patch("/insights/:id/verify", async (req, res) => {
  try {
    await ensureAiInsightsTable();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "ID insight tidak valid." });
    }

    const verifiedBy =
      typeof req.body?.verified_by === "string" && req.body.verified_by.trim()
        ? req.body.verified_by.trim().slice(0, 120)
        : "Admin";

    await db.query(
      `UPDATE ai_insights
       SET is_verified = 1, verified_by = ?, verified_at = NOW()
       WHERE id = ?`,
      [verifiedBy, id]
    );

    res.json({ id, is_verified: true, verified_by: verifiedBy });
  } catch (err) {
    console.error("PATCH /api/ai/insights/:id/verify error:", err);
    res.status(500).json({ message: "Gagal memverifikasi insight AI." });
  }
});

module.exports = router;