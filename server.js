// server.js — API + serve o HTML
import "dotenv/config";

import express from "express";
import cors from "cors";
import { neon } from "@neondatabase/serverless";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// ✅ Lê a connection string das variáveis de ambiente
// (arquivo .env local ou painel do Vercel em produção)
// ============================================================
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;

if (!DATABASE_URL) {
  console.error("\n⚠️  DATABASE_URL não configurada!");
  console.error("   Local: crie um arquivo .env com DATABASE_URL=...");
  console.error("   Vercel: configure em Settings → Environment Variables\n");
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ===== ROTAS PÚBLICAS =====

app.get("/api/questions", async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, text, type, options, video_url, order_index
      FROM questions
      ORDER BY order_index ASC, id ASC
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/responses", async (req, res) => {
  try {
    const {
      question_id,
      answer,
      session_id,
      respondent_name,
      respondent_phone
    } = req.body;

    await sql`
      INSERT INTO responses 
        (question_id, answer, session_id, respondent_name, respondent_phone)
      VALUES 
        (${question_id}, ${answer}, ${session_id}, 
         ${respondent_name || null}, ${respondent_phone || null})
    `;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ROTAS DO ADMIN =====

function checkAuth(req, res, next) {
  const pass = req.headers["x-admin-password"];
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha incorreta" });
  }
  next();
}

app.get("/api/admin/sessions", checkAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT 
        r.session_id,
        r.answer,
        r.created_at,
        r.respondent_name,
        r.respondent_phone,
        q.text AS question_text,
        q.order_index
      FROM responses r
      LEFT JOIN questions q ON q.id = r.question_id
      ORDER BY r.session_id, q.order_index ASC, r.id ASC
    `;

    const sessions = {};
    for (const row of rows) {
      if (!sessions[row.session_id]) {
        sessions[row.session_id] = {
          session_id: row.session_id,
          respondent_name: row.respondent_name,
          respondent_phone: row.respondent_phone,
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
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/responses", checkAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT r.id, r.answer, r.session_id, r.created_at,
             r.respondent_name, r.respondent_phone,
             q.text AS question_text
      FROM responses r
      LEFT JOIN questions q ON q.id = r.question_id
      ORDER BY r.created_at DESC
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/questions", checkAuth, async (req, res) => {
  try {
    const { text, type, options, video_url, order_index } = req.body;
    const rows = await sql`
      INSERT INTO questions (text, type, options, video_url, order_index)
      VALUES (
        ${text},
        ${type || 'text'},
        ${options ? JSON.stringify(options) : null}::jsonb,
        ${video_url},
        ${order_index || 0}
      )
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/questions/:id", checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await sql`DELETE FROM questions WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/responses/:id", checkAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await sql`DELETE FROM responses WHERE id = ${id}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/sessions/:sessionId", checkAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    await sql`DELETE FROM responses WHERE session_id = ${sessionId}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SERVE O HTML =====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ API rodando em http://localhost:${PORT}`);
    console.log(`📝 Formulário: http://localhost:${PORT}/index.html`);
    console.log(`🔒 Admin:      http://localhost:${PORT}/index.html#admin\n`);
  });
}