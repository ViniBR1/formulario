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
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const DATABASE_URL = process.env.DATABASE_URL;
const FALLBACK_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;

// ============================================================
// Email (Resend)
// ============================================================
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || "mvini440@gmail.com";

// ============================================================

if (!DATABASE_URL) console.error("\n⚠️  DATABASE_URL não configurada!\n");
if (!RESEND_API_KEY) console.warn("\n⚠️  RESEND_API_KEY não configurada — email desativado.\n");

const sql = neon(DATABASE_URL || "");

// ============================================================
// Autenticação
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
// EMAIL — Envio via Resend
// ============================================================

function escapeHtmlServer(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendNotificationEmail(sessionData) {
  if (!RESEND_API_KEY) {
    console.log("📧 RESEND_API_KEY não configurada — pulando envio de email.");
    return { ok: false, error: "no_api_key" };
  }

  const {
    courseName,
    respondentName,
    respondentPhone,
    answers,
    finishedAt,
    sessionId
  } = sessionData;

  const answersHtml = answers.map((a, i) => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #eee; background: #fafafa; font-weight: 600; color: #333; width: 40%; vertical-align: top;">
        ${i + 1}. ${escapeHtmlServer(a.question)}
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid #eee; color: #111;">
        ${escapeHtmlServer(a.answer || "(vazio)")}
      </td>
    </tr>
  `).join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"></head>
    <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f4f7; margin: 0; padding: 24px;">
      <div style="max-width: 640px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
        
        <div style="background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff; padding: 24px;">
          <h1 style="margin: 0; font-size: 22px;">🎸 Nova resposta recebida</h1>
          <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">
            ${escapeHtmlServer(courseName)}
          </p>
        </div>

        <div style="padding: 24px;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 13px;">👤 Nome:</td>
              <td style="padding: 8px 0; color: #111; font-weight: 600;">
                ${escapeHtmlServer(respondentName || "Anônimo")}
              </td>
            </tr>
            ${respondentPhone ? `
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 13px;">📱 WhatsApp:</td>
              <td style="padding: 8px 0; color: #111; font-weight: 600;">
                ${escapeHtmlServer(respondentPhone)}
              </td>
            </tr>` : ''}
            <tr>
              <td style="padding: 8px 0; color: #666; font-size: 13px;">🕐 Data:</td>
              <td style="padding: 8px 0; color: #111;">
                ${escapeHtmlServer(finishedAt)}
              </td>
            </tr>
          </table>

          <h2 style="font-size: 16px; color: #6366f1; margin: 24px 0 12px;">
            Respostas
          </h2>

          <table style="width: 100%; border-collapse: collapse; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">
            ${answersHtml}
          </table>

          <p style="margin-top: 24px; font-size: 12px; color: #999; text-align: center;">
            Sessão: ${escapeHtmlServer(sessionId)}
          </p>
        </div>

      </div>
    </body>
    </html>
  `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Notificações <onboarding@resend.dev>",
        to: [NOTIFICATION_EMAIL],
        subject: `🎸 Nova resposta: ${courseName} — ${respondentName || "Anônimo"}`,
        html: html
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Erro ao enviar email:", data);
      return { ok: false, error: data };
    }

    console.log("✅ Email enviado:", data.id);
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("❌ Erro ao chamar Resend:", e.message);
    return { ok: false, error: e.message };
  }
}

// ============================================================
// ROTAS PÚBLICAS
// ============================================================

app.get("/api/courses", async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, slug, name, icon, description, image, checkout_url, order_index
      FROM courses
      ORDER BY order_index ASC, id ASC
    `;
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/questions", async (req, res) => {
  try {
    const product = req.query.product;
    let rows;
    if (product) {
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

// Salvar resposta + enviar email se for a última
app.post("/api/responses", async (req, res) => {
  try {
    const {
      question_id, answer, session_id,
      respondent_name, respondent_phone,
      is_last_question
    } = req.body;

    let product = req.body.product;
    if (!product && typeof session_id === "string") {
      const parts = session_id.split("_");
      if (parts[0]) product = parts[0];
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

    if (is_last_question) {
      const allAnswers = await sql`
        SELECT r.answer, q.text AS question_text, q.order_index
        FROM responses r
        LEFT JOIN questions q ON q.id = r.question_id
        WHERE r.session_id = ${session_id}
        ORDER BY q.order_index ASC, r.id ASC
      `;

      let courseName = product;
      try {
        const courseRows = await sql`
          SELECT name FROM courses WHERE slug = ${product} LIMIT 1
        `;
        if (courseRows.length) courseName = courseRows[0].name;
      } catch (_) {}

      sendNotificationEmail({
        courseName,
        respondentName: respondent_name || "Anônimo",
        respondentPhone: respondent_phone || "",
        answers: allAnswers.map(a => ({
          question: a.question_text || "(pergunta removida)",
          answer: a.answer
        })),
        finishedAt: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        sessionId: session_id
      }).catch(err => console.error("Erro ao enviar email:", err));
    }

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
// ROTAS DO ADMIN — CURSOS
// ============================================================

app.post("/api/admin/courses", requireAuth, async (req, res) => {
  try {
    const { slug, name, icon, description, image, checkout_url, order_index } = req.body;
    if (!slug || !name) return res.status(400).json({ error: "Slug e nome são obrigatórios" });

    const rows = await sql`
      INSERT INTO courses (slug, name, icon, description, image, checkout_url, order_index)
      VALUES (${slug}, ${name}, ${icon || "📚"}, ${description || null},
              ${image || null}, ${checkout_url || null}, ${order_index || 0})
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/courses/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { slug, name, icon, description, image, checkout_url, order_index } = req.body;
    const rows = await sql`
      UPDATE courses
      SET slug = ${slug}, name = ${name}, icon = ${icon || "📚"},
          description = ${description || null}, image = ${image || null},
          checkout_url = ${checkout_url || null}, order_index = ${order_index || 0}
      WHERE id = ${id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/courses/:id", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM courses WHERE id = ${req.params.id}`;
    res.json({ ok: true });
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
        let product = row.product;
        if (!product && typeof row.session_id === "string") {
          const parts = row.session_id.split("_");
          if (parts[0]) product = parts[0];
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
      VALUES (${text}, ${type || 'text'},
              ${options ? JSON.stringify(options) : null}::jsonb,
              ${video_url || null}, ${order_index || 0}, ${product || 'both'})
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
    console.error("Erro em /api/admin/settings:", e);
    res.status(500).json({ error: e.message });
  }
});

// Rota de teste do email
app.post("/api/admin/test-email", requireAuth, async (req, res) => {
  try {
    const result = await sendNotificationEmail({
      courseName: "TESTE",
      respondentName: "Teste do Admin",
      respondentPhone: "(00) 00000-0000",
      answers: [
        { question: "Pergunta de teste 1", answer: "Resposta 1" },
        { question: "Pergunta de teste 2", answer: "Resposta 2" }
      ],
      finishedAt: new Date().toLocaleString("pt-BR"),
      sessionId: "test_session_" + Date.now()
    });
    res.json(result);
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
    console.log(`📧 Email:      ${RESEND_API_KEY ? "✅ configurado" : "⚠️ sem API key"}`);
    console.log(`🔓 Senha fixa: admin123\n`);
  });
}
