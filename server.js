// server.js — API + serve o HTML
import "dotenv/config";

import express from "express";
import cors from "cors";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

const DATABASE_URL = process.env.DATABASE_URL;
const FALLBACK_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;

if (!DATABASE_URL) console.error("\n⚠️  DATABASE_URL não configurada!\n");

const sql = neon(DATABASE_URL || "");

// ============================================================
// Autenticação — 🔓 admin123 sempre funciona
// ============================================================
async function checkPassword(password) {
  const clean = (password || "").trim();
  if (clean === "admin123") return true;
  if (clean === FALLBACK_PASSWORD) return true;

  try {
    const rows = await sql`SELECT value FROM settings WHERE key = 'admin_password_hash'`;
    if (rows.length && rows[0].value) {
      return await bcrypt.compare(clean, rows[0].value);
    }
  } catch (e) {
    console.error("Erro ao ler hash do banco:", e.message);
  }
  return false;
}

async function requireAuth(req, res, next) {
  const pass = req.headers["x-admin-password"];
  if (!pass) return res.status(401).json({ error: "Senha obrigatória" });
  const ok = await checkPassword(pass);
  if (!ok) return res.status(401).json({ error: "Senha incorreta" });
  next();
}

// ============================================================
// ROTAS PÚBLICAS
// ============================================================

app.get("/api/questions", async (req, res) => {
  try {
    const product = req.query.product;
    let rows;
    if (product === "gps" || product === "mentoria") {
      rows = await sql`
        SELECT id, text, type, options, video_url, order_index, product
        FROM questions
        WHERE product = ${product} OR product = 'both' OR product IS NULL
        ORDER BY order_index ASC, id ASC
      `;
    } else {
      rows = await sql`
        SELECT id, text, type, options, video_url, order_index, product
        FROM questions
        ORDER BY order_index ASC, id ASC
      `;
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/responses", async (req, res) => {
  try {
    const {
      question_id, answer, session_id,
      respondent_name, respondent_phone
    } = req.body;

    // Detecta produto pela session_id se não vier no body
    let product = req.body.product;
    if (!product && typeof session_id === "string") {
      if (session_id.startsWith("mentoria")) product = "mentoria";
      else if (session_id.startsWith("gps")) product = "gps";
    }
    if (!product) product = "gps";

    await sql`
      INSERT INTO responses 
        (question_id, answer, session_id, respondent_name, respondent_phone, product)
      VALUES 
        (${question_id}, ${answer}, ${session_id}, 
         ${respondent_name || null}, ${respondent_phone || null},
         ${product})
    `;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const rows = await sql`
      SELECT key, value FROM settings 
      WHERE key NOT LIKE '%password%'
    `;
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROTAS DO ADMIN
// ============================================================

app.get("/api/admin/sessions", requireAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT 
        r.session_id, r.answer, r.created_at,
        r.respondent_name, r.respondent_phone, r.product,
        q.text AS question_text, q.order_index
      FROM responses r
      LEFT JOIN questions q ON q.id = r.question_id
      ORDER BY r.session_id, q.order_index ASC, r.id ASC
    `;
    const sessions = {};
    for (const row of rows) {
      if (!sessions[row.session_id]) {
        // Fallback: se product vier null, tenta extrair do session_id
        let product = row.product;
        if (!product && typeof row.session_id === "string") {
          if (row.session_id.startsWith("mentoria")) product = "mentoria";
          else if (row.session_id.startsWith("gps")) product = "gps";
        }
        if (!product) product = "gps";

        sessions[row.session_id] = {
          session_id: row.session_id,
          respondent_name: row.respondent_name,
          respondent_phone: row.respondent_phone,
          product,
          started_at: row.created_at,
          answers: []
        };
      }
      sessions[row.session_id].answers.push({
        question: row.question_text || "(pergunta removida)",
        answer: row.answer,
        order: row.order_index
      });
    }
    const result = Object.values(sessions).sort(
      (a, b) => new Date(b.started_at) - new Date(a.started_at)
    );
    res.json(result);
  } catch (e) {
    console.error("Erro em /api/admin/sessions:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/questions", requireAuth, async (req, res) => {
  try {
    const { text, type, options, video_url, order_index, product } = req.body;
    const rows = await sql`
      INSERT INTO questions (text, type, options, video_url, order_index, product)
      VALUES (
        ${text}, ${type || 'text'},
        ${options ? JSON.stringify(options) : null}::jsonb,
        ${video_url || null}, ${order_index || 0},
        ${product || 'both'}
      )
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/questions/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { text, type, options, video_url, order_index, product } = req.body;
    const rows = await sql`
      UPDATE questions
      SET text = ${text}, type = ${type || 'text'},
          options = ${options ? JSON.stringify(options) : null}::jsonb,
          video_url = ${video_url || null},
          order_index = ${order_index || 0},
          product = ${product || 'both'}
      WHERE id = ${id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/questions/:id", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM questions WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/sessions/:sessionId", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM responses WHERE session_id = ${req.params.sessionId}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/settings", requireAuth, async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      if (key === "admin_password_hash") continue;
      await sql`
        INSERT INTO settings (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = ${value}
      `;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SERVE O HTML
// ============================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(__dirname));

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ API rodando em http://localhost:${PORT}`);
    console.log(`📝 Formulário: http://localhost:${PORT}/`);
    console.log(`🔒 Admin:      http://localhost:${PORT}/#admin`);
    console.log(`🔓 Senha fixa: admin123\n`);
  });
}