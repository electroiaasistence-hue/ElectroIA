const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'electroia-dev-secret-change-me');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || OPENAI_MODEL;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (process.env.NODE_ENV === 'production' && !JWT_SECRET) {
  throw new Error('JWT_SECRET es obligatorio en producción.');
}

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 12 * 1024 * 1024 }
});

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 1 }) : null;
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000 }) : null;

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(__dirname));

const SYSTEM = `Sos ElectroIA, un asistente especializado en electricidad para España y Argentina.
Tu objetivo es ayudar de forma clara, práctica y segura.
Tenés dos modos:
- Hogar: lenguaje sencillo, diagnóstico guiado y seguridad primero.
- Profesional: lenguaje técnico, cálculos, diagnóstico, fotovoltaica, normativa y proyectos.
Nunca inventes una norma. Si no tenés certeza de una exigencia normativa, decilo.
No reemplazás a un electricista habilitado ni un proyecto profesional.
Ante humo, fuego, chispas, olor fuerte a quemado, conductores expuestos o riesgo de electrocución, priorizá detener la manipulación, mantener distancia y pedir asistencia; solo cortar la alimentación si puede hacerse de forma segura.
Cuando el usuario no sabe qué preguntar, hacé preguntas concretas de a una para diagnosticar.
No repitas preguntas que ya estén respondidas en el contexto recibido.
Separá hechos observados, hipótesis, comprobaciones y datos faltantes cuando sea útil.`;

function safeJson(value, max = 12000) {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length > max ? text.slice(0, max) + '…' : text;
  } catch (_) { return '{}'; }
}

function requireAI(res) {
  if (!client) {
    res.status(503).json({ error: 'IA no configurada. Falta OPENAI_API_KEY.' });
    return false;
  }
  return true;
}

function signUser(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

function authRequired(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'INVALID_SESSION' });
  }
}

