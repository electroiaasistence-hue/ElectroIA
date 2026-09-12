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
app.use((req,res,next)=>{const id=crypto.randomUUID();res.setHeader('X-Request-Id',id);req.requestId=id;next();});
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
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(__dirname));

// --- Rate limiting en memoria (sin dependencias externas) ---
// Objetivo: los endpoints de IA cuestan dinero real (OpenAI) y no tienen login
// obligatorio (el modo Hogar debe poder usarse sin cuenta). Sin este límite,
// cualquiera que descubra la URL puede generar consumo ilimitado.
// Nota: es una protección básica por IP en un solo proceso; si se escala a
// múltiples instancias conviene mover esto a un store compartido (p.ej. Redis).
const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs, label) {
  return (req, res, next) => {
    const key = label + ':' + (req.ip || req.connection?.remoteAddress || 'unknown');
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((bucket.start + windowMs - now) / 1000));
      return res.status(429).json({ error: 'DEMASIADAS_SOLICITUDES', retryable: true });
    }
    next();
  };
}
// Limpieza periódica para no acumular memoria indefinidamente.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 30 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

const aiRateLimit = rateLimit(20, 10 * 60 * 1000, 'ai');       // 20 solicitudes de IA / 10 min por IP
const authRateLimit = rateLimit(10, 15 * 60 * 1000, 'auth');   // 10 intentos de auth / 15 min por IP

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
Separá hechos observados, hipótesis, comprobaciones y datos faltantes cuando sea útil.
Base técnica prioritaria para España: REBT/ITC-BT y sus guías técnicas oficiales; para autoconsumo fotovoltaico, priorizá guías IDAE y tramitación oficial. No cites artículos o límites numéricos si no están confirmados.
Áreas domésticas a contemplar: cortes generales y de zona, disparos de diferencial/automáticos, sobrecarga, fugas, enchufes/regletas, iluminación, humedad/agua, calentamiento/olor/chispas, problemas de suministro/contador, consumo/potencia y preparación de información para un técnico. En fotovoltaica/profesional: strings, tensión/corriente, caída de tensión, protecciones DC/AC, baterías, MPPT, inversor, autoconsumo y documentación/tramitación. Esta lista orienta la cobertura; no sustituye la fuente oficial vigente.

Prioridad documental cuando el caso sea de España:
1) BOE / REBT (Real Decreto 842/2002) para el marco reglamentario; comprobá siempre la redacción vigente antes de afirmar una obligación.
2) Guías Técnicas de aplicación del Ministerio de Industria para BT-18, BT-22, BT-23, BT-24, BT-25, BT-33, BT-40, BT-52 y anexos de caída de tensión, según corresponda al caso.
3) IDAE para autoconsumo, autoconsumo colectivo, comunidades y tramitación; diferenciá orientación divulgativa de requisitos administrativos concretos.
No presentes una guía, FAQ o ejemplo comercial como si fuera una obligación legal. Cuando falte un dato crítico, pedilo o indicá que debe verificarse en la documentación oficial vigente.

