/**
 * Another Me - Personal AI WhatsApp Auto-Reply & Web Dashboard
 * Titik masuk utama: merangkai komponen modular, server Express yang aman,
 * layanan Baileys WhatsApp, dan pemantau antrean !ask.
 */

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const LLMClient = require('./src/llmClient');
const ContextManager = require('./src/contextManager');
const KnowledgeManager = require('./src/knowledgeManager');
const ToolRegistry = require('./src/tools/toolRegistry');
const SettingsStore = require('./src/settingsStore');
const BaileysService = require('./src/whatsapp/baileysService');
const { AskQueueMonitor } = require('./src/whatsapp/commandRouter');
const { createApiRouter } = require('./src/routes/apiRoutes');
const { cleanupOrphanedUploads } = require('./src/utils/atomicFile');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');

function buildAllowedOrigins(port) {
  const defaults = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'https://another-me.kiraya.my.id'
  ];
  const extras = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...defaults, ...extras]);
}

function safeTokenEquals(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf-8');
  const b = Buffer.from(String(expected || ''), 'utf-8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Middleware autentikasi token opsional yang aman di belakang Cloudflare Tunnel.
 * Lalu lintas dari cloudflared masuk lewat 127.0.0.1 tetapi membawa header proksi/Cloudflare
 * (cf-connecting-ip / cf-ray / x-forwarded-for / cf-access-jwt-assertion) sehingga tidak
 * pernah dianggap sebagai loopback lokal murni (SEC-01).
 */
function createDashboardAuthMiddleware() {
  return (req, res, next) => {
    const requiredToken = (process.env.DASHBOARD_API_TOKEN || '').trim();
    if (!requiredToken) return next();

    const remoteAddr = req.ip || req.socket?.remoteAddress || '';
    const isLoopback =
      remoteAddr === '127.0.0.1' ||
      remoteAddr === '::1' ||
      remoteAddr === '::ffff:127.0.0.1';
    const hasProxyForwardHeaders = Boolean(
      req.headers['cf-connecting-ip'] ||
        req.headers['cf-ray'] ||
        req.headers['cf-access-jwt-assertion'] ||
        req.headers['x-forwarded-for']
    );

    if (isLoopback && !hasProxyForwardHeaders && process.env.ALLOW_LOCAL_NO_AUTH !== 'false') {
      return next();
    }

    const authHeader = String(req.headers.authorization || '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const headerToken = String(req.headers['x-dashboard-token'] || '').trim();
    if (safeTokenEquals(bearerToken, requiredToken) || safeTokenEquals(headerToken, requiredToken)) {
      return next();
    }

    return res.status(401).json({ success: false, error: 'Autentikasi API diperlukan.' });
  };
}

/**
 * Middleware anti-CSRF untuk seluruh endpoint mutasi (/api POST/PUT/PATCH/DELETE).
 * Menolak permintaan lintas situs dari peramban (termasuk simple POST & multipart/form-data)
 * meskipun dikirim otomatis dengan kuki Cloudflare Access (SEC-02).
 */
function createCsrfProtectionMiddleware(allowedOrigins) {
  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return (req, res, next) => {
    if (!mutatingMethods.has(req.method)) return next();

    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (secFetchSite === 'cross-site') {
      return res.status(403).json({ success: false, error: 'Permintaan lintas situs ditolak (proteksi CSRF).' });
    }

    const origin = req.headers.origin ? String(req.headers.origin).trim() : '';
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ success: false, error: 'Origin permintaan tidak diizinkan (proteksi CSRF).' });
    }

    return next();
  };
}

function createServerApp(deps = {}) {
  const activityLogs = deps.activityLogs || [];
  const addLog =
    deps.addLog ||
    function addLogEntry(type, text, meta = null) {
      const logItem = {
        id: Date.now() + Math.random().toString(36).substring(2, 5),
        time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
        type,
        text,
        meta
      };
      activityLogs.unshift(logItem);
      if (activityLogs.length > 100) activityLogs.pop();
    };

  const llm = deps.llm || new LLMClient();
  const contextManager = deps.contextManager || new ContextManager();
  const knowledgeManager = deps.knowledgeManager || new KnowledgeManager();
  const toolRegistry = deps.toolRegistry || new ToolRegistry({ knowledgeManager });
  const settingsStore = deps.settingsStore || new SettingsStore();
  llm.setToolRegistry(toolRegistry);

  const askQueueMonitor =
    deps.askQueueMonitor ||
    new AskQueueMonitor({
      queueDir: path.resolve(__dirname, 'data/ask-queue'),
      addLog
    });

  const baileysService =
    deps.baileysService ||
    new BaileysService({
      llm,
      contextManager,
      knowledgeManager,
      toolRegistry,
      settingsStore,
      addLog
    });

  const app = express();
  const allowedOrigins = buildAllowedOrigins(deps.port || PORT);
  const dashboardAuth = createDashboardAuthMiddleware();
  const csrfProtection = createCsrfProtectionMiddleware(allowedOrigins);

  // Header keamanan dasar & Content Security Policy (CSP)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });

  // CORS ketat: hanya origin yang diizinkan (request tanpa Origin seperti curl/cron tetap lolos)
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      }
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use('/stickers', dashboardAuth, express.static(toolRegistry.stickersDir));

  app.use(
    '/api',
    csrfProtection,
    dashboardAuth,
    createApiRouter({
      llm,
      contextManager,
      knowledgeManager,
      toolRegistry,
      settingsStore,
      baileysService,
      askQueueMonitor,
      activityLogs,
      addLog,
      uploadsDir: deps.uploadsDir || UPLOADS_DIR
    })
  );

  return {
    app,
    llm,
    contextManager,
    knowledgeManager,
    toolRegistry,
    settingsStore,
    baileysService,
    askQueueMonitor,
    activityLogs,
    addLog
  };
}

if (require.main === module) {
  cleanupOrphanedUploads(UPLOADS_DIR);
  const ctx = createServerApp({ port: PORT });

  const server = ctx.app.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`🤖 Another Me - WhatsApp Auto-Reply Service`);
    console.log(`🌐 Dashboard UI : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`🧠 Provider LLM : ${ctx.llm.model} (${ctx.llm.baseUrl})`);
    console.log(`====================================================`);
    ctx.askQueueMonitor.start();
    ctx.baileysService.start();
  });

  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] Menerima sinyal ${signal}, menutup layanan dengan rapi...`);
    ctx.askQueueMonitor.stop();
    ctx.baileysService.shutdown();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('[UnhandledRejection]:', msg);
    ctx.addLog('error', `Unhandled Rejection: ${msg}`);
  });

  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]:', err.stack || err.message);
    ctx.addLog('error', `Uncaught Exception: ${err.message}`);
  });
}

module.exports = { createServerApp, buildAllowedOrigins };