async function initDB() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects(user_id);
  `);
}

function cleanTemp(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

app.get('/api/health', async (req, res) => {
  let database = 'not_configured';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'ok'; }
    catch (_) { database = 'error'; }
  }
  res.setHeader('Cache-Control','no-store');
  res.json({ ok: true, version: 'v17.0.25', ai: !!client, model: OPENAI_MODEL, database, node: process.version });
});

app.post('/api/chat', async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const {
      message = '', mode = 'hogar', history = [], context_bundle = {}, diagnostic_context = {},
      ai_contract = 'electroia-v14', local_first = true,
      request_source = 'page_chat', urgency = false,
      safety_level = 'normal', escalated_from_local = false
    } = req.body || {};
    if (!String(message).trim()) return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
    const context = safeJson(context_bundle);
    const recentHistory = Array.isArray(history) ? history.slice(-12) : [];
    const input = [
      ...recentHistory.map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || x.message || '') })),
      { role: 'user', content: `Modo: ${mode}. Origen: ${request_source}. Urgencia: ${urgency}. Seguridad: ${safety_level}. Escalado desde lógica local: ${escalated_from_local}. Local-first: ${local_first}. Contrato: ${ai_contract}.\nContexto ya recopilado (no repitas preguntas ya respondidas): ${context}\n\nMensaje actual: ${message}` }
    ];
    const response = await client.responses.create({ model: OPENAI_MODEL, instructions: SYSTEM, input });
    res.setHeader('Cache-Control','no-store');
    res.json({ answer: response.output_text, model: OPENAI_MODEL, source: 'ai' });
  } catch (e) {
    console.error('CHAT_ERROR', { name:e?.name, message:e?.message, code:e?.code, status:e?.status, request_id:e?.request_id });
    res.setHeader('Cache-Control','no-store');
    res.status(e?.status === 429 ? 503 : 502).json({ error: 'Error conectando con la IA.', retryable: true, request_id: e?.request_id || null });
  }
});

app.post('/api/vision', upload.single('image'), async (req, res) => {
  let temp = req.file;
  try {
    if (!requireAI(res)) { cleanTemp(temp); return; }
    const mode = req.body?.mode || 'hogar';
    const context = req.body?.context_bundle || '{}';
    let imageUrl = null;
    let mime = 'image/jpeg';
    if (req.file) {
      mime = req.file.mimetype || mime;
      imageUrl = `data:${mime};base64,${fs.readFileSync(req.file.path).toString('base64')}`;
    } else if (req.body?.image_url) {
      imageUrl = req.body.image_url;
    }
    if (!imageUrl) return res.status(400).json({ error: 'IMAGE_REQUIRED' });
    const response = await client.responses.create({
      model: OPENAI_VISION_MODEL,
      instructions: SYSTEM + `\nAnalizá la imagen con cuidado. Describí solo lo que realmente puedas observar. Identificá componentes, etiquetas, conexiones visibles y señales de riesgo. Si algo no se puede determinar por la foto, pedí otra imagen o información. No asumas conexiones ocultas.`,
      input: [{ role: 'user', content: [
        { type: 'input_text', text: `Modo ${mode}. Contexto previo: ${safeJson(context, 8000)}\nAnalizá esta instalación o componente eléctrico.` },
        { type: 'input_image', image_url: imageUrl }
      ] }]
    });
    res.json({ answer: response.output_text, model: OPENAI_VISION_MODEL, source: 'vision' });
  } catch (e) {
    console.error('VISION_ERROR', e);
    res.status(500).json({ error: 'No se pudo analizar la imagen.' });
  } finally { cleanTemp(temp); }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const temp = req.file;
  try {
    if (!requireAI(res)) { cleanTemp(temp); return; }
    if (!temp) return res.status(400).json({ error: 'AUDIO_REQUIRED' });
    const tr = await client.audio.transcriptions.create({
      model: OPENAI_TRANSCRIBE_MODEL,
      file: fs.createReadStream(temp.path),
      language: req.body?.language || 'es'
    });
    res.json({ text: tr.text, model: OPENAI_TRANSCRIBE_MODEL, source: 'transcription' });
  } catch (e) {
    console.error('TRANSCRIBE_ERROR', e);
    res.status(500).json({ error: 'No se pudo transcribir el audio.' });
  } finally { cleanTemp(temp); }
});

app.post('/api/tts', async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (text.length > 5000) return res.status(413).json({ error: 'TEXT_TOO_LONG' });
    const speech = await client.audio.speech.create({
      model: OPENAI_TTS_MODEL,
      voice: req.body?.voice || TTS_VOICE,
      input: text,
      response_format: 'mp3'
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    const buffer = Buffer.from(await speech.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    console.error('TTS_ERROR', e);
    res.status(500).json({ error: 'No se pudo generar la voz.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'INVALID_EMAIL' });
    if (password.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.rowCount) return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query('INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,$3,$4) RETURNING id,email,name,created_at', [id,email,hash,name]);
    const user = r.rows[0];
    res.status(201).json({ user, token: signUser(user) });
  } catch (e) { console.error('REGISTER_ERROR', e); res.status(500).json({ error: 'REGISTER_FAILED' }); }
});

app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const r = await pool.query('SELECT id,email,password_hash,name,created_at FROM users WHERE email=$1', [email]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    const user = { id:r.rows[0].id, email:r.rows[0].email, name:r.rows[0].name, created_at:r.rows[0].created_at };
    res.json({ user, token: signUser(user) });
  } catch (e) { console.error('LOGIN_ERROR', e); res.status(500).json({ error: 'LOGIN_FAILED' }); }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const r = await pool.query('SELECT id,email,name,created_at FROM users WHERE id=$1', [req.user.sub]);
    if (!r.rowCount) return res.status(401).json({ error: 'USER_NOT_FOUND' });
    res.json({ user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'AUTH_LOOKUP_FAILED' }); }
});

app.get('/api/projects', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const r = await pool.query('SELECT id,data,created_at,updated_at FROM projects WHERE user_id=$1 ORDER BY updated_at DESC', [req.user.sub]);
    res.json({ projects: r.rows.map(x => ({ ...(x.data || {}), id:x.id, createdAt:x.created_at, updatedAt:x.updated_at })) });
  } catch (e) { console.error('PROJECT_LIST_ERROR', e); res.status(500).json({ error: 'PROJECT_LIST_FAILED' }); }
});

app.post('/api/projects', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const id = crypto.randomUUID();
    const data = { ...(req.body || {}) }; delete data.id;
    const r = await pool.query('INSERT INTO projects(id,user_id,data) VALUES($1,$2,$3) RETURNING id,data,created_at,updated_at', [id,req.user.sub,JSON.stringify(data)]);
    res.status(201).json({ project: { ...(r.rows[0].data || {}), id:r.rows[0].id, createdAt:r.rows[0].created_at, updatedAt:r.rows[0].updated_at } });
  } catch (e) { console.error('PROJECT_CREATE_ERROR', e); res.status(500).json({ error: 'PROJECT_CREATE_FAILED' }); }
});

app.put('/api/projects/:id', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const data = { ...(req.body || {}) }; delete data.id;
    const r = await pool.query('UPDATE projects SET data=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING id,data,created_at,updated_at', [JSON.stringify(data),req.params.id,req.user.sub]);
    if (!r.rowCount) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    res.json({ project: { ...(r.rows[0].data || {}), id:r.rows[0].id, createdAt:r.rows[0].created_at, updatedAt:r.rows[0].updated_at } });
  } catch (e) { console.error('PROJECT_UPDATE_ERROR', e); res.status(500).json({ error: 'PROJECT_UPDATE_FAILED' }); }
});

app.delete('/api/projects/:id', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_NOT_CONFIGURED' });
  try {
    const r = await pool.query('DELETE FROM projects WHERE id=$1 AND user_id=$2', [req.params.id,req.user.sub]);
    if (!r.rowCount) return res.status(404).json({ error: 'PROJECT_NOT_FOUND' });
    res.json({ ok:true });
  } catch (e) { console.error('PROJECT_DELETE_ERROR', e); res.status(500).json({ error: 'PROJECT_DELETE_FAILED' }); }
});

app.use((err, req, res, next) => {
  console.error('UNHANDLED_ERROR', err);
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TOO_LARGE' });
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
});

(async()=>{
  try {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => console.log(`ElectroIA V15 escuchando en ${PORT}`));
  } catch (e) {
    console.error('STARTUP_ERROR', e);
    process.exit(1);
  }
})();