Fuentes oficiales de referencia: BOE REBT (https://www.boe.es/eli/es/rd/2002/08/02/842/con), Guías Técnicas REBT (https://industria.gob.es/Calidad-Industrial/seguridadindustrial/instalacionesindustriales/baja-tension/Paginas/guia-tecnica-aplicacion.aspx), IDAE Autoconsumo (https://www.idae.es/tecnologias/energias-renovables/oficina-de-autoconsumo/guias-tecnicas-sobre-autoconsumo).`;

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

  // --- Planes y facturación ---
  // plan: 'free' | 'pro'. plan_until: fecha de fin de la suscripción (NULL = sin vencimiento).
  // provider_customer_id / provider_subscription_id: ids del proveedor de pago (Stripe,
  // Mercado Pago, etc.). Se rellenan desde el webhook; ver /api/billing/webhook.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_until TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT;
  `);

  // Consumo mensual de IA, para aplicar los límites de cada plan.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, period)
    );
  `);

  // Solicitudes de contacto con un electricista (derivación desde el diagnóstico).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      nombre TEXT NOT NULL DEFAULT '',
      contacto TEXT NOT NULL DEFAULT '',
      zona TEXT NOT NULL DEFAULT '',
      resumen TEXT NOT NULL DEFAULT '',
      urgencia TEXT NOT NULL DEFAULT 'normal',
      estado TEXT NOT NULL DEFAULT 'nuevo',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS leads_created_idx ON leads(created_at DESC);
  `);
}

/* ============================================================
   PLANES
   ------------------------------------------------------------
   REGLA INNEGOCIABLE: nada relacionado con la SEGURIDAD de las
   personas se cobra ni se limita. El diagnóstico de urgencia, las
   advertencias de peligro y la indicación de cortar la corriente o
   llamar a un profesional son y deben seguir siendo gratuitas y
   accesibles sin cuenta. Los límites de abajo aplican solo a
   herramientas de productividad profesional.
   ============================================================ */
const PLANES = {
  free: { etiqueta: 'Gratis', iaMes: 40,   proyectos: 3,        pdf: false, presupuestos: false },
  pro:  { etiqueta: 'PRO',    iaMes: 1500, proyectos: Infinity, pdf: true,  presupuestos: true  }
};

function planDe(usuario) {
  if (!usuario) return 'free';
  if (usuario.plan !== 'pro') return 'free';
  if (usuario.plan_until && new Date(usuario.plan_until) < new Date()) return 'free';
  return 'pro';
}

function periodoActual() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function usuarioDe(req) {
  if (!pool || !req.user?.sub) return null;
  const r = await pool.query('SELECT id,email,name,plan,plan_until FROM users WHERE id=$1', [req.user.sub]);
  return r.rows[0] || null;
}

// Lee el usuario si viene con sesión, sin exigirla (el modo Hogar funciona sin cuenta).
function authOpcional(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (_) { /* sesión inválida: sigue como anónimo */ }
  }
  next();
}

// Cuota mensual de IA. Los anónimos quedan cubiertos por el rate limit por IP.
async function cuotaIA(req, res, next) {
  if (!pool || !req.user?.sub) return next();
  try {
    const u = await usuarioDe(req);
    const limite = PLANES[planDe(u)].iaMes;
    const period = periodoActual();
    const r = await pool.query('SELECT used FROM ai_usage WHERE user_id=$1 AND period=$2', [req.user.sub, period]);
    const usado = r.rows[0]?.used || 0;
    if (usado >= limite) {
      return res.status(402).json({
        error: 'LIMITE_IA_ALCANZADO',
        plan: planDe(u),
        usado,
        limite,
        mensaje: 'Alcanzaste el límite de consultas de IA de este mes. El diagnóstico guiado y las advertencias de seguridad siguen disponibles sin límite.'
      });
    }
    await pool.query(
      `INSERT INTO ai_usage(user_id,period,used) VALUES($1,$2,1)
       ON CONFLICT (user_id,period) DO UPDATE SET used = ai_usage.used + 1`,
      [req.user.sub, period]
    );
  } catch (e) {
    console.warn('cuotaIA', e.message); // ante un fallo de contabilidad, no se bloquea al usuario
  }
  next();
}

// Exige plan PRO para una función concreta.
function requierePro(funcion) {
  return async (req, res, next) => {
    if (!pool) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    try {
      const u = await usuarioDe(req);
      if (PLANES[planDe(u)][funcion]) return next();
      return res.status(402).json({ error: 'REQUIERE_PRO', funcion, mensaje: 'Esta herramienta es parte del plan PRO.' });
    } catch (_) {
      return res.status(500).json({ error: 'PLAN_CHECK_FAILED' });
    }
  };
}

function cleanTemp(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

function aiFailure(res, label, error) {
  const status = Number(error?.status || 0);
  const code = status === 429 ? 503 : 502;
  console.error(label, { request_id: res.req?.requestId, openai_request_id: error?.request_id, name: error?.name, message: error?.message, code: error?.code, status });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(code).json({ error: 'Error conectando con la IA.', retryable: true, request_id: error?.request_id || null });
}

function bodyImageData(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(raw)) return null;
  return raw;
}


app.get('/api/health', async (req, res) => {
  let database = 'not_configured';
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'ok'; }
    catch (_) { database = 'error'; }
  }
  res.setHeader('Cache-Control','no-store');
  res.json({ ok: true, version: 'v17.0.28', ai: !!client, model: OPENAI_MODEL, database, node: process.version });
});

app.post('/api/chat', aiRateLimit, authOpcional, cuotaIA, async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const {
      message = '', mode = 'hogar', history = [], context_bundle = {}, diagnostic_context = {},
      ai_contract = 'electroia-v14', local_first = true,
      request_source = 'page_chat', urgency = false,
      safety_level = 'normal', escalated_from_local = false
    } = req.body || {};
    if (!String(message).trim()) return res.status(400).json({ error: 'MESSAGE_REQUIRED' });
    const context = safeJson(Object.keys(context_bundle || {}).length ? context_bundle : diagnostic_context);
    const recentHistory = Array.isArray(history) ? history.slice(-12).map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || x.message || '').slice(0, 1800) })) : [];
    const input = [
      ...recentHistory,
      { role: 'user', content: `Modo: ${mode}. Origen: ${request_source}. Urgencia: ${urgency}. Seguridad: ${safety_level}. Escalado desde lógica local: ${escalated_from_local}. Local-first: ${local_first}. Contrato: ${ai_contract}.\nContexto ya recopilado (no repitas preguntas ya respondidas): ${context}\n\nMensaje actual: ${message}` }
    ];
    const response = await client.responses.create({ model: OPENAI_MODEL, instructions: SYSTEM, input });
    res.setHeader('Cache-Control','no-store');
    res.json({ answer: response.output_text, model: OPENAI_MODEL, source: 'ai' });
  } catch (e) {
    console.error('CHAT_ERROR', { request_id:req.requestId, openai_request_id:e?.request_id, name:e?.name, message:e?.message, code:e?.code, status:e?.status });
    res.setHeader('Cache-Control','no-store');
    res.status(e?.status === 429 ? 503 : 502).json({ error: 'Error conectando con la IA.', retryable: true, request_id: e?.request_id || null });
  }
});

app.post('/api/vision', aiRateLimit, authOpcional, cuotaIA, upload.single('image'), async (req, res) => {
  let temp = req.file;
  try {
    if (!requireAI(res)) { cleanTemp(temp); return; }
    const mode = req.body?.mode || 'hogar';
    const context = req.body?.context_bundle || '{}';
    let imageUrl = null;
    let mime = 'image/jpeg';
    if (req.file) {
      if (!String(req.file.mimetype || '').startsWith('image/')) return res.status(415).json({ error: 'IMAGE_TYPE_NOT_SUPPORTED' });
      mime = req.file.mimetype || mime;
      imageUrl = `data:${mime};base64,${fs.readFileSync(req.file.path).toString('base64')}`;
    } else if (bodyImageData(req.body?.image)) {
      // The frontend frequently sends a compressed data URL as JSON. Accept it as a first-class input.
      imageUrl = bodyImageData(req.body.image);
    } else if (req.body?.image_url) {
      imageUrl = String(req.body.image_url).trim();
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
    aiFailure(res, 'VISION_ERROR', e);
  } finally { cleanTemp(temp); }
});

app.post('/api/transcribe', aiRateLimit, authOpcional, cuotaIA, upload.single('audio'), async (req, res) => {
  const temp = req.file;
  try {
    if (!requireAI(res)) { cleanTemp(temp); return; }
    if (!temp) return res.status(400).json({ error: 'AUDIO_REQUIRED' });
    if (!String(temp.mimetype || '').startsWith('audio/') && !String(temp.mimetype || '').startsWith('video/webm')) {
      cleanTemp(temp);
      return res.status(415).json({ error: 'AUDIO_TYPE_NOT_SUPPORTED' });
    }
    const tr = await client.audio.transcriptions.create({
      model: OPENAI_TRANSCRIBE_MODEL,
      file: fs.createReadStream(temp.path),
      language: req.body?.language || 'es'
    });
    res.json({ text: tr.text, model: OPENAI_TRANSCRIBE_MODEL, source: 'transcription' });
  } catch (e) {
    aiFailure(res, 'TRANSCRIBE_ERROR', e);
  } finally { cleanTemp(temp); }
});

app.post('/api/tts', aiRateLimit, authOpcional, cuotaIA, async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'TEXT_REQUIRED' });
    if (text.length > 4096) return res.status(413).json({ error: 'TEXT_TOO_LONG' });
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
    aiFailure(res, 'TTS_ERROR', e);
  }
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
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

app.post('/api/auth/login', authRateLimit, async (req, res) => {
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

/* ============================================================
   PLANES Y FACTURACIÓN
   ============================================================ */

// Estado del plan del usuario y consumo del mes.
app.get('/api/plan', authRequired, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  try {
    const u = await usuarioDe(req);
    if (!u) return res.status(404).json({ error: 'NOT_FOUND' });
    const plan = planDe(u);
    const r = await pool.query('SELECT used FROM ai_usage WHERE user_id=$1 AND period=$2', [u.id, periodoActual()]);
    const limites = PLANES[plan];
    const proyectos = await pool.query('SELECT COUNT(*)::int AS n FROM projects WHERE user_id=$1', [u.id]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      plan,
      etiqueta: limites.etiqueta,
      vence: u.plan_until || null,
      ia: { usado: r.rows[0]?.used || 0, limite: limites.iaMes },
      proyectos: { usado: proyectos.rows[0].n, limite: limites.proyectos === Infinity ? null : limites.proyectos },
      funciones: { pdf: limites.pdf, presupuestos: limites.presupuestos }
    });
  } catch (e) {
    console.error('plan', e.message);
    res.status(500).json({ error: 'PLAN_FAILED' });
  }
});

// Precio público del plan PRO. Se define por entorno para poder ajustarlo por
// país o campaña sin tocar el código ni el frontend.
app.get('/api/plan/precio', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    etiqueta: process.env.PRO_PRECIO_ETIQUETA || 'Consultar',
    moneda: process.env.PRO_MONEDA || '',
    importe: process.env.PRO_IMPORTE ? Number(process.env.PRO_IMPORTE) : null
  });
});

// Inicio del pago.
// PENDIENTE DE INTEGRACIÓN: hace falta una cuenta del proveedor y sus claves.
// Para Stripe: crear una Checkout Session con el price id y devolver session.url.
// Para Mercado Pago: crear una preferencia y devolver init_point.
// Configurar PAYMENT_PROVIDER, PAYMENT_API_KEY y PAYMENT_PRICE_ID en el entorno.
app.post('/api/billing/checkout', authRequired, async (req, res) => {
  if (!process.env.PAYMENT_API_KEY) {
    return res.status(503).json({
      error: 'PAGOS_NO_CONFIGURADOS',
      mensaje: 'Todavía no hay una pasarela de pago conectada.'
    });
  }
  // Aquí va la llamada al proveedor. Se deja sin implementar a propósito:
  // inventar la integración sin las claves reales generaría un flujo de cobro roto.
  return res.status(501).json({ error: 'NO_IMPLEMENTADO', mensaje: 'Falta conectar el proveedor de pago.' });
});

// Webhook del proveedor: es el único lugar que debe activar el plan PRO.
// IMPORTANTE: verificar la firma del webhook antes de confiar en el cuerpo,
// o cualquiera podría regalarse el plan PRO con una petición falsa.
app.post('/api/billing/webhook', async (req, res) => {
  if (!process.env.PAYMENT_WEBHOOK_SECRET) return res.status(503).json({ error: 'WEBHOOK_NO_CONFIGURADO' });
  return res.status(501).json({ error: 'NO_IMPLEMENTADO' });
});

// Alta/baja manual del plan, para pruebas y para altas gestionadas a mano
// (por ejemplo, una licencia vendida a una distribuidora o a un instalador).
// Protegido por ADMIN_TOKEN: sin esa variable, el endpoint no existe.
app.post('/api/admin/plan', async (req, res) => {
  const token = req.get('x-admin-token') || '';
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  if (!pool) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  const { email, plan, meses } = req.body || {};
  if (!email || !['free', 'pro'].includes(plan)) return res.status(400).json({ error: 'DATOS_INVALIDOS' });
  try {
    const hasta = plan === 'pro'
      ? new Date(Date.now() + (Number(meses) > 0 ? Number(meses) : 1) * 30 * 24 * 3600 * 1000)
      : null;
    const r = await pool.query(
      'UPDATE users SET plan=$1, plan_until=$2, updated_at=NOW() WHERE email=$3 RETURNING id,email,plan,plan_until',
      [plan, hasta, String(email).toLowerCase().trim()]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'USUARIO_NO_ENCONTRADO' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('admin/plan', e.message);
    res.status(500).json({ error: 'FALLO' });
  }
});

/* ============================================================
   DERIVACIÓN A ELECTRICISTAS
   ------------------------------------------------------------
   El usuario de Hogar pide que lo contacte un profesional. Se guarda
   la solicitud; el reparto a los electricistas se hace aparte.
   Este endpoint NO sustituye ninguna advertencia de seguridad: el
   diagnóstico ya le dijo qué hacer antes de llegar acá.
   ============================================================ */
app.post('/api/leads', rateLimit(5, 60 * 60 * 1000, 'leads'), authOpcional, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  const { nombre, contacto, zona, resumen, urgencia } = req.body || {};
  if (!String(contacto || '').trim()) return res.status(400).json({ error: 'CONTACTO_REQUERIDO' });
  try {
    const id = crypto.randomUUID();
    await pool.query(
      'INSERT INTO leads(id,user_id,nombre,contacto,zona,resumen,urgencia) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        req.user?.sub || null,
        String(nombre || '').slice(0, 120),
        String(contacto).slice(0, 120),
        String(zona || '').slice(0, 160),
        String(resumen || '').slice(0, 2000),
        ['urgente', 'normal'].includes(urgencia) ? urgencia : 'normal'
      ]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error('leads', e.message);
    res.status(500).json({ error: 'FALLO' });
  }
});

// Listado de solicitudes (para el panel interno).
app.get('/api/leads', async (req, res) => {
  const token = req.get('x-admin-token') || '';
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  if (!pool) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  try {
    const r = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch (_) { res.status(500).json({ error: 'FALLO' }); }
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
    // Límite de proyectos del plan gratuito.
    const u = await usuarioDe(req);
    const maximo = PLANES[planDe(u)].proyectos;
    if (maximo !== Infinity) {
      const c = await pool.query('SELECT COUNT(*)::int AS n FROM projects WHERE user_id=$1', [req.user.sub]);
      if (c.rows[0].n >= maximo) {
        return res.status(402).json({
          error: 'LIMITE_PROYECTOS',
          limite: maximo,
          mensaje: `El plan gratuito permite ${maximo} proyectos. Con PRO son ilimitados.`
        });
      }
    }
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
    app.listen(PORT, '0.0.0.0', () => console.log(`ElectroIA V17.0.28 escuchando en ${PORT}`));
  } catch (e) {
    console.error('STARTUP_ERROR', e);
    process.exit(1);
  }
})();
